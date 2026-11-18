import * as THREE from 'three';
import { internalStreetLines } from './streetGrid.js';

// Cada cruce tiene dos fases opuestas: cuando las calles en Z estan en
// verde/amarillo, las de X estan en rojo y viceversa (RED = GREEN + YELLOW).
const GREEN_TIME = 5.5;
const YELLOW_TIME = 1.4;
const RED_TIME = GREEN_TIME + YELLOW_TIME;
const CYCLE_TIME = GREEN_TIME + YELLOW_TIME + RED_TIME;

const INTERSECTION_HALF_SIZE = 4.6; // ~streetWidth/2, zona que cubre el cruce completo
const MIN_SPEED_TO_INFRACT = 1.2; // m/s; evita contar como infraccion estar detenido sobre el cruce
const CORNER_OFFSET = 4.95; // poste sobre la esquina de la vereda

const LIT = 3.2; // >1: el bloom hace brillar la luz encendida
const DIM = 0.07;

const COLOR_ORDER = ['red', 'yellow', 'green'];
const BASE_COLORS = { red: new THREE.Color(0xff3b30), yellow: new THREE.Color(0xffc21a), green: new THREE.Color(0x2ee66b) };
const BULB_ROWS = [5.8, 5.4, 5.0]; // rojo arriba, amarillo, verde abajo

// Caras del cabezal: las +-Z muestran la fase del eje Z; las +-X, la del eje X.
const FACES = [
  { axis: 'z', rotY: 0, nx: 0, nz: 1 },
  { axis: 'z', rotY: Math.PI, nx: 0, nz: -1 },
  { axis: 'x', rotY: Math.PI / 2, nx: 1, nz: 0 },
  { axis: 'x', rotY: -Math.PI / 2, nx: -1, nz: 0 },
];
const BULBS_PER_LIGHT = FACES.length * COLOR_ORDER.length;

function stateAt(t) {
  if (t < GREEN_TIME) return 'green';
  if (t < GREEN_TIME + YELLOW_TIME) return 'yellow';
  return 'red';
}

/** Estado logico de un cruce (sin mallas propias: se dibuja instanciado). */
class TrafficLight {
  constructor(index, x, z, phaseOffset) {
    this.index = index;
    this.position = new THREE.Vector3(x, 0, z);
    this._t = phaseOffset;
    this.states = { z: null, x: null };
    this.zone = new THREE.Box3(
      new THREE.Vector3(x - INTERSECTION_HALF_SIZE, -1, z - INTERSECTION_HALF_SIZE),
      new THREE.Vector3(x + INTERSECTION_HALF_SIZE, 5, z + INTERSECTION_HALF_SIZE)
    );
    this.playerWasInside = false;
  }

  /** Avanza el ciclo. Devuelve true si cambio alguna fase. */
  update(delta) {
    this._t = (this._t + delta) % CYCLE_TIME;
    const z = stateAt(this._t);
    const x = stateAt((this._t + RED_TIME) % CYCLE_TIME);
    if (z === this.states.z && x === this.states.x) return false;
    this.states.z = z;
    this.states.x = x;
    return true;
  }

  /** Estado para quien circula a lo largo del eje 'x' o 'z'. */
  stateFor(axis) {
    return this.states[axis];
  }
}

/**
 * TrafficLightSystem
 * Semaforos de brazo en los cruces internos (poste en una esquina, cabezal
 * sobre el centro con luces en sus 4 caras). Todas las piezas de todos los
 * semaforos son InstancedMesh: 6 draw calls en total. Cambiar una luz solo
 * actualiza el color de su instancia. Detecta cruces en rojo del jugador y
 * el trafico NPC lo consulta con getLightAt().
 */
export class TrafficLightSystem {
  constructor(scene, city, rng) {
    this.lights = [];
    this._byKey = new Map();

    const xs = internalStreetLines(city.blocksX, city.step, city.blockSize, city.streetWidth);
    const zs = internalStreetLines(city.blocksZ, city.step, city.blockSize, city.streetWidth);
    for (const x of xs) {
      for (const z of zs) {
        const light = new TrafficLight(this.lights.length, x, z, rng() * CYCLE_TIME);
        this.lights.push(light);
        this._byKey.set(`${x},${z}`, light);
      }
    }

    this._buildMeshes(scene);
    for (const light of this.lights) {
      light.update(0);
      this._paint(light);
    }
    this.bulbs.instanceColor.needsUpdate = true;

    // (infraccionPos: THREE.Vector3) => void — lo conecta game.js con PoliceSystem.
    this.onRedLightInfraction = null;
    this._forward = new THREE.Vector3();
    this._color = new THREE.Color();
  }

