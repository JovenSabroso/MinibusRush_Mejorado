import * as THREE from 'three';
import { mulberry32 } from './rng.js';

const CROWD_SIZE = 32;
const HALF_WIDTH = 7.2; // mitad del ancho bloqueado (calle de 9 m + aceras)
const HALF_DEPTH = 1.9; // mitad de la profundidad de la multitud
const COLLIDE_HALF_DEPTH = 4.4; // incluye las piedras y llantas de cada lado
const ARRIVE_TIME = 4; // segundos que tarda la gente en tomar la calle
const ACTIVE_TIME = 50; // segundos que dura el bloqueo
const LEAVE_TIME = 5; // segundos que tarda en dispersarse
const MIN_DISTANCE = 32; // el bloqueo aparece al menos a esta distancia del jugador
const AVOID_RADIUS = 13; // no tapar paradas ni servicios
const PUSH_COOLDOWN = 2;
const HORN_COOLDOWN = 6;

// --- Geometrias y materiales compartidos ---
const GEO = {
  body: new THREE.CapsuleGeometry(0.22, 0.55, 4, 8),
  skirt: new THREE.ConeGeometry(0.42, 0.75, 10),
  shawl: new THREE.CylinderGeometry(0.26, 0.3, 0.3, 10),
  head: new THREE.SphereGeometry(0.16, 10, 10),
  hatCrown: new THREE.CylinderGeometry(0.1, 0.13, 0.2, 10),
  hatBrim: new THREE.CylinderGeometry(0.2, 0.2, 0.02, 12),
  helmet: new THREE.SphereGeometry(0.19, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
  arm: new THREE.BoxGeometry(0.09, 0.5, 0.09),
  fist: new THREE.SphereGeometry(0.07, 8, 6),
  rock: new THREE.DodecahedronGeometry(0.32),
  tire: new THREE.TorusGeometry(0.42, 0.16, 8, 16),
  flame: new THREE.ConeGeometry(0.45, 1.3, 8, 1, true),
  pole: new THREE.CylinderGeometry(0.035, 0.035, 1, 6),
  flag: new THREE.PlaneGeometry(1.3, 0.9),
  banner: new THREE.PlaneGeometry(6.4, 1.05),
};

const SKIN = 0xb87a4b;
const CLOTHES = [0x8e2c48, 0x2f6b5a, 0xc36a2d, 0x5b3f8c, 0x3b4a6b, 0x6d4a2f, 0x9b2222, 0x2e2e2e, 0x4a7a3a, 0xcfa23a];

// Colores de la wiphala; la diagonal blanca va de abajo-izquierda a arriba-derecha.
const WIPHALA = ['#d52b1e', '#f28a1b', '#f6d10f', '#ffffff', '#2f9e44', '#1d63b8', '#6b2c91'];

function createWiphalaTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 112;
  const ctx = canvas.getContext('2d');
  const cell = canvas.width / 7;
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 7; col++) {
      ctx.fillStyle = WIPHALA[(((row + col - 3) % 7) + 7) % 7];
      ctx.fillRect(col * cell, row * cell, cell + 1, cell + 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

function createBannerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 168;
  const ctx = canvas.getContext('2d');
  // Tela blanca pintada a mano.
  ctx.fillStyle = '#efe7d3';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#c4161c';
  ctx.lineWidth = 10;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#c4161c';
  ctx.font = '900 82px Bungee, Impact, "Arial Black", sans-serif';
  ctx.fillText('¡BLOQUEO!', canvas.width / 2, 64);
  ctx.fillStyle = '#1d1a18';
  ctx.font = '800 38px "Barlow Condensed", Impact, sans-serif';
  ctx.fillText('NO PASA NADIE · VECINOS EN LUCHA', canvas.width / 2, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const smoothstep = (k) => k * k * (3 - 2 * k);

/**
 * BlockadeSystem
 * Bloqueo de calle con gente: una multitud (cholitas, mineros con casco,
 * vecinos con el puno en alto) toma una calle por delante del minibus con
 * piedras, llantas ardiendo, wiphalas y una pancarta. Mientras dura, la
 * calle queda cerrada para el jugador y para el trafico NPC: hay que
 * buscar otra ruta. Toda la multitud se dibuja con InstancedMesh (pocas
 * draw calls aunque sean decenas de personas).
 */
export class BlockadeSystem {
  /**
   * @param {THREE.Vector3[]} avoidPoints - paradas y servicios que no se deben tapar
   */
  constructor(scene, city, { particles, avoidPoints = [] }) {
    this.particles = particles;
    this.avoidPoints = avoidPoints;
    this.rng = mulberry32(2024);

    // Lineas de calle (todas, incluidas las de borde) y centros de manzana.
    const lines = (n) => Array.from({ length: n + 1 }, (_, i) => (i - n / 2) * city.step);
    const centers = (n) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * city.step);
    this._streetsX = lines(city.blocksX);
    this._streetsZ = lines(city.blocksZ);
    this._centersX = centers(city.blocksX);
    this._centersZ = centers(city.blocksZ);

    this.state = 'idle'; // idle | arriving | active | leaving
    this._t = 0;
    this._time = 0;
    this.position = new THREE.Vector3();
    this.axis = 'z';
    this.streetCoord = 0;
    this.along = 0;

    this._approached = false;
    this._pushCooldown = 0;
    this._hornCooldown = 0;
    this._petardoTimer = 3;
    this._anger = 0;

    // Callbacks que conecta Game.
    this.onApproach = null; // () => void
    this.onPush = null; // (impact) => void
    this.onHonk = null; // () => void
    this.onPetardo = null; // (worldPos, distance) => void
    this.onLifted = null; // () => void

    this.group = new THREE.Group();
    this.group.name = 'Blockade';
    this.group.visible = false;
    scene.add(this.group);

    this._tmpM = new THREE.Matrix4();
    this._tmpM2 = new THREE.Matrix4();
    this._tmpQ = new THREE.Quaternion();
    this._tmpV = new THREE.Vector3();
    this._tmpS = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._localPlayer = new THREE.Vector3();

    this._buildCrowd();
    this._buildProps();
  }

  get active() {
    return this.state !== 'idle';
  }

  /** La multitud ya ocupa la calle (bloquea al jugador y al trafico). */
  get solid() {
    return (this.state === 'arriving' && this._t > ARRIVE_TIME * 0.45) || this.state === 'active' || (this.state === 'leaving' && this._t < LEAVE_TIME * 0.3);
  }

  // ------------------------------------------------------------------
  // Construccion
  // ------------------------------------------------------------------
  _buildCrowd() {
    const rng = this.rng;
    this.people = [];
    const parts = {
      body: [], skirt: [], shawl: [], head: [], brim: [], crown: [], helmet: [], arm: [], fist: [],
    };

    // Tres filas a lo ancho de la calle (y un poco sobre las aceras).
    const perRow = Math.ceil(CROWD_SIZE / 3);
    for (let i = 0; i < CROWD_SIZE; i++) {
      const row = i % 3;
      const slot = Math.floor(i / 3);
      const x = -HALF_WIDTH + 0.7 + (slot / (perRow - 1)) * (HALF_WIDTH * 2 - 1.4) + (rng() - 0.5) * 0.5;
      const z = (row - 1) * 1.15 + (rng() - 0.5) * 0.45;
      const side = x < 0 ? -1 : 1;
      const person = {
        slot: new THREE.Vector3(x, Math.abs(x) > 4.5 ? 0.22 : 0, z), // sobre la acera si queda fuera de la calzada
        spawn: new THREE.Vector3(side * (5.6 + rng() * 1.2), 0.22, (rng() < 0.5 ? -1 : 1) * (9 + rng() * 7)),
        baseYaw: row === 0 ? Math.PI : row === 2 ? 0 : rng() < 0.5 ? 0 : Math.PI,
        yaw: 0,
        scale: 0.92 + rng() * 0.16,
        phase: rng() * Math.PI * 2,
        delay: rng() * 1.2,
        pos: new THREE.Vector3(),
      };
      person.yaw = person.baseYaw;
      const clothes = new THREE.Color(CLOTHES[Math.floor(rng() * CLOTHES.length)]);
      const idx = this.people.length;
      const isCholita = rng() < 0.4;
      if (isCholita) {
        parts.skirt.push({ idx, color: clothes, local: new THREE.Matrix4().makeTranslation(0, 0.38, 0) });
        parts.shawl.push({ idx, color: new THREE.Color(CLOTHES[Math.floor(rng() * CLOTHES.length)]), local: new THREE.Matrix4().makeTranslation(0, 0.88, 0) });
        parts.brim.push({ idx, local: new THREE.Matrix4().makeTranslation(0, 1.28, 0) });
        parts.crown.push({ idx, local: new THREE.Matrix4().makeTranslation(0, 1.39, 0) });
      } else {
        parts.body.push({ idx, color: clothes, local: new THREE.Matrix4().makeTranslation(0, 0.68, 0) });
        if (rng() < 0.45) parts.helmet.push({ idx, local: new THREE.Matrix4().makeTranslation(0, 1.2, 0) });
      }
      parts.head.push({ idx, local: new THREE.Matrix4().makeTranslation(0, 1.16, 0) });
      if (rng() < 0.65) {
        person.armSide = rng() < 0.5 ? -1 : 1;
        parts.arm.push({ idx, color: clothes, arm: true });
        parts.fist.push({ idx, fist: true });
      }
      this.people.push(person);
    }

    const mats = {
      clothes: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
      skin: new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.7 }),
      hat: new THREE.MeshStandardMaterial({ color: 0x1d1a18, roughness: 0.6 }),
      helmet: new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.45, metalness: 0.1 }),
    };
    const make = (name, geo, mat, castShadow = false) => {
      const entries = parts[name];
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, entries.length));
      mesh.count = entries.length;
      mesh.castShadow = castShadow;
      mesh.frustumCulled = false; // las instancias se mueven: el bounding sphere quedaria viejo
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      entries.forEach((e, i) => e.color && mesh.setColorAt(i, e.color));
      this.group.add(mesh);
      return { mesh, entries };
    };
    this._parts = [
      make('body', GEO.body, mats.clothes, true),
      make('skirt', GEO.skirt, mats.clothes, true),
      make('shawl', GEO.shawl, mats.clothes),
      make('head', GEO.head, mats.skin),
      make('brim', GEO.hatBrim, mats.hat),
      make('crown', GEO.hatCrown, mats.hat),
      make('helmet', GEO.helmet, mats.helmet),
      make('arm', GEO.arm, mats.clothes),
      make('fist', GEO.fist, mats.skin),
    ];
  }

  _buildProps() {
    const rng = this.rng;
    this.props = new THREE.Group();
    this.group.add(this.props);
    const dummy = new THREE.Object3D();

    // Piedras: dos lineas atravesando la calle, una a cada lado de la gente.
    const rocks = [];
    for (const z of [-3.3, 3.3]) {
      for (let x = -4.3; x <= 4.3; x += 0.55 + rng() * 0.3) rocks.push({ x, z: z + (rng() - 0.5) * 0.5 });
    }
    const rockMesh = new THREE.InstancedMesh(GEO.rock, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }), rocks.length);
    rocks.forEach(({ x, z }, i) => {
      const s = 0.6 + rng() * 0.8;
      dummy.position.set(x, 0.12 * s, z);
      dummy.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      dummy.scale.set(s, s * (0.6 + rng() * 0.3), s);
      dummy.updateMatrix();
      rockMesh.setMatrixAt(i, dummy.matrix);
      const g = 0.38 + rng() * 0.25;
      rockMesh.setColorAt(i, new THREE.Color(g, g * 0.95, g * 0.9));
    });
    rockMesh.castShadow = rockMesh.receiveShadow = true;
    this.props.add(rockMesh);

    // Llantas apiladas y ardiendo (visibles desde ambos lados).
    this._fires = [];
    const tirePiles = [
      { x: -2.4, z: -3.9 },
      { x: 2.6, z: 3.9 },
      { x: 1.2, z: -4.1 },
      { x: -1.6, z: 4.2 },
    ];
    const tireMesh = new THREE.InstancedMesh(GEO.tire, new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 }), tirePiles.length * 3);
    const flameMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.35, 0.42, 0.08), transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide });
    tirePiles.forEach(({ x, z }, p) => {
      for (let k = 0; k < 3; k++) {
        dummy.position.set(x + (rng() - 0.5) * 0.12, 0.16 + k * 0.3, z + (rng() - 0.5) * 0.12);
        dummy.rotation.set(Math.PI / 2 + (rng() - 0.5) * 0.25, 0, rng() * 3);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        tireMesh.setMatrixAt(p * 3 + k, dummy.matrix);
      }
      const flame = new THREE.Mesh(GEO.flame, flameMat);
      flame.position.set(x, 1.15, z);
      this.props.add(flame);
      this._fires.push({ mesh: flame, local: new THREE.Vector3(x, 1.1, z), phase: rng() * 6 });
    });
    tireMesh.castShadow = true;
    this.props.add(tireMesh);

    // Pancarta sostenida por dos palos sobre la fila del medio (se lee de ambos lados).
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x6e4b2a, roughness: 0.9 });
    const bannerMat = new THREE.MeshStandardMaterial({ map: createBannerTexture(), roughness: 0.95 });
    this.banner = new THREE.Group();
    for (const rot of [0, Math.PI]) {
      const face = new THREE.Mesh(GEO.banner, bannerMat);
      face.rotation.y = rot;
      face.position.z = rot ? -0.01 : 0.01;
      this.banner.add(face);
    }
    for (const x of [-3.25, 3.25]) {
      const pole = new THREE.Mesh(GEO.pole, poleMat);
      pole.scale.y = 2.9;
      pole.position.set(x, -0.8, 0); // llega hasta el suelo
      this.banner.add(pole);
    }
    this.banner.position.set(0, 2.25, 0);
    this.props.add(this.banner);

    // Wiphalas flameando.
    const flagMat = new THREE.MeshStandardMaterial({ map: createWiphalaTexture(), roughness: 0.9, side: THREE.DoubleSide });
    this._flags = [];
    for (const { x, z } of [
      { x: -5.4, z: -1.2 },
      { x: -1.2, z: 1.3 },
      { x: 1.8, z: -1.1 },
      { x: 5.6, z: 1.0 },
    ]) {
      const holder = new THREE.Group();
      holder.position.set(x, 0, z);
      const pole = new THREE.Mesh(GEO.pole, poleMat);
      pole.scale.y = 3.6;
      pole.position.y = 1.8;
      holder.add(pole);
      const pivot = new THREE.Group();
      pivot.position.y = 3.1;
      const flag = new THREE.Mesh(GEO.flag, flagMat);
      flag.position.x = 0.67;
      pivot.add(flag);
      holder.add(pivot);
      this.props.add(holder);
      this._flags.push({ pivot, phase: rng() * 6 });
    }
  }

  // ------------------------------------------------------------------
  // Ciclo de vida
  // ------------------------------------------------------------------
  /**
   * Arma un bloqueo en una calle por delante del minibus (a media cuadra,
   * para que se pueda rodear por la manzana). Devuelve false si ya hay uno.
   */
  start(minibus) {
    if (this.active) return false;
    const spot = this._pickSpot(minibus);
    if (!spot) return false;

    this.axis = spot.axis;
    this.streetCoord = spot.street;
    this.along = spot.along;
    if (spot.axis === 'z') this.position.set(spot.street, 0, spot.along);
    else this.position.set(spot.along, 0, spot.street);
    this.group.position.copy(this.position);
    this.group.rotation.y = spot.axis === 'z' ? 0 : Math.PI / 2;
    this.group.updateMatrixWorld(true);

    this.state = 'arriving';
    this._t = 0;
    this._approached = false;
    this._anger = 0;
    this._petardoTimer = 2;
    for (const p of this.people) p.yaw = p.baseYaw;
    this.group.visible = true;
    this._updateCrowd(0, null);
    return true;
  }

  /** Quita el bloqueo al instante (inicio de jornada, volver al menu). */
  clear() {
    this.state = 'idle';
    this.group.visible = false;
  }

  _pickSpot(minibus) {
    const p = minibus.mesh.position;
    const fwd = this._tmpV.set(0, 0, 1).applyQuaternion(minibus.mesh.quaternion);
    let best = null;

    const consider = (axis, street, along) => {
      const x = axis === 'z' ? street : along;
      const z = axis === 'z' ? along : street;
      const dx = x - p.x;
      const dz = z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < MIN_DISTANCE) return;
      for (const a of this.avoidPoints) {
        if (Math.hypot(a.x - x, a.z - z) < AVOID_RADIUS) return;
      }
      const ahead = dx * fwd.x + dz * fwd.z;
      const lateral = axis === 'z' ? p.x : p.z;
      const travelAxis = Math.abs(fwd.z) >= Math.abs(fwd.x) ? 'z' : 'x';
      const onMyStreet = axis === travelAxis && Math.abs(street - lateral) < 6;
      // Preferir: por delante, en la misma calle, y no demasiado lejos.
      const score = dist + (ahead <= 0 ? 300 : 0) + (onMyStreet ? 0 : 60);
      if (!best || score < best.score) best = { axis, street, along, score };
    };

    for (const street of this._streetsX) for (const along of this._centersZ) consider('z', street, along);
    for (const street of this._streetsZ) for (const along of this._centersX) consider('x', street, along);
    return best;
  }

  // ------------------------------------------------------------------
  // Actualizacion
  // ------------------------------------------------------------------
  update(delta, minibus, input, collisionSystem) {
    if (!this.active) return;
    this._time += delta;
    this._t += delta;
    this._pushCooldown = Math.max(0, this._pushCooldown - delta);
    this._hornCooldown = Math.max(0, this._hornCooldown - delta);
    this._anger = Math.max(0, this._anger - delta * 0.35);

    if (this.state === 'arriving' && this._t >= ARRIVE_TIME) {
      this.state = 'active';
      this._t = 0;
    } else if (this.state === 'active' && this._t >= ACTIVE_TIME) {
      this.state = 'leaving';
      this._t = 0;
      if (this.onLifted) this.onLifted();
    } else if (this.state === 'leaving' && this._t >= LEAVE_TIME) {
      this.clear();
      return;
    }

    const playerPos = minibus?.mesh.position;
    const distance = playerPos ? Math.hypot(playerPos.x - this.position.x, playerPos.z - this.position.z) : Infinity;

    if (minibus && this.state !== 'leaving') {
      if (!this._approached && distance < 42) {
        this._approached = true;
        if (this.onApproach) this.onApproach();
      }
      if (input?.horn && distance < 30 && this._hornCooldown <= 0) {
        this._hornCooldown = HORN_COOLDOWN;
        this._anger = Math.min(1, this._anger + 0.6);
        if (this.onHonk) this.onHonk();
      }
    }

    // La multitud no se deja pasar: se resuelve como una pared blanda.
    if (minibus && collisionSystem && this.solid) {
      const r = this.rect;
      const impact = collisionSystem.resolveAgainstRect(minibus, r.minX, r.minZ, r.maxX, r.maxZ);
      if (impact > 0.8 && this._pushCooldown <= 0) {
        this._pushCooldown = PUSH_COOLDOWN;
        this._anger = 1;
        if (this.onPush) this.onPush(impact);
      }
    }

    // Petardos de vez en cuando (solo si el jugador esta cerca para oirlos).
    if (this.state === 'active') {
      this._petardoTimer -= delta;
      if (this._petardoTimer <= 0) {
        this._petardoTimer = 2.5 + this.rng() * 3.5;
        if (distance < 80 && this.onPetardo) {
          const local = this._tmpV.set((this.rng() - 0.5) * HALF_WIDTH * 1.6, 0.2, (this.rng() < 0.5 ? -1 : 1) * (HALF_DEPTH + 1.8));
          this.onPetardo(this.group.localToWorld(local).clone(), distance);
        }
      }
    }

    this._updateCrowd(delta, distance < 45 ? playerPos : null);
    this._updateProps(delta, distance);
  }

  /** El trafico NPC frena antes del bloqueo mientras la gente esta (o va llegando). */
  get blocksTraffic() {
    return this.state === 'arriving' || this.state === 'active';
  }

  get halfDepth() {
    return COLLIDE_HALF_DEPTH;
  }

  /** Rectangulo XZ (mundo) que ocupa el bloqueo (gente + piedras + llantas). */
  get rect() {
    const p = this.position;
    const d = COLLIDE_HALF_DEPTH;
    if (this.axis === 'z') return { minX: p.x - HALF_WIDTH, maxX: p.x + HALF_WIDTH, minZ: p.z - d, maxZ: p.z + d };
    return { minX: p.x - d, maxX: p.x + d, minZ: p.z - HALF_WIDTH, maxZ: p.z + HALF_WIDTH };
  }

  _updateCrowd(delta, playerPos) {
    const t = this._time;
    if (playerPos) this._localPlayer.copy(playerPos);
    const local = playerPos ? this.group.worldToLocal(this._localPlayer) : null;
    const energy = 1 + this._anger * 1.5;

    for (const person of this.people) {
      let k = 1; // 0 = en la acera lejos, 1 = en su lugar del bloqueo
      if (this.state === 'arriving') k = Math.min(1, Math.max(0, (this._t - person.delay) / (ARRIVE_TIME - 1.3)));
      else if (this.state === 'leaving') k = 1 - Math.min(1, Math.max(0, (this._t - person.delay * 0.6) / (LEAVE_TIME - 1)));
      const e = smoothstep(k);
      const walking = k > 0 && k < 1;

      person.pos.lerpVectors(person.spawn, person.slot, e);
      let targetYaw;
      if (walking) {
        const dir = this.state === 'leaving' ? -1 : 1;
        targetYaw = Math.atan2((person.slot.x - person.spawn.x) * dir, (person.slot.z - person.spawn.z) * dir);
        person.pos.y += Math.abs(Math.sin(t * 9 + person.phase)) * 0.1;
      } else {
        targetYaw = local ? Math.atan2(local.x - person.pos.x, local.z - person.pos.z) : person.baseYaw;
        // Saltitos al ritmo de la consigna; mas fuertes si estan enojados.
        person.pos.y += Math.max(0, Math.sin(t * 5.5 * (0.8 + this._anger * 0.4) + person.phase)) * 0.09 * energy;
      }
      let dy = targetYaw - person.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      person.yaw += dy * Math.min(1, delta * 5);
    }

    for (const { mesh, entries } of this._parts) {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const person = this.people[entry.idx];
        this._tmpQ.setFromAxisAngle(this._yAxis, person.yaw);
        this._tmpM.compose(person.pos, this._tmpQ, this._tmpS.setScalar(person.scale));
        if (entry.arm || entry.fist) {
          // Puno en alto que sube y baja.
          const pump = Math.sin(t * 6 * energy + person.phase);
          const angle = -person.armSide * (0.25 + pump * 0.12 * energy);
          const lift = 0.05 + Math.max(0, pump) * 0.08 * energy;
          this._tmpM2.makeRotationZ(angle);
          this._tmpM2.setPosition(person.armSide * 0.24, 1.18 + lift, 0);
          this._tmpM.multiply(this._tmpM2);
          this._tmpM2.makeTranslation(0, entry.fist ? 0.29 : 0.0, 0);
        } else {
          this._tmpM2.copy(entry.local);
        }
        this._tmpM.multiply(this._tmpM2);
        mesh.setMatrixAt(i, this._tmpM);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  _updateProps(delta, distance) {
    const t = this._time;
    const fireOn = this.state === 'active' || (this.state === 'arriving' && this._t > 1.5) || (this.state === 'leaving' && this._t < LEAVE_TIME - 1);
    for (const fire of this._fires) {
      fire.mesh.visible = fireOn;
      if (!fireOn) continue;
      const f = 0.85 + Math.sin(t * 17 + fire.phase) * 0.1 + Math.sin(t * 29 + fire.phase * 2) * 0.07;
      fire.mesh.scale.set(f, 0.6 + (1 - f) * 1.5 + Math.sin(t * 11 + fire.phase) * 0.1, f);
      fire.mesh.rotation.y = t * 1.3 + fire.phase;
      if (distance < 110 && this.particles) {
        this.particles.burningTire(delta, this.group.localToWorld(this._tmpV.copy(fire.local)));
      }
    }
    for (const flag of this._flags) {
      flag.pivot.rotation.y = Math.sin(t * 2.2 + flag.phase) * 0.45;
      flag.pivot.rotation.z = Math.sin(t * 3.1 + flag.phase) * 0.05;
    }
    // La pancarta se mece un poco con la gente.
    this.banner.rotation.z = Math.sin(t * 1.7) * 0.03;
    this.banner.position.y = 2.25 + Math.max(0, Math.sin(t * 5.5)) * 0.05;
  }
}
