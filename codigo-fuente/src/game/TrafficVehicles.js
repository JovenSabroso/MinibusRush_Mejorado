import * as THREE from 'three';
import { mergeChildrenByMaterial } from './meshUtils.js';

/**
 * TrafficVehicles
 * Fabrica de vehiculos NPC (autos, taxis, camiones y otros minibuses).
 * A diferencia del minibus del jugador, estos usan geometria y materiales
 * compartidos entre instancias (misma BoxGeometry/CylinderGeometry para
 * todos) para mantener el conteo de memoria bajo, tal como pide el
 * concepto ("geometrias reutilizables, evitar objetos innecesarios").
 */

// --- Geometrias compartidas (una sola instancia para todo el trafico) ---
const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.26, 10);
const tireMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });

// Faros y luces traseras compartidos: un solo cambio de intensidad
// enciende las luces de todo el trafico al anochecer.
const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff3c9, emissive: 0xffe7a8, emissiveIntensity: 0.3 });
const taillightMat = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xc0140c, emissiveIntensity: 0.4 });
const lightGeo = new THREE.BoxGeometry(0.32, 0.18, 0.06);

/** 0 = dia, 1 = noche. */
export function setTrafficNight(factor) {
  headlightMat.emissiveIntensity = 0.3 + factor * 3.2;
  taillightMat.emissiveIntensity = 0.4 + factor * 2.2;
}

function addLights(group, halfWidth, y, frontZ, rearZ) {
  for (const side of [-1, 1]) {
    const head = new THREE.Mesh(lightGeo, headlightMat);
    head.position.set(side * halfWidth, y, frontZ);
    group.add(head);
    const tail = new THREE.Mesh(lightGeo, taillightMat);
    tail.position.set(side * halfWidth, y, rearZ);
    group.add(tail);
  }
}

const CAR_PALETTE = [0xd8d8d8, 0xb03028, 0x2b5c8a, 0x2c2f33, 0xf2f0eb, 0x5a6270, 0x6d7f5a, 0x8a5a2b, 0x9aa6b2, 0x7a1f2e, 0x1f4d3a, 0xc9b27a];

// Materiales de pintura compartidos por color (pocas instancias, mas variedad visible).
const paintCache = new Map();
function paintMat(color, roughness = 0.5, metalness = 0.35) {
  const key = `${color}|${roughness}|${metalness}`;
  let m = paintCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: 1 });
    paintCache.set(key, m);
  }
  return m;
}
const glassNpcMat = new THREE.MeshStandardMaterial({ color: 0x141b24, roughness: 0.08, metalness: 0.85 });
const trimNpcMat = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.7, metalness: 0.2 });
const chromeNpcMat = new THREE.MeshStandardMaterial({ color: 0xaeb4ba, roughness: 0.3, metalness: 0.8 });
const hubMat = new THREE.MeshStandardMaterial({ color: 0xa9adb2, roughness: 0.35, metalness: 0.75 });
const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.28, 8);
const TRUCK_CABS = [0x3a6b8a, 0x9a3b2c, 0x3d6b4a, 0xc79a2b];
const TRUCK_BOXES = [0xd9d4c4, 0xbfc6cc, 0xd8c9a0, 0x8d9aa5];
const NPC_MINIBUS_COLORS = [0x3ea66b, 0x2b6fb3, 0xc0392b, 0xe08a1e, 0x8e44ad, 0x16a0a0];

function addWheels(group, halfWidth, wheelY, frontZ, rearZ) {
  const positions = [
    [-halfWidth, wheelY, frontZ],
    [halfWidth, wheelY, frontZ],
    [-halfWidth, wheelY, rearZ],
    [halfWidth, wheelY, rearZ],
  ];
  for (const [x, y, z] of positions) {
    const wheel = new THREE.Mesh(wheelGeo, tireMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, y, z);
    group.add(wheel);
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(x + Math.sign(x) * 0.01, y, z);
    group.add(hub);
  }
}

function buildCar(rng) {
  const group = new THREE.Group();
  const color = CAR_PALETTE[Math.floor(rng() * CAR_PALETTE.length)];
  const bodyMat = paintMat(color);
  // 0 = sedan, 1 = hatchback corto, 2 = SUV/vagoneta alta (todos caben en la misma caja de colision).
  const style = Math.floor(rng() * 3);
  const len = [3.9, 3.6, 3.95][style];
  const bodyH = [0.7, 0.72, 0.85][style];
  const cabinH = [0.52, 0.55, 0.62][style];
  const cabinLen = [1.9, 2.05, 2.5][style];
  const cabinZ = [-0.2, -0.3, -0.25][style];

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, bodyH, len), bodyMat);
  body.position.y = 0.38 + bodyH / 2;
  body.castShadow = true;
  group.add(body); // children[0]: el taxi le cambia el material

  const cabinY = 0.38 + bodyH + cabinH / 2 - 0.02;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.46, cabinH, cabinLen), glassNpcMat);
  cabin.position.set(0, cabinY, cabinZ);
  group.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.07, cabinLen - 0.3), bodyMat);
  roof.position.set(0, cabinY + cabinH / 2 + 0.03, cabinZ);
  roof.castShadow = true;
  group.add(roof);
  // Pilares: dan lectura de "ventanas" en vez de un bloque de vidrio liso.
  for (const pz of [cabinLen / 2 - 0.05, -cabinLen / 2 + 0.05, 0]) {
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.05, cabinH, 0.1), bodyMat);
      pillar.position.set(side * 0.73, cabinY, cabinZ + pz);
      group.add(pillar);
    }
  }
  // Parachoques y franja inferior oscura.
  const bumperGeo = new THREE.BoxGeometry(1.74, 0.22, 0.16);
  for (const sz of [1, -1]) {
    const bumper = new THREE.Mesh(bumperGeo, trimNpcMat);
    bumper.position.set(0, 0.5, sz * (len / 2 + 0.02));
    group.add(bumper);
  }
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.14, len - 0.5), trimNpcMat);
  skirt.position.set(0, 0.42, 0);
  group.add(skirt);

  addWheels(group, 0.82, 0.35, len / 2 - 0.65, -(len / 2 - 0.65));
  addLights(group, 0.58, 0.74, len / 2 + 0.01, -(len / 2 + 0.01));
  return group;
}

