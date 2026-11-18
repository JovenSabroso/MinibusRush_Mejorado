import * as THREE from 'three';
import { DAY_START_HOUR, DAY_END_HOUR, DAY_REAL_SECONDS } from './config.js';

// Paletas: dia altiplanico (cielo azul profundo), atardecer dorado, noche.
const PALETTE = {
  day: { top: new THREE.Color(0x2560b8), horizon: new THREE.Color(0xa9cbe8), fog: new THREE.Color(0xb2c8dc) },
  golden: { top: new THREE.Color(0x3b5795), horizon: new THREE.Color(0xff9c55), fog: new THREE.Color(0xd99a78) },
  night: { top: new THREE.Color(0x03050c), horizon: new THREE.Color(0x141c38), fog: new THREE.Color(0x0e1426) },
};
const SUN_DAY = new THREE.Color(0xfff2d9);
const SUN_GOLD = new THREE.Color(0xffa060);
const MOON = new THREE.Color(0x9fb7ff);
const WHITE = new THREE.Color(0xffffff);

const smoothstep = (a, b, x) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * DayNightSystem
 * Reloj de la jornada (06:00 -> 22:00) y todo lo que depende de la hora:
 * posicion del sol/luna, colores del cielo y la niebla, intensidad de las
 * luces y el factor `night` (0..1) que usan ciudad, trafico y minibus para
 * encender ventanas, faroles y faros. Tambien oscurece todo con la lluvia.
 */
export class DayNightSystem {
  constructor({ scene, sky, sun, hemi, ambient, renderer }) {
    this.scene = scene;
    this.sky = sky;
    this.sun = sun;
    this.hemi = hemi;
    this.ambient = ambient;
    this.renderer = renderer;

    this.hour = DAY_START_HOUR;
    this.night = 0;
    this.golden = 0;
    this.rain = 0; // 0..1, lo fija WeatherSystem
    this.flash = 0; // relampago 0..1

    this.scene.fog = new THREE.FogExp2(0xb2c8dc, 0.004);
    this._sunDir = new THREE.Vector3();
    this._tmpTop = new THREE.Color();
    this._tmpHorizon = new THREE.Color();
    this._tmpFog = new THREE.Color();
    this._tmpGray = new THREE.Color();

    this.apply(new THREE.Vector3());
  }

  get dayProgress() {
    return (this.hour - DAY_START_HOUR) / (DAY_END_HOUR - DAY_START_HOUR);
  }

  get isOver() {
    return this.hour >= DAY_END_HOUR;
  }

  get clockText() {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  setHour(hour) {
    this.hour = hour;
  }

  /** Avanza el reloj (solo mientras se juega). */
  tick(delta) {
    const hoursPerSecond = (DAY_END_HOUR - DAY_START_HOUR) / DAY_REAL_SECONDS;
    this.hour = Math.min(DAY_END_HOUR, this.hour + delta * hoursPerSecond);
  }

  /**
   * Recalcula cielo, niebla y luces. `focus` es el punto que deben cubrir
   * las sombras (el minibus), asi el mapa de sombras sigue al jugador.
   */
  apply(focus) {
    // Recorrido del sol: sale por +X (06:00), cenit al mediodia, se pone por
    // -X detras del Illimani (~18:30). Fuera de ese rango queda bajo el horizonte.
    const t = (this.hour - 6.1) / 12.6;
    const sunDir = this._sunDir.set(Math.cos(Math.PI * t), Math.sin(Math.PI * t) * 0.9, 0.38).normalize();
    const elevation = sunDir.y;

    this.night = 1 - smoothstep(-0.14, 0.06, elevation);
    this.golden = (1 - smoothstep(0.04, 0.38, elevation)) * (1 - this.night);
    const rain = this.rain;

    const top = this._tmpTop.copy(PALETTE.day.top).lerp(PALETTE.golden.top, this.golden).lerp(PALETTE.night.top, this.night);
    const horizon = this._tmpHorizon.copy(PALETTE.day.horizon).lerp(PALETTE.golden.horizon, this.golden).lerp(PALETTE.night.horizon, this.night);
    const fog = this._tmpFog.copy(PALETTE.day.fog).lerp(PALETTE.golden.fog, this.golden).lerp(PALETTE.night.fog, this.night);

    // La lluvia vuelve todo gris y cierra la niebla.
    const stormGray = this._tmpGray.setScalar(0.32 - this.night * 0.26);
    fog.lerp(stormGray, rain * 0.7);
    horizon.lerp(stormGray, rain * 0.6);

    const u = this.sky.uniforms;
    u.uTop.value.copy(top);
    u.uHorizon.value.copy(horizon);
    u.uBottom.value.copy(fog).multiplyScalar(0.7);
    u.uSunDir.value.copy(sunDir);
    u.uSunColor.value.copy(SUN_DAY).lerp(SUN_GOLD, this.golden);
    u.uSunSize.value = 1 + this.golden * 1.5;
    u.uMoonDir.value.set(-sunDir.x, -sunDir.y + 0.35, -0.5).normalize();
    u.uNight.value = this.night;
    u.uStorm.value = rain;
    u.uFlash.value = this.flash;
    this.sky.starMat.uniforms.uOpacity.value = this.night * (1 - rain);

    this.scene.fog.color.copy(fog);
    this.scene.fog.density = 0.0038 + this.night * 0.0012 + rain * 0.0075;

    // Luz direccional: sol de dia, luna (azulada, tenue) de noche.
    const sunStrength = smoothstep(-0.04, 0.2, elevation);
    if (sunStrength > 0.02) {
      this.sun.color.copy(SUN_DAY).lerp(SUN_GOLD, this.golden);
      this.sun.intensity = 2.7 * sunStrength * (1 - rain * 0.7);
      this._placeLight(sunDir, focus);
    } else {
      this.sun.color.copy(MOON);
      this.sun.intensity = 0.38 * (1 - rain * 0.6);
      this._placeLight(u.uMoonDir.value, focus);
    }
    this.sun.intensity += this.flash * 3;

    this.hemi.color.copy(top).lerp(WHITE, 0.45);
    this.hemi.groundColor.setHex(0x3a332c);
    // El mapa de entorno aporta luz ambiental y reflejos: se baja un poco la hemisferica para no sobreexponer.
    this.hemi.intensity = THREE.MathUtils.lerp(0.78, 0.16, this.night) * (1 - rain * 0.3) + this.flash * 2;
    this.ambient.intensity = THREE.MathUtils.lerp(0.2, 0.09, this.night);
    if (this.scene.environment) {
      // Mas reflejo con el sol alto, menos de noche; la lluvia lo apaga. El atardecer lo calienta.
      this.scene.environmentIntensity = THREE.MathUtils.lerp(0.5, 0.09, this.night) * (1 - rain * 0.35) * (1 + this.golden * 0.15) + this.flash * 0.4;
    }

    // Exposicion: mas abierta de noche, ligeramente contenida al mediodia para conservar contraste.
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.98 + this.golden * 0.06, 1.25, this.night);
  }

  _placeLight(dir, focus) {
    this.sun.position.copy(focus).addScaledVector(dir, 140);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
  }
}
