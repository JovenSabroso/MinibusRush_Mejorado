import * as THREE from 'three';
import { createRadialGlowTexture } from './cityTextures.js';

/**
 * Pool fijo de particulas dibujado con un solo THREE.Points y un shader
 * propio (tamano, color y transparencia por particula). Cuando se llena,
 * la particula nueva reemplaza a la mas antigua: nunca se crean objetos
 * durante el juego, asi que no hay basura para el recolector.
 */
class ParticlePool {
  constructor(scene, { count, blending, texture }) {
    this.count = count;
    this.cursor = 0;

    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.color = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.life = new Float32Array(count); // segundos restantes
    this.maxLife = new Float32Array(count);
    this.grow = new Float32Array(count);
    this.gravity = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.baseAlpha = new Float32Array(count);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geo = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture }, uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(uMap, gl_PointCoord);
          gl_FragColor = vec4(vColor, tex.a * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit({ x, y, z, vx = 0, vy = 0, vz = 0, r = 1, g = 1, b = 1, size = 0.5, alpha = 1, life = 1, grow = 0, gravity = 0, drag = 0 }) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.color.set([r, g, b], i * 3);
    this.size[i] = size;
    this.baseAlpha[i] = alpha;
    this.alpha[i] = alpha;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grow[i] = grow;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
  }

  update(delta) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= delta;
      const o = i * 3;
      const damp = Math.max(0, 1 - this.drag[i] * delta);
      this.vel[o] *= damp;
      this.vel[o + 1] = this.vel[o + 1] * damp - this.gravity[i] * delta;
      this.vel[o + 2] *= damp;
      this.pos[o] += this.vel[o] * delta;
      this.pos[o + 1] += this.vel[o + 1] * delta;
      this.pos[o + 2] += this.vel[o + 2] * delta;
      if (this.pos[o + 1] < 0.02) {
        this.pos[o + 1] = 0.02;
        this.vel[o + 1] *= -0.3;
      }
      this.size[i] += this.grow[i] * delta;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[i] = this.baseAlpha[i] * k;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
  }

  setScale(viewportHeight) {
    this.material.uniforms.uScale.value = viewportHeight;
  }
}

/**
 * ParticleSystem
 * Efectos del juego: humo del escape (mas negro con el motor gastado),
 * polvo de las ruedas, chispas y esquirlas en los choques. Dos pools: uno
 * normal (humo/polvo) y otro aditivo (chispas que brillan con el bloom).
 */
export class ParticleSystem {
  constructor(scene, rng, density = 1) {
    this.rng = rng;
    this.density = density;
    const tex = createRadialGlowTexture(64);
    this.smoke = new ParticlePool(scene, { count: 500, blending: THREE.NormalBlending, texture: tex });
    this.sparks = new ParticlePool(scene, { count: 300, blending: THREE.AdditiveBlending, texture: tex });
    this._exhaustTimer = 0;
    this._tmp = new THREE.Vector3();
  }

  setDensity(density) {
    this.density = density;
  }

  setViewportHeight(h) {
    this.smoke.setScale(h);
    this.sparks.setScale(h);
  }

  /** Humo continuo del minibus segun aceleracion y estado del motor. */
  updateExhaust(delta, minibus) {
    if (this.density <= 0) return;
    const throttle = minibus.telemetry.throttle;
    const engineHealth = minibus.wear.motor / 100;
    const rate = (throttle ? 26 : 7) * this.density * (minibus.fuel > 0 ? 1 : 0);
    this._exhaustTimer += delta * rate;
    const p = minibus.getExhaustWorldPosition(this._tmp);
    while (this._exhaustTimer >= 1) {
      this._exhaustTimer -= 1;
      const dark = 0.75 - (1 - engineHealth) * 0.6; // motor gastado = humo negro
      const gray = Math.max(0.12, dark - this.rng() * 0.1);
      this.smoke.emit({
        x: p.x + (this.rng() - 0.5) * 0.1,
        y: p.y,
        z: p.z + (this.rng() - 0.5) * 0.1,
        vx: (this.rng() - 0.5) * 0.6,
        vy: 0.5 + this.rng() * 0.6,
        vz: (this.rng() - 0.5) * 0.6,
        r: gray,
        g: gray,
        b: gray * 1.02,
        size: 0.25,
        grow: throttle ? 1.6 : 0.9,
        alpha: throttle ? 0.42 + (1 - engineHealth) * 0.3 : 0.22,
        life: 1.1 + this.rng() * 0.6,
        drag: 1.2,
      });
    }

    // Polvo levantado por las ruedas traseras al ir rapido o derrapar.
    const speed = Math.abs(minibus.speed);
    const skid = minibus.telemetry.braking && speed > 5;
    if ((speed > 9 || skid) && this.rng() < delta * (skid ? 40 : 10) * this.density) {
      const side = this.rng() < 0.5 ? -1 : 1;
      const w = this._tmp.set(side * 1.1, 0.1, -1.6).applyMatrix4(minibus.mesh.matrixWorld);
      this.smoke.emit({
        x: w.x, y: 0.15, z: w.z,
        vx: (this.rng() - 0.5) * 1.5, vy: 0.4 + this.rng() * 0.5, vz: (this.rng() - 0.5) * 1.5,
        r: 0.55, g: 0.5, b: 0.44, size: 0.4, grow: 2.2, alpha: skid ? 0.35 : 0.18, life: 0.9, drag: 1.5,
      });
    }
  }