  _buildMeshes(scene) {
    const n = this.lights.length;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.6, metalness: 0.4 });
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.7 });

    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.1, 0.13, 6, 8), poleMat, n);
    const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 1), poleMat, n);
    const housings = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 1.25, 0.5), housingMat, n);
    const visors = new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.05, 0.18), housingMat, n * BULBS_PER_LIGHT);
    // Las luces no necesitan iluminacion: MeshBasic + color por instancia.
    this.bulbs = new THREE.InstancedMesh(new THREE.CircleGeometry(0.13, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }), n * BULBS_PER_LIGHT);

    const d = new THREE.Object3D();
    const set = (mesh, i) => {
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
    };

    for (const light of this.lights) {
      const { x, z } = light.position;
      // Esquina distinta a la de los faroles (que miran al centro de la ciudad).
      const cx = (Math.sign(x) || 1) * CORNER_OFFSET;
      const cz = -(Math.sign(z) || 1) * CORNER_OFFSET;

      d.position.set(x + cx, 3.22, z + cz);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, 1, 1);
      set(poles, light.index);

      d.position.set(x + cx / 2, 6.1, z + cz / 2);
      d.rotation.set(0, Math.atan2(cx, cz), 0);
      d.scale.set(1, 1, Math.hypot(cx, cz));
      set(arms, light.index);

      d.position.set(x, 5.4, z);
      d.rotation.set(0, 0, 0);
      d.scale.set(1, 1, 1);
      set(housings, light.index);

      FACES.forEach((face, f) => {
        BULB_ROWS.forEach((y, c) => {
          const i = light.index * BULBS_PER_LIGHT + f * 3 + c;
          d.rotation.set(0, face.rotY, 0);
          d.position.set(x + face.nx * 0.26, y, z + face.nz * 0.26);
          set(this.bulbs, i);
          d.position.set(x + face.nx * 0.33, y + 0.15, z + face.nz * 0.33);
          set(visors, i);
        });
      });
    }

    // Color inicial para crear el atributo instanceColor.
    this.bulbs.setColorAt(0, BASE_COLORS.red);
    poles.castShadow = true;
    housings.castShadow = true;
    scene.add(poles, arms, housings, visors, this.bulbs);
  }

  /** Pinta las 12 luces de un cruce segun sus fases actuales. */
  _paint(light) {
    const color = this._color ?? (this._color = new THREE.Color());
    FACES.forEach((face, f) => {
      const state = light.states[face.axis];
      COLOR_ORDER.forEach((key, c) => {
        color.copy(BASE_COLORS[key]).multiplyScalar(key === state ? LIT : DIM);
        this.bulbs.setColorAt(light.index * BULBS_PER_LIGHT + f * 3 + c, color);
      });
    });
  }

  getLightAt(x, z) {
    return this._byKey.get(`${x},${z}`) ?? null;
  }

  update(delta, minibus) {
    let changed = false;
    for (const light of this.lights) {
      if (light.update(delta)) {
        this._paint(light);
        changed = true;
      }
    }
    if (changed) this.bulbs.instanceColor.needsUpdate = true;

    const pos = minibus.mesh.position;
    const speed = Math.abs(minibus.speed);
    // Eje por el que circula el jugador (segun hacia donde mira el minibus).
    this._forward.set(0, 0, 1).applyQuaternion(minibus.mesh.quaternion);
    const axis = Math.abs(this._forward.z) >= Math.abs(this._forward.x) ? 'z' : 'x';

    for (const light of this.lights) {
      const inside = light.zone.containsPoint(pos);
      if (inside && !light.playerWasInside && light.stateFor(axis) === 'red' && speed > MIN_SPEED_TO_INFRACT) {
        if (this.onRedLightInfraction) this.onRedLightInfraction(light.position);
      }
      light.playerWasInside = inside;
    }
  }
}
