import * as THREE from 'three';
import { buildTrafficVehicle } from './TrafficVehicles.js';
import { internalStreetLines } from './streetGrid.js';

const LANE_OFFSET = 2.25; // separacion del centro de calle para cada sentido (streetWidth=9 -> 2 carriles)
const COLLISION_RADIUS = 2.5; // metros, distancia para considerar choque leve con el jugador
const STOP_LINE_OFFSET = 7.2; // metros antes del centro del cruce donde se detienen
const FOLLOW_GAP = 8.5; // distancia minima (centro a centro) con el vehiculo de adelante

// Peso relativo de aparicion de cada tipo, siguiendo el orden del concepto
// (automoviles, taxis, otros minibuses, camiones).
const KIND_WEIGHTS = [
  { kind: 'car', weight: 0.45, speed: [7, 9.5], half: [0.95, 2.05] },
  { kind: 'taxi', weight: 0.25, speed: [7.5, 10], half: [0.95, 2.05] },
  { kind: 'minibus', weight: 0.2, speed: [6.5, 8.5], half: [1.05, 2.45] },
  { kind: 'truck', weight: 0.1, speed: [4.5, 6], half: [1.15, 3.3] },
];

const BRAKE_DECEL = 5.5; // m/s^2 que se usa para planificar la frenada (comoda, no brusca)
const CLEAR_LANE_WIDTH = 2.6; // ancho lateral considerado "mi carril" para el jugador

function pickKind(rng) {
  const roll = rng();
  let acc = 0;
  for (const entry of KIND_WEIGHTS) {
    acc += entry.weight;
    if (roll <= acc) return entry;
  }
  return KIND_WEIGHTS[0];
}

/**
 * TrafficSystem
 * Vehiculos NPC (autos, taxis, otros minibuses, camiones) que circulan en
 * linea recta por las calles internas de la ciudad, en dos carriles por
 * calle (uno por sentido). No doblan en los cruces, pero si respetan los
 * semaforos, guardan distancia y frenan si el jugador esta delante. Cuando
 * un vehiculo sale del area jugable reaparece en el extremo opuesto.
 * Si el jugador choca contra uno, sufre un dano leve (fase 4 del concepto).
 */
export class TrafficSystem {
  constructor(scene, city, rng) {
    this.rng = rng;
    this.halfExtentX = city.halfExtentX;
    this.halfExtentZ = city.halfExtentZ;

    this.group = new THREE.Group();
    this.group.name = 'Traffic';
    scene.add(this.group);

    this._speedMultiplier = 1;
    this._speedMultiplierTimer = 0;

    this.vehicles = this._buildLanesAndVehicles(city);

    this._playerCollisionState = new Set(); // vehiculos ya "tocando" al jugador este frame (evita re-empuje doble)

    /** BlockadeSystem activo (lo asigna Game): los vehiculos de esa calle frenan antes. */
    this.blockade = null;
  }

  _buildLanesAndVehicles(city) {
    const xs = internalStreetLines(city.blocksX, city.step, city.blockSize, city.streetWidth);
    const zs = internalStreetLines(city.blocksZ, city.step, city.blockSize, city.streetWidth);

    const lanes = [];
    for (const x of xs) {
      lanes.push({ axis: 'z', streetCoord: x, dir: 1, offset: -LANE_OFFSET, range: this.halfExtentZ });
      lanes.push({ axis: 'z', streetCoord: x, dir: -1, offset: LANE_OFFSET, range: this.halfExtentZ });
    }
    for (const z of zs) {
      lanes.push({ axis: 'x', streetCoord: z, dir: 1, offset: -LANE_OFFSET, range: this.halfExtentX });
      lanes.push({ axis: 'x', streetCoord: z, dir: -1, offset: LANE_OFFSET, range: this.halfExtentX });
    }

    const vehicles = [];
    for (const lane of lanes) {
      // Cruces (coordenada a lo largo del recorrido) que tienen semaforo.
      lane.crossings = lane.axis === 'z' ? zs : xs;
      lane.vehicles = [];
      const count = 1 + (this.rng() < 0.5 ? 1 : 0); // 1 o 2 vehiculos por carril
      for (let i = 0; i < count; i++) {
        const vehicle = this._spawnVehicle(lane, i, count);
        lane.vehicles.push(vehicle);
        vehicles.push(vehicle);
      }
    }
    return vehicles;
  }

