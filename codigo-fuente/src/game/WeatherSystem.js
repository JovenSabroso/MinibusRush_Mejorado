import * as THREE from 'three';

const AREA = 70; // lado del cubo de lluvia alrededor de la camara
const HEIGHT = 40;
const STREAK = 0.9; // largo de cada gota (m)

/**
 * WeatherSystem
 * Lluvia con miles de gotas (LineSegments) que caen y se reciclan dentro
 * de un cubo que sigue a la camara, con viento leve. La intensidad sube y
 * baja de forma gradual. Con lluvia fuerte hay relampagos: un destello que
 * ilumina cielo y escena, y el trueno llega con retraso (luz vs. sonido).
 */
export class WeatherSystem {
  constructor(scene, rng, dropCount = 4000) {
    this.rng = rng;
    this.intensity = 0; // 0..1 (actual, suavizada)
    this.target = 0; // 0..1 (pedida por el evento)
    this.flash = 0;
    this._nextLightning = 6;
    this._pendingThunder = [];

    this.onThunder = null; // (strength 0..1) => void

    this._count = dropCount;
    const positions = new Float32Array(dropCount * 2 * 3);
    this._speeds = new Float32Array(dropCount);
    for (let i = 0; i < dropCount; i++) {
      const x = (rng() - 0.5) * AREA;
      const y = rng() * HEIGHT;
      const z = (rng() - 0.5) * AREA;
      positions.set([x, y, z, x, y + STREAK, z], i * 6);
      this._speeds[i] = 26 + rng() * 10;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._positions = geo.attributes.position;

    this.material = new THREE.LineBasicMaterial({ color: 0xbfd4ee, transparent: true, opacity: 0, depthWrite: false, fog: true });
    this.rain = new THREE.LineSegments(geo, this.material);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);
  }

  /** Fraccion de gotas a usar segun la calidad (0..1). */
  setDensity(density) {
    this._density = Math.max(0.2, Math.min(1, density));
  }

  /** Pide lluvia (true) o cielo despejado (false); el cambio es gradual. */
  setRain(active) {
    this.target = active ? 1 : 0;
    if (active) this._nextLightning = 4 + this.rng() * 6;
  }

  reset() {
    this.target = 0;
    this.intensity = 0;
    this.flash = 0;
    this._pendingThunder = [];
    this.rain.visible = false;
  }

  update(delta, camera) {
    const rate = this.target > this.intensity ? 0.35 : 0.25;
    this.intensity += Math.sign(this.target - this.intensity) * Math.min(Math.abs(this.target - this.intensity), rate * delta);

    this.rain.visible = this.intensity > 0.01;
    this.material.opacity = this.intensity * 0.42;

    if (this.rain.visible) {
      this.rain.position.set(camera.position.x, camera.position.y - HEIGHT * 0.45, camera.position.z);
      const arr = this._positions.array;
      const activeDrops = Math.floor(this._count * (0.35 + 0.65 * this.intensity) * (this._density ?? 1));
      const windX = 3.2 * delta;
      // Solo se procesan y dibujan las gotas activas (drawRange).
      this.rain.geometry.setDrawRange(0, activeDrops * 2);
      for (let i = 0; i < activeDrops; i++) {
        const o = i * 6;
        let y = arr[o + 1] - this._speeds[i] * delta;
        let x = arr[o] + windX;
        if (y < 0 || y > HEIGHT) {
          y = HEIGHT - this.rng() * 4;
          x = (this.rng() - 0.5) * AREA;
          arr[o + 2] = arr[o + 5] = (this.rng() - 0.5) * AREA;
        }
        if (x > AREA / 2) x -= AREA;
        arr[o] = x;
        arr[o + 1] = y;
        arr[o + 3] = x - 0.12; // inclinacion por el viento
        arr[o + 4] = y + STREAK;
      }
      this._positions.needsUpdate = true;
    }

    this._updateLightning(delta);
  }

  _updateLightning(delta) {
    this.flash = Math.max(0, this.flash - delta * 5);

    if (this.intensity > 0.7) {
      this._nextLightning -= delta;
      if (this._nextLightning <= 0) {
        // Destello doble, como un relampago real.
        this.flash = 1;
        setTimeout(() => {
          this.flash = Math.max(this.flash, 0.7);
        }, 120);
        const distance = 0.4 + this.rng() * 2.2; // segundos de retraso del trueno
        this._pendingThunder.push({ t: distance, strength: 1 - distance / 3 });
        this._nextLightning = 9 + this.rng() * 14;
      }
    }

    for (let i = this._pendingThunder.length - 1; i >= 0; i--) {
      const thunder = this._pendingThunder[i];
      thunder.t -= delta;
      if (thunder.t <= 0) {
        if (this.onThunder) this.onThunder(thunder.strength);
        this._pendingThunder.splice(i, 1);
      }
    }
  }
}
