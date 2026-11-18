import * as THREE from 'three';

/**
 * CameraSystem
 * Camara en tercera persona que sigue al minibus con suavizado (lerp).
 * Ofrece 3 modos que se ciclan con la tecla C:
 *   0 - Detras (clasica, media altura)
 *   1 - Elevada (mas alta y alejada, buena para ver la ciudad)
 *   2 - Cercana (pegada al vehiculo, sensacion de velocidad)
 */
export class CameraSystem {
  constructor(camera, target) {
    this.camera = camera;
    this.target = target; // objeto con .mesh (Object3D) del vehiculo

    this.modes = [
      { name: 'Detras del minibús', offset: new THREE.Vector3(0, 3.2, -7.5), lookOffset: new THREE.Vector3(0, 1.2, 3), fov: 60 },
      { name: 'Vista elevada', offset: new THREE.Vector3(0, 6.5, -11), lookOffset: new THREE.Vector3(0, 1, 2), fov: 55 },
      { name: 'Vista cercana', offset: new THREE.Vector3(0, 1.9, -3.2), lookOffset: new THREE.Vector3(0, 1.3, 4), fov: 68 },
    ];
    this.currentModeIndex = 0;

    this._desiredPos = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._currentLookAt = new THREE.Vector3();

    this.positionSmoothing = 6; // mas alto = sigue mas rapido
    this.lookSmoothing = 8;

    this._shake = 0; // 0..1, decae solo
    this._fov = this.modes[0].fov;
  }

  cycleMode() {
    this.currentModeIndex = (this.currentModeIndex + 1) % this.modes.length;
    return this.modes[this.currentModeIndex].name;
  }

  /** Sacudida de camara (choques). */
  shake(amount) {
    this._shake = Math.min(1, this._shake + amount);
  }

  /** Coloca la camara de golpe detras del vehiculo (inicio de jornada, grua). */
  snap() {
    const mode = this.modes[this.currentModeIndex];
    const vehicle = this.target.mesh;
    vehicle.updateMatrixWorld();
    this.camera.position.copy(mode.offset).applyQuaternion(vehicle.quaternion).add(vehicle.position);
    this._currentLookAt.copy(mode.lookOffset).applyQuaternion(vehicle.quaternion).add(vehicle.position);
    this.camera.lookAt(this._currentLookAt);
    this._fov = mode.fov;
    this.camera.fov = mode.fov;
    this.camera.updateProjectionMatrix();
  }

  update(delta) {
    const mode = this.modes[this.currentModeIndex];
    const vehicle = this.target.mesh;

    // Convierte el offset local del modo actual a coordenadas de mundo
    // segun la orientacion actual del vehiculo.
    this._desiredPos.copy(mode.offset).applyQuaternion(vehicle.quaternion).add(vehicle.position);
    this._lookAt.copy(mode.lookOffset).applyQuaternion(vehicle.quaternion).add(vehicle.position);

    const posAlpha = 1 - Math.exp(-this.positionSmoothing * delta);
    const lookAlpha = 1 - Math.exp(-this.lookSmoothing * delta);

    this.camera.position.lerp(this._desiredPos, posAlpha);
    this._currentLookAt.lerp(this._lookAt, lookAlpha);

    // Sacudida: ruido rapido que se apaga en ~0.5 s.
    if (this._shake > 0.001) {
      const s = this._shake * this._shake * 0.35;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this._shake = Math.max(0, this._shake - delta * 2.2);
    }
    this.camera.lookAt(this._currentLookAt);

    // El FOV se abre con la velocidad: sensacion de rapidez sin cambiar la fisica.
    const speedRatio = Math.min(1, Math.abs(this.target.speed) / 15);
    const targetFov = mode.fov + speedRatio * 9;
    this._fov += (targetFov - this._fov) * (1 - Math.exp(-3 * delta));
    if (Math.abs(this.camera.fov - this._fov) > 0.01) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
