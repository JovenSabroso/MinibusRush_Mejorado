import * as THREE from 'three';

/**
 * CollisionSystem
 * Colisiones del minibus contra cajas estaticas (edificios, muros, mobiliario).
 *
 * El vehiculo se aproxima con 3 circulos alineados con su eje largo, asi la
 * colision respeta su orientacion real (antes se usaba una caja alineada a
 * los ejes que "engordaba" al girar). Cada circulo se resuelve contra la
 * caja por el eje de menor penetracion: el vehiculo se desliza a lo largo
 * de paredes y esquinas en vez de rebotar o atravesarlas.
 */

// Offsets (m) de los circulos a lo largo del eje del vehiculo y su radio.
const CIRCLE_OFFSETS = [-1.7, 0, 1.7];
const CIRCLE_RADIUS = 1.12;
const MAX_STEP_HEIGHT = 2.4; // cajas mas bajas que esto (y sin altura de choque) se ignoran por arriba

export class CollisionSystem {
  constructor() {
    this.staticBoxes = [];
    this._fwd = new THREE.Vector3();
    this._nx = 0;
    this._nz = 0;
    /** Velocidad (m/s) con la que se golpeo en el ultimo frame con colision. */
    this.lastImpact = 0;
  }

  /** Registra un Object3D como obstaculo estatico (usa su bounding box actual). */
  addStaticObstacle(object3D) {
    this.staticBoxes.push(new THREE.Box3().setFromObject(object3D));
  }

  addStaticBox(box3) {
    this.staticBoxes.push(box3);
  }

  /**
   * Resuelve un circulo (cx, cz, r) contra un rectangulo XZ. Devuelve la
   * penetracion (>0 si hay contacto) y deja la normal de salida en this._nx/_nz.
   */
  _circleVsRect(cx, cz, r, minX, minZ, maxX, maxZ) {
    const px = Math.max(minX, Math.min(cx, maxX));
    const pz = Math.max(minZ, Math.min(cz, maxZ));
    let dx = cx - px;
    let dz = cz - pz;
    const distSq = dx * dx + dz * dz;

    if (distSq > 1e-8) {
      if (distSq >= r * r) return 0;
      const dist = Math.sqrt(distSq);
      this._nx = dx / dist;
      this._nz = dz / dist;
      return r - dist;
    }

    // Centro dentro de la caja: sale por el lado mas cercano.
    const left = cx - minX;
    const right = maxX - cx;
    const back = cz - minZ;
    const front = maxZ - cz;
    const m = Math.min(left, right, back, front);
    this._nx = 0;
    this._nz = 0;
    if (m === left) this._nx = -1;
    else if (m === right) this._nx = 1;
    else if (m === back) this._nz = -1;
    else this._nz = 1;
    return m + r;
  }

  /**
   * Resuelve la colision del vehiculo contra un rectangulo XZ cualquiera
   * (lo usa tambien el trafico). Mueve el mesh y ajusta la velocidad.
   * @returns {number} intensidad del impacto (m/s contra la superficie), 0 si no hubo contacto
   */
  resolveAgainstRect(vehicle, minX, minZ, maxX, maxZ) {
    const mesh = vehicle.mesh;
    const pos = mesh.position;
    const fwd = this._fwd.set(0, 0, 1).applyQuaternion(mesh.quaternion);
    let impact = 0;

    for (const off of CIRCLE_OFFSETS) {
      const cx = pos.x + fwd.x * off;
      const cz = pos.z + fwd.z * off;
      const depth = this._circleVsRect(cx, cz, CIRCLE_RADIUS, minX, minZ, maxX, maxZ);
      if (depth <= 0) continue;

      const nx = this._nx;
      const nz = this._nz;
      // Saca al vehiculo del obstaculo (separacion exacta, sin rebote).
      pos.x += nx * depth;
      pos.z += nz * depth;

      // Componente de la velocidad que va contra la superficie.
      const headingDotN = fwd.x * nx + fwd.z * nz;
      const intoWall = -vehicle.speed * headingDotN;
      if (intoWall > 0) {
        impact = Math.max(impact, intoWall);
        // Quita solo la parte normal: el vehiculo conserva lo que se desliza.
        const d2 = headingDotN * headingDotN;
        // Golpe casi de frente: frena casi del todo. Roce con la pared: apenas pierde velocidad.
        vehicle.speed *= d2 > 0.12 ? 1 - d2 * 0.92 : 1 - d2 * 0.12;
        // Un golpe de frente casi detiene al vehiculo; no lo lanza hacia atras.
        if (Math.abs(vehicle.speed) < 0.2) vehicle.speed = 0;
      }
    }
    return impact;
  }

  /**
   * Comprueba y resuelve colisiones del vehiculo contra los obstaculos estaticos.
   * @returns {boolean} true si hubo colision este frame
   */
  resolveVehicleCollisions(vehicle) {
    const pos = vehicle.mesh.position;
    let collided = false;
    let impact = 0;

    // Dos pasadas: la segunda corrige empujes que metan al vehiculo en otra pared (esquinas).
    for (let pass = 0; pass < 2; pass++) {
      let any = false;
      for (let i = 0; i < this.staticBoxes.length; i++) {
        const box = this.staticBoxes[i];
        if (box.max.y < 0.3 || box.min.y > MAX_STEP_HEIGHT) continue;
        // Descarte rapido por distancia al centro del vehiculo.
        if (pos.x < box.min.x - 4 || pos.x > box.max.x + 4 || pos.z < box.min.z - 4 || pos.z > box.max.z + 4) continue;
        const hit = this.resolveAgainstRect(vehicle, box.min.x, box.min.z, box.max.x, box.max.z);
        if (hit > 0) {
          impact = Math.max(impact, hit);
          any = true;
        }
        // resolveAgainstRect devuelve 0 en contacto sin velocidad contra la pared;
        // aun asi cuenta como contacto si lo movio (se detecta con la bandera de abajo).
      }
      if (!any) break;
    }

    // Contacto "suave" (rozando sin velocidad hacia la pared) no penaliza.
    collided = impact > 0.8;
    this.lastImpact = impact;
    return collided;
  }
}