  /** Choque: chispas naranjas + esquirlas de polvo/pintura. */
  burst(position, strength = 1) {
    const n = Math.round(22 * strength * Math.max(0.4, this.density));
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2;
      const s = 3 + this.rng() * 6 * strength;
      this.sparks.emit({
        x: position.x, y: position.y + 0.6 + this.rng() * 0.6, z: position.z,
        vx: Math.cos(a) * s, vy: 2 + this.rng() * 4, vz: Math.sin(a) * s,
        r: 1.6, g: 0.75 + this.rng() * 0.3, b: 0.2,
        size: 0.09 + this.rng() * 0.07, alpha: 1, life: 0.35 + this.rng() * 0.4, gravity: 14, drag: 0.6,
      });
    }
    for (let i = 0; i < n / 2; i++) {
      this.smoke.emit({
        x: position.x + (this.rng() - 0.5), y: position.y + 0.5, z: position.z + (this.rng() - 0.5),
        vx: (this.rng() - 0.5) * 2, vy: 0.6 + this.rng(), vz: (this.rng() - 0.5) * 2,
        r: 0.6, g: 0.57, b: 0.52, size: 0.5, grow: 2.5, alpha: 0.35, life: 0.9, drag: 1.8,
      });
    }
  }

  /** Destello de monedas doradas al subir un pasajero (sobre el minibus). */
  coins(position) {
    if (this.density <= 0) return;
    for (let i = 0; i < 6; i++) {
      this.sparks.emit({
        x: position.x + (this.rng() - 0.5) * 0.8, y: position.y + 2.5, z: position.z + (this.rng() - 0.5) * 0.8,
        vx: (this.rng() - 0.5) * 1.5, vy: 2.5 + this.rng() * 1.5, vz: (this.rng() - 0.5) * 1.5,
        r: 1.4, g: 1.05, b: 0.25, size: 0.16, alpha: 1, life: 0.7, gravity: 6, drag: 0.5,
      });
    }
  }

  /** Llanta ardiendo (bloqueo): llamitas y humo negro espeso que sube. */
  burningTire(delta, position) {
    if (this.density <= 0) return;
    const emit = (rate, fn) => {
      const n = delta * rate * this.density;
      const count = Math.floor(n) + (this.rng() < n % 1 ? 1 : 0);
      for (let i = 0; i < count; i++) fn();
    };
    emit(28, () =>
      this.sparks.emit({
        x: position.x + (this.rng() - 0.5) * 0.6, y: position.y, z: position.z + (this.rng() - 0.5) * 0.6,
        vx: (this.rng() - 0.5) * 0.4, vy: 1.2 + this.rng() * 1.2, vz: (this.rng() - 0.5) * 0.4,
        r: 1.7, g: 0.55 + this.rng() * 0.35, b: 0.12,
        size: 0.35 + this.rng() * 0.25, grow: -0.3, alpha: 0.9, life: 0.45 + this.rng() * 0.3, drag: 0.8,
      })
    );
    emit(10, () => {
      const gray = 0.08 + this.rng() * 0.08;
      this.smoke.emit({
        x: position.x + (this.rng() - 0.5) * 0.5, y: position.y + 0.8, z: position.z + (this.rng() - 0.5) * 0.5,
        vx: (this.rng() - 0.5) * 0.8 + 0.3, vy: 1.6 + this.rng() * 0.8, vz: (this.rng() - 0.5) * 0.8,
        r: gray, g: gray, b: gray,
        size: 0.7, grow: 2.4, alpha: 0.32, life: 2.4 + this.rng() * 1.2, drag: 0.6,
      });
    });
  }

  update(delta) {
    this.smoke.update(delta);
    this.sparks.update(delta);
  }
}