  _spawnVehicle(lane, index, count) {
    const entry = pickKind(this.rng);
    const mesh = buildTrafficVehicle(entry.kind, this.rng);
    const speed = entry.speed[0] + this.rng() * (entry.speed[1] - entry.speed[0]);
    // Repartidos a lo largo del carril para que no aparezcan encimados.
    const slot = (index + 0.2 + this.rng() * 0.6) / count;
    const travelPos = (slot * 2 - 1) * lane.range;

    // Caja de colision (alineada al eje de la calle): [mitad perpendicular, mitad a lo largo].
    const vehicle = { mesh, lane, speed, currentSpeed: speed, travelPos, stallTimer: 0, half: entry.half };
    this._applyTransform(vehicle);
    this.group.add(mesh);
    return vehicle;
  }

  _applyTransform(vehicle) {
    const { lane, travelPos, mesh } = vehicle;
    if (lane.axis === 'z') {
      mesh.position.set(lane.streetCoord + lane.offset, 0, travelPos);
      mesh.rotation.y = lane.dir > 0 ? 0 : Math.PI;
    } else {
      mesh.position.set(travelPos, 0, lane.streetCoord + lane.offset);
      mesh.rotation.y = lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
  }

  /**
   * Avanza el trafico. Cada vehiculo decide su velocidad objetivo segun:
   * semaforo del proximo cruce, distancia al vehiculo de adelante en su
   * carril y si el jugador esta parado delante (no lo embiste).
   */
  update(delta, minibus = null, trafficLights = null) {
    if (this._speedMultiplierTimer > 0) {
      this._speedMultiplierTimer -= delta;
      if (this._speedMultiplierTimer <= 0) this._speedMultiplier = 1;
    }

    for (const vehicle of this.vehicles) {
      if (vehicle.stallTimer > 0) {
        vehicle.stallTimer -= delta;
        vehicle.currentSpeed = 0;
        continue; // vehiculo detenido (evento "accidente"): no avanza
      }

      const target = this._targetSpeed(vehicle, minibus, trafficLights);
      const rate = target > vehicle.currentSpeed ? 3.5 : 9;
      vehicle.currentSpeed += Math.sign(target - vehicle.currentSpeed) * Math.min(Math.abs(target - vehicle.currentSpeed), rate * delta);

      vehicle.travelPos += vehicle.currentSpeed * vehicle.lane.dir * delta;

      const range = vehicle.lane.range;
      if (vehicle.travelPos > range) vehicle.travelPos = -range;
      else if (vehicle.travelPos < -range) vehicle.travelPos = range;

      this._applyTransform(vehicle);
    }
  }

  /** Velocidad maxima desde la que se puede frenar con comodidad en `distance` metros. */
  _speedToStopIn(distance) {
    return distance <= 0 ? 0 : Math.sqrt(2 * BRAKE_DECEL * distance);
  }

  _targetSpeed(vehicle, minibus, trafficLights) {
    const { lane, travelPos } = vehicle;
    const dir = lane.dir;
    let target = vehicle.speed * this._speedMultiplier;

    // 1) Semaforo del proximo cruce en su direccion.
    if (trafficLights) {
      for (const crossing of lane.crossings) {
        const stopPos = crossing - dir * STOP_LINE_OFFSET;
        const dist = (stopPos - travelPos) * dir;
        if (dist < -0.5 || dist > 30) continue;
        const light = lane.axis === 'z' ? trafficLights.getLightAt(lane.streetCoord, crossing) : trafficLights.getLightAt(crossing, lane.streetCoord);
        if (!light) break;
        const state = light.stateFor(lane.axis);
        const mustStop = state === 'red' || (state === 'yellow' && dist > 4);
        if (mustStop) target = Math.min(target, this._speedToStopIn(dist - 0.5));
        break; // solo importa el cruce mas cercano
      }
    }

    // 2) Distancia con el vehiculo de adelante en el mismo carril.
    for (const other of lane.vehicles) {
      if (other === vehicle) continue;
      const gap = (other.travelPos - travelPos) * dir;
      if (gap > 0 && gap < 26) {
        // Sigue al de adelante: nunca mas rapido que el, y frena con perfil suave.
        const follow = this._speedToStopIn(gap - FOLLOW_GAP) + Math.max(0, other.currentSpeed) * 0.55;
        target = Math.min(target, follow, gap < FOLLOW_GAP * 0.8 ? 0 : Infinity);
      }
    }

    // 3) El jugador delante, dentro del carril: frena detras de el.
    if (minibus) {
      const p = minibus.mesh.position;
      const along = lane.axis === 'z' ? p.z : p.x;
      const lateral = lane.axis === 'z' ? p.x : p.z;
      const laneCoord = lane.streetCoord + lane.offset;
      const ahead = (along - travelPos) * dir;
      if (Math.abs(lateral - laneCoord) < CLEAR_LANE_WIDTH && ahead > 0 && ahead < 20) {
        target = Math.min(target, this._speedToStopIn(ahead - 6.5));
      }
    }

    // 4) Bloqueo de gente en esta misma calle: se forma la fila detras.
    const block = this.blockade;
    if (block?.blocksTraffic && block.axis === lane.axis && Math.abs(block.streetCoord - lane.streetCoord) < 1) {
      const gap = (block.along - travelPos) * dir - block.halfDepth - vehicle.half[1] - 1.2;
      // gap <= 0: ya estaba encima cuando llego la gente, que siga de largo.
      if (gap > 0 && gap < 35) target = Math.min(target, this._speedToStopIn(gap));
    }

    return target;
  }

  /**
   * Choques contra el jugador: usa la misma resolucion por circulos que las
   * paredes (el minibus se desliza y se frena, sin rebotes). El NPC sigue su
   * camino. Devuelve true si hubo un golpe de cierta fuerza este frame.
   */
  checkPlayerCollision(minibus, collisionSystem) {
    const p = minibus.mesh.position;
    let impact = 0;
    for (const vehicle of this.vehicles) {
      const m = vehicle.mesh.position;
      // Descarte rapido (los autos estan a >12 m casi siempre).
      if (Math.abs(p.x - m.x) > 7 || Math.abs(p.z - m.z) > 7) continue;
      const alongZ = vehicle.lane.axis === 'z';
      const hx = alongZ ? vehicle.half[0] : vehicle.half[1];
      const hz = alongZ ? vehicle.half[1] : vehicle.half[0];
      const hit = collisionSystem.resolveAgainstRect(minibus, m.x - hx, m.z - hz, m.x + hx, m.z + hz);
      if (hit > impact) impact = hit;
      if (hit > 0.5 && vehicle.currentSpeed > 0) vehicle.currentSpeed *= 0.85; // el NPC "siente" el golpe
    }
    this.lastImpact = impact;
    return impact > 0.8;
  }

  /** Evento "trafico pesado": reduce la velocidad de todo el trafico un rato. */
  setGlobalSpeedMultiplier(multiplier, durationSeconds) {
    this._speedMultiplier = multiplier;
    this._speedMultiplierTimer = durationSeconds;
  }

  /**
   * Al armarse un bloqueo, los vehiculos que justo estaban en ese tramo
   * siguen de largo: se los adelanta fuera de la zona (pasa a 30+ m del
   * jugador, no se nota) para que la gente no quede encima de un auto.
   */
  clearBlockedZone(block) {
    for (const vehicle of this.vehicles) {
      const { lane } = vehicle;
      if (lane.axis !== block.axis || Math.abs(lane.streetCoord - block.streetCoord) > 1) continue;
      const reach = block.halfDepth + vehicle.half[1] + 1;
      const rel = (vehicle.travelPos - block.along) * lane.dir;
      if (Math.abs(rel) >= reach) continue;
      vehicle.travelPos = block.along + lane.dir * (reach + 1);
      this._applyTransform(vehicle);
    }
  }

  /** Evento "accidente": detiene un vehiculo al azar durante un rato. */
  stallRandomVehicle(durationSeconds) {
    if (this.vehicles.length === 0) return;
    const vehicle = this.vehicles[Math.floor(this.rng() * this.vehicles.length)];
    vehicle.stallTimer = durationSeconds;
  }
}