function buildTaxi(rng) {
  // Un auto normal pero pintado de amarillo con techo distintivo, para que
  // se reconozca como taxi a la distancia sin necesitar geometria nueva.
  const group = buildCar(rng);
  const bodyMesh = group.children[0];
  const taxiMat = paintMat(0xf5c518, 0.45, 0.3);
  group.children.forEach((c) => {
    if (c.material && c.material.color && c.material.color.getHex() !== 0x141b24 && c.material !== trimNpcMat && c.material !== hubMat && c.material !== tireMat && c.material !== headlightMat && c.material !== taillightMat) {
      c.material = taxiMat;
    }
  });
  bodyMesh.material = taxiMat;

  const roofSignMat = new THREE.MeshStandardMaterial({ color: 0xfff1b0, emissive: 0xffd24a, emissiveIntensity: 0.35, roughness: 0.5 });
  const roofSign = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.55), roofSignMat);
  roofSign.position.set(0, 1.72, -0.2);
  group.add(roofSign);
  return group;
}

function buildTruck(rng) {
  const group = new THREE.Group();
  const cabMat = paintMat(TRUCK_CABS[Math.floor(rng() * TRUCK_CABS.length)], 0.55, 0.25);
  const boxMat = paintMat(TRUCK_BOXES[Math.floor(rng() * TRUCK_BOXES.length)], 0.8, 0.05);
  const glassMat = glassNpcMat;

  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.5, 1.7), cabMat);
  cab.position.set(0, 0.95, 2.2);
  cab.castShadow = true;
  group.add(cab);

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.6, 0.08), glassMat);
  windshield.position.set(0, 1.35, 3.0);
  group.add(windshield);

  const cargo = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.1, 4.3), boxMat);
  cargo.position.set(0, 1.35, -1.0);
  cargo.castShadow = true;
  group.add(cargo);

  addWheels(group, 0.95, 0.42, 2.0, -0.3);
  addWheels(group, 0.95, 0.42, -1.9, -2.7);
  addLights(group, 0.75, 0.7, 3.06, -3.17);
  return group;
}

function buildNpcMinibus(rng) {
  // Version simplificada del minibus del jugador: misma silueta general
  // pero sin las texturas Canvas2D (mas barata de instanciar varias veces).
  const group = new THREE.Group();
  const color = NPC_MINIBUS_COLORS[Math.floor(rng() * NPC_MINIBUS_COLORS.length)];
  const bodyMat = paintMat(color, 0.6, 0.2);
  const roofMat = paintMat(0xe9e6dd, 0.7, 0.1);
  const glassMat = glassNpcMat;

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.3, 4.8), bodyMat);
  chassis.position.y = 1.0;
  chassis.castShadow = true;
  group.add(chassis);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.5, 4.3), roofMat);
  roof.position.set(0, 1.9, -0.1);
  group.add(roof);

  const windowStrip = new THREE.Mesh(new THREE.BoxGeometry(2.04, 0.55, 3.4), glassMat);
  windowStrip.position.set(0, 1.55, -0.2);
  group.add(windowStrip);

  // Franja blanca lateral y parachoques, como los minibuses de linea.
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.03, 0.14, 4.82), roofMat);
  stripe.position.y = 0.78;
  group.add(stripe);
  for (const sz of [1, -1]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.26, 0.2), chromeNpcMat);
    bumper.position.set(0, 0.5, sz * 2.45);
    group.add(bumper);
  }
  addWheels(group, 1.05, 0.42, 1.65, -1.55);
  addLights(group, 0.72, 0.85, 2.42, -2.42);
  return group;
}

const BUILDERS = { car: buildCar, taxi: buildTaxi, truck: buildTruck, minibus: buildNpcMinibus };
export const TRAFFIC_VEHICLE_KINDS = Object.keys(BUILDERS);

/**
 * Construye un vehiculo NPC del tipo pedido.
 * @param {'car'|'taxi'|'truck'|'minibus'} kind
 * @param {() => number} rng
 */
export function buildTrafficVehicle(kind, rng) {
  const builder = BUILDERS[kind] ?? buildCar;
  // Todas las piezas son rigidas: se fusionan por material (menos draw calls).
  const mesh = mergeChildrenByMaterial(builder(rng), (m) => m !== headlightMat && m !== taillightMat && m !== tireMat && m !== hubMat);
  mesh.name = `Traffic_${kind}`;
  return mesh;
}
