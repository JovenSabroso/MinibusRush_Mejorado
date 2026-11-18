import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './rng.js';
import {
  createFacadeTextures,
  createRawBrickTexture,
  createAsphaltTexture,
  createSidewalkTexture,
  createCholetTextures,
  createBillboardTexture,
  createRadialGlowTexture,
} from './cityTextures.js';

const BUILDING_COLORS = [0xe8452c, 0x2b6fb3, 0x3ea66b, 0xf5b400, 0x8e44ad, 0xd35400, 0x16a085, 0xc0392b, 0xe67e22, 0xf2e6c9, 0x7fb3d5];
const AWNING_COLORS = [0xe8452c, 0x2b6fb3, 0x3ea66b, 0xf5b400, 0xffffff, 0x8e44ad];

// Paletas de cholet (arquitectura neoandina): saturadas y contrastantes.
const CHOLET_PALETTES = [
  ['#2fb6c9', '#ff3d7f', '#ffd23f', '#7b2ff7', '#14213d'],
  ['#ff6b35', '#2ec4b6', '#ffbf00', '#e71d36', '#011627'],
  ['#8338ec', '#3a86ff', '#ffbe0b', '#fb5607', '#1b1b3a'],
  ['#06d6a0', '#ef476f', '#ffd166', '#118ab2', '#073b4c'],
];
const NEON_COLORS = [0x00e5ff, 0xff2bd6, 0xffe600, 0x39ff14, 0xff5a1f];

// Letreros de azotea con sabor local (nombres inventados, ninguna marca real).
const BILLBOARDS = [
  ['SALTEÑAS', 'Doña Flora · jugosas desde las 7:00', '#f2b705', '#1b1b1b'],
  ['API CON PASTEL', 'Calientito en la Ceja', '#7b2ff7', '#fff1d6'],
  ['FOTOCOPIAS', 'Anillados · Empastados · Tipeos', '#e8452c', '#ffffff'],
  ['SALÓN DE EVENTOS', 'Prestes · Bodas · Quinceañeros', '#14213d', '#ffd23f'],
  ['RADIO ILLAMPU', 'La que suena en tu minibús', '#2ec4b6', '#011627'],
];

// Manzanas especiales por indice [ix, iz] de la grilla 5x5.
const SPECIAL_BLOCKS = {
  '1,4': 'gas',
  '4,1': 'garage',
  '2,0': 'market',
  '0,2': 'cholet',
  '3,1': 'cholet',
  '4,4': 'cholet',
  '1,3': 'cholet',
};

// Estaciones (extremos) y torres del teleferico.
const CABLE_ANCHORS = [
  { x: -190, z: 190, h: 44 },
  { x: -112, z: 116, h: 50 },
  { x: 116, z: -112, h: 50 },
  { x: 186, z: -182, h: 44 },
];

const GROUND_Y = 0.22; // altura de la acera
const UP = new THREE.Vector3(0, 1, 0);

/** BoxGeometry cuyas UV se repiten segun el tamano real (texturas en metros). */
function tiledBox(w, h, d, tileW, tileH, uOffset = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4); // px, nx, py, ny, pz, nz
    let su;
    let sv;
    if (face === 0 || face === 1) {
      su = d / tileW;
      sv = h / tileH;
    } else if (face === 4 || face === 5) {
      su = w / tileW;
      sv = h / tileH;
    } else {
      su = w / tileW;
      sv = d / tileW;
    }
    uv.setXY(i, uv.getX(i) * su + uOffset, uv.getY(i) * sv);
  }
  return geo;
}

/**
 * Acumula geometria estatica por material y al final la fusiona en una sola
 * malla por material. Cientos de piezas (edificios, techos, tanques,
 * varillas) terminan en unas pocas draw calls.
 */
class StaticBatcher {
  constructor() {
    this.buckets = new Map(); // material -> { geos, cast, receive }
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
  }

  add(geometry, material, position, { rotation = null, cast = true, receive = true, owned = true } = {}) {
    if (rotation) this._q.setFromEuler(rotation);
    else this._q.identity();
    this._m.compose(position, this._q, this._s);
    const g = (owned ? geometry : geometry.clone()).applyMatrix4(this._m);
    let bucket = this.buckets.get(material);
    if (!bucket) {
      bucket = { geos: [], cast: false, receive: false };
      this.buckets.set(material, bucket);
    }
    bucket.geos.push(g);
    bucket.cast ||= cast;
    bucket.receive ||= receive;
  }

  build(parent) {
    for (const [material, bucket] of this.buckets) {
      const merged = mergeGeometries(bucket.geos, false);
      for (const g of bucket.geos) g.dispose();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = bucket.cast;
      mesh.receiveShadow = bucket.receive;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
    }
    this.buckets.clear();
  }
}

/**
 * City
 * Genera de forma procedural un barrio ficticio inspirado en La Paz / El Alto:
 * manzanas con casas de varios pisos (muchas "a medio construir"), cholets
 * con neon, un mercado, letreros de azotea, faroles, marcas viales, la
 * ciudad que sigue hasta el horizonte, la cordillera con el Illimani y el
 * teleferico cruzando el cielo.
 */
export class City {
  constructor(scene, collisionSystem) {
    this.scene = scene;
    this.collisionSystem = collisionSystem;
    this.group = new THREE.Group();
    this.group.name = 'City';

    this._rng = mulberry32(1337);
    this._cableCars = [];
    this._batch = new StaticBatcher();

    // --- Parametros de la grilla urbana ---
    this.blocksX = 5;
    this.blocksZ = 5;
    this.blockSize = 24;
    this.streetWidth = 9;
    this.step = this.blockSize + this.streetWidth;

    this.halfExtentX = (this.blocksX * this.step) / 2;
    this.halfExtentZ = (this.blocksZ * this.step) / 2;

    // Datos para el minimapa y los servicios.
    this.minimapBlocks = []; // { x, z, size, type }
    this.serviceSpots = {};

    // Materiales que cambian de dia a noche (ver setNight).
    this._windowMats = [];
    this._neonMats = [];
    this._billboardMats = [];

    this._createSharedMaterials();
    this._buildGround();
    this._buildBlocks();
    this._buildRoadMarkings();
    this._buildStreetlights();
    this._buildStreetDetails();
    this._buildOuterCity();
    this._buildMountains();
    this._buildCableCar();
    this._buildBoundaryColliders();

    this._batch.build(this.group);
    scene.add(this.group);
  }

  _createSharedMaterials() {
    const facade = createFacadeTextures();
    this._facadeMats = BUILDING_COLORS.map((color) => {
      const mat = new THREE.MeshStandardMaterial({
        color,
        map: facade.map,
        emissiveMap: facade.emissiveMap,
        emissive: 0xffffff,
        emissiveIntensity: 0,
        roughness: 0.85,
        metalness: 0.02,
      });
      this._windowMats.push(mat);
      return mat;
    });
    this._facadeTextures = facade;

    this._rawMats = [createRawBrickTexture('ladrillo'), createRawBrickTexture('bloque')].map(
      (map) => new THREE.MeshStandardMaterial({ map, roughness: 0.97, metalness: 0 })
    );

    this._mat = {
      roof: new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.95 }),
      tank: new THREE.MeshStandardMaterial({ color: 0x2f5f8f, roughness: 0.55, metalness: 0.2 }),
      rebar: new THREE.MeshStandardMaterial({ color: 0x4a3226, roughness: 0.8, metalness: 0.4 }),
      pole: new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.6, metalness: 0.4 }),
      white: new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.8 }),
      darkGlass: new THREE.MeshStandardMaterial({ color: 0x18222c, roughness: 0.2, metalness: 0.6 }),
      mirror: new THREE.MeshStandardMaterial({ color: 0x8fc6dc, roughness: 0.12, metalness: 0.9 }),
      redRoof: new THREE.MeshStandardMaterial({ color: 0xb33a2a, roughness: 0.7, flatShading: true }),
      stallTable: new THREE.MeshStandardMaterial({ color: 0x7a5233, roughness: 0.9 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0x77767a, roughness: 0.95 }),
    };
    this._awningMats = AWNING_COLORS.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.75 }));
    this._neonByColor = NEON_COLORS.map((color) => {
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, roughness: 0.4 });
      this._neonMats.push(mat);
      return mat;
    });
  }

  _buildGround() {
    // Tierra del altiplano alrededor; asfalto solo dentro de la ciudad.
    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshStandardMaterial({ color: 0x5c5046, roughness: 1 })
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.02;
    outer.receiveShadow = true;
    this.group.add(outer);

    const size = (this.halfExtentX + this.streetWidth + 6) * 2;
    const asphaltMap = createAsphaltTexture();
    asphaltMap.repeat.set(size / 16, size / 16);
    this.asphaltMat = new THREE.MeshStandardMaterial({ map: asphaltMap, roughness: 0.95, metalness: 0.0 });
    const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.asphaltMat);
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.receiveShadow = true;
    this.group.add(asphalt);
  }

  _blockCenter(ix, iz) {
    return {
      cx: (ix - (this.blocksX - 1) / 2) * this.step,
      cz: (iz - (this.blocksZ - 1) / 2) * this.step,
    };
  }

  _buildBlocks() {
    const sidewalkMap = createSidewalkTexture();
    sidewalkMap.repeat.set(this.blockSize / 4, this.blockSize / 4);
    const sidewalkTop = new THREE.MeshStandardMaterial({ map: sidewalkMap, roughness: 0.9 });
    const curb = new THREE.MeshStandardMaterial({ color: 0x9d9a93, roughness: 0.9 });

    const sidewalkBlocks = [];
    for (let ix = 0; ix < this.blocksX; ix++) {
      for (let iz = 0; iz < this.blocksZ; iz++) {
        const { cx, cz } = this._blockCenter(ix, iz);
        const type = SPECIAL_BLOCKS[`${ix},${iz}`] ?? 'houses';
        this.minimapBlocks.push({ x: cx, z: cz, size: this.blockSize, type });

        if (type === 'gas' || type === 'garage') {
          this._buildServiceLot(cx, cz, type);
          continue;
        }

        sidewalkBlocks.push({ cx, cz });
        if (type === 'cholet') this._buildCholet(cx, cz);
        else if (type === 'market') this._buildMarket(cx, cz);
        else this._buildHousesOnBlock(cx, cz);
      }
    }

    // Aceras: una sola InstancedMesh para todas las manzanas.
    const sidewalkGeo = new THREE.BoxGeometry(this.blockSize, GROUND_Y, this.blockSize);
    const sidewalks = new THREE.InstancedMesh(sidewalkGeo, [curb, curb, sidewalkTop, curb, curb, curb], sidewalkBlocks.length);
    const dummy = new THREE.Object3D();
    sidewalkBlocks.forEach(({ cx, cz }, i) => {
      dummy.position.set(cx, GROUND_Y / 2, cz);
      dummy.updateMatrix();
      sidewalks.setMatrixAt(i, dummy.matrix);
    });
    sidewalks.receiveShadow = true;
    this.group.add(sidewalks);

    this._placeBillboards();
  }

  // ---------------------------------------------------------------
  // Casas comunes (2x2 lotes por manzana, a veces una sola edificacion)
  // ---------------------------------------------------------------
  _buildHousesOnBlock(cx, cz) {
    const rng = this._rng;
    const margin = 3.4;
    const inner = this.blockSize - margin * 2; // 17.2m utiles

    if (rng() < 0.25) {
      const w = inner * (0.75 + rng() * 0.2);
      const d = inner * (0.75 + rng() * 0.2);
      this._buildHouse(cx, cz, w, d, 10 + rng() * 14);
      return;
    }

    const half = inner / 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        if (rng() < 0.08) continue; // lote baldio
        const w = half - 0.4 - rng() * 1.5;
        const d = half - 0.4 - rng() * 1.5;
        const x = cx + sx * (half / 2 + (half - w) / 2 - 0.2) * 1;
        const z = cz + sz * (half / 2 + (half - d) / 2 - 0.2) * 1;
        this._buildHouse(x, z, w, d, 4.5 + rng() * 17);
      }
    }
  }

  _buildHouse(x, z, w, d, height) {
    const rng = this._rng;
    const b = this._batch;
    const facadeMat = this._facadeMats[Math.floor(rng() * this._facadeMats.length)];

    // Los edificios altos se ven "a medio construir": planta baja pintada y
    // pisos superiores en ladrillo/bloque crudo (muy tipico de El Alto).
    const isUnfinished = height > 9 && rng() < 0.75;
    const paintedHeight = isUnfinished ? Math.max(3.2, height * (0.3 + rng() * 0.2)) : height;
    const uOffset = Math.floor(rng() * 4) * 0.25;

    b.add(tiledBox(w, paintedHeight, d, 12, 12, uOffset), facadeMat, new THREE.Vector3(x, GROUND_Y + paintedHeight / 2, z));

    if (isUnfinished) {
      const rawHeight = height - paintedHeight;
      const rawMat = this._rawMats[Math.floor(rng() * this._rawMats.length)];
      const geo = tiledBox(w * 0.985, rawHeight, d * 0.985, 12, 12, uOffset);
      // Desplaza V para que los vanos del ladrillo no queden cortados en la union.
      b.add(geo, rawMat, new THREE.Vector3(x, GROUND_Y + paintedHeight + rawHeight / 2, z));
    }

    // Cornisa y zocalo: dan relieve a la fachada (sombra y borde visibles).
    b.add(new THREE.BoxGeometry(w * 1.04, 0.22, d * 1.04), this._mat.white, new THREE.Vector3(x, GROUND_Y + Math.min(paintedHeight, 3.2), z), { cast: false });
    b.add(new THREE.BoxGeometry(w * 1.015, 0.7, d * 1.015), this._mat.concrete, new THREE.Vector3(x, GROUND_Y + 0.35, z), { cast: false });

    // Losa superior.
    const topY = GROUND_Y + height;
    b.add(new THREE.BoxGeometry(w * 1.02, 0.35, d * 1.02), this._mat.roof, new THREE.Vector3(x, topY + 0.17, z), { cast: false });

    // Tanque de agua en la azotea (detalle tipico del skyline paceno/alteno).
    if (rng() > 0.4) {
      b.add(new THREE.CylinderGeometry(0.6, 0.6, 1.2, 10), this._mat.tank, new THREE.Vector3(x + w * 0.25, topY + 0.95, z - d * 0.25));
    }

    // Varillas de fierro: senal de que la construccion "seguira" algun dia.
    if (isUnfinished) {
      const count = 3 + Math.floor(rng() * 5);
      for (let i = 0; i < count; i++) {
        const rodHeight = 0.6 + rng() * 1.0;
        b.add(
          new THREE.CylinderGeometry(0.04, 0.04, rodHeight, 4),
          this._mat.rebar,
          new THREE.Vector3(x + (rng() - 0.5) * w * 0.8, topY + 0.35 + rodHeight / 2, z + (rng() - 0.5) * d * 0.8),
          { rotation: new THREE.Euler((rng() - 0.5) * 0.3, 0, (rng() - 0.5) * 0.3), cast: false }
        );
      }
    }

    // Toldo de tienda en planta baja hacia algun lado.
    if (rng() < 0.55) {
      const side = Math.floor(rng() * 4);
      const mat = this._awningMats[Math.floor(rng() * this._awningMats.length)];
      const along = side < 2 ? w * 0.6 : d * 0.6;
      const geo = new THREE.BoxGeometry(along, 0.08, 1.1);
      const rot = new THREE.Euler(0.25, side < 2 ? 0 : Math.PI / 2, 0, 'YXZ');
      const pos = new THREE.Vector3(x, GROUND_Y + 2.7, z);
      if (side === 0) pos.z += d / 2 + 0.5;
      else if (side === 1) {
        pos.z -= d / 2 + 0.5;
        rot.y = Math.PI;
      } else if (side === 2) {
        pos.x += w / 2 + 0.5;
      } else {
        pos.x -= w / 2 + 0.5;
        rot.y = -Math.PI / 2;
      }
      b.add(geo, mat, pos, { rotation: rot });
    }

    this.collisionSystem.addStaticBox(
      new THREE.Box3(new THREE.Vector3(x - w / 2, 0, z - d / 2), new THREE.Vector3(x + w / 2, paintedHeight, z + d / 2))
    );

    this._billboardCandidates ??= [];
    if (height > 13) this._billboardCandidates.push({ x, z, w, d, topY });
  }

  // ---------------------------------------------------------------
  // Cholet: salon de eventos neoandino con "chalet" en la azotea
  // ---------------------------------------------------------------
  _buildCholet(cx, cz) {
    const rng = this._rng;
    const b = this._batch;
    const palette = CHOLET_PALETTES[this.minimapBlocks.filter((m) => m.type === 'cholet').length % CHOLET_PALETTES.length];
    const tex = createCholetTextures(palette);
    const facadeMat = new THREE.MeshStandardMaterial({
      map: tex.map,
      emissiveMap: tex.emissiveMap,
      emissive: 0xffffff,
      emissiveIntensity: 0.15,
      roughness: 0.55,
    });
    this._neonMats.push(facadeMat);

    const w = 15;
    const d = 15;
    const baseH = 4;
    const midH = 9 + rng() * 3;
    const glassH = 2.2;

    // Planta baja: vitrinas oscuras + franja de neon.
    b.add(new THREE.BoxGeometry(w, baseH, d), this._mat.darkGlass, new THREE.Vector3(cx, GROUND_Y + baseH / 2, cz));
    const neonA = this._neonByColor[Math.floor(rng() * this._neonByColor.length)];
    const neonB = this._neonByColor[Math.floor(rng() * this._neonByColor.length)];
    b.add(new THREE.BoxGeometry(w + 0.3, 0.25, d + 0.3), neonA, new THREE.Vector3(cx, GROUND_Y + baseH - 0.2, cz), { cast: false });

    // Cuerpo con la fachada neoandina (la textura cubre cada cara una vez).
    const midY = GROUND_Y + baseH + midH / 2;
    b.add(tiledBox(w + 0.4, midH, d + 0.4, w + 0.4, midH), facadeMat, new THREE.Vector3(cx, midY, cz));

    // Franja de vidrio espejado y remate.
    const glassY = GROUND_Y + baseH + midH + glassH / 2;
    b.add(new THREE.BoxGeometry(w, glassH, d), this._mat.mirror, new THREE.Vector3(cx, glassY, cz));
    b.add(new THREE.BoxGeometry(w + 0.6, 0.3, d + 0.6), neonB, new THREE.Vector3(cx, glassY + glassH / 2 + 0.15, cz), { cast: false });

    // Aristas verticales de neon.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.add(
          new THREE.BoxGeometry(0.28, midH + glassH, 0.28),
          neonA,
          new THREE.Vector3(cx + sx * (w / 2 + 0.25), GROUND_Y + baseH + (midH + glassH) / 2, cz + sz * (d / 2 + 0.25)),
          { cast: false }
        );
      }
    }

    // El "chalet" de la azotea: casita blanca con techo a cuatro aguas.
    const roofBase = GROUND_Y + baseH + midH + glassH + 0.3;
    b.add(new THREE.BoxGeometry(7, 3.2, 7), this._mat.white, new THREE.Vector3(cx, roofBase + 1.6, cz));
    b.add(new THREE.ConeGeometry(5.6, 2.6, 4), this._mat.redRoof, new THREE.Vector3(cx, roofBase + 3.2 + 1.3, cz), {
      rotation: new THREE.Euler(0, Math.PI / 4, 0),
    });

    this.collisionSystem.addStaticBox(
      new THREE.Box3(new THREE.Vector3(cx - w / 2 - 0.4, 0, cz - d / 2 - 0.4), new THREE.Vector3(cx + w / 2 + 0.4, baseH, cz + d / 2 + 0.4))
    );
  }

  // ---------------------------------------------------------------
  // Mercado: nave baja + filas de puestos con toldos de colores
  // ---------------------------------------------------------------
  _buildMarket(cx, cz) {
    const rng = this._rng;
    const b = this._batch;

    const hallW = 11;
    const hallD = 12;
    const hallH = 5.5;
    const hallX = cx + 2.5; // corrida al este: la parada esta en la vereda oeste
    b.add(tiledBox(hallW, hallH, hallD, 12, 12), this._facadeMats[9], new THREE.Vector3(hallX, GROUND_Y + hallH / 2, cz));
    b.add(new THREE.BoxGeometry(hallW + 2, 0.4, hallD + 2), this._mat.redRoof, new THREE.Vector3(hallX, GROUND_Y + hallH + 0.2, cz));
    this.collisionSystem.addStaticBox(
      new THREE.Box3(new THREE.Vector3(hallX - hallW / 2, 0, cz - hallD / 2), new THREE.Vector3(hallX + hallW / 2, hallH, cz + hallD / 2))
    );

    // Puestos sobre las veredas norte y sur (lejos de la parada oeste).
    const tableGeo = new THREE.BoxGeometry(1.8, 0.9, 1.1);
    const canopyGeo = new THREE.BoxGeometry(2.2, 0.06, 1.7);
    for (const sz of [-1, 1]) {
      const rowZ = cz + sz * 9.6;
      for (let i = 0; i < 6; i++) {
        const x = cx - 4 + i * 2.4;
        b.add(tableGeo.clone(), this._mat.stallTable, new THREE.Vector3(x, GROUND_Y + 0.45, rowZ));
        b.add(canopyGeo.clone(), this._awningMats[Math.floor(rng() * this._awningMats.length)], new THREE.Vector3(x, GROUND_Y + 2.3, rowZ), {
          rotation: new THREE.Euler(sz * 0.18, 0, 0),
        });
        for (const px of [-1, 1]) {
          b.add(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 5), this._mat.pole, new THREE.Vector3(x + px * 1.0, GROUND_Y + 1.1, rowZ + sz * 0.7), { cast: false });
        }
      }
      this.collisionSystem.addStaticBox(
        new THREE.Box3(new THREE.Vector3(cx - 5.2, 0, rowZ - 0.9), new THREE.Vector3(cx + 9.2, 2, rowZ + 0.9))
      );
    }
  }

  // ---------------------------------------------------------------
  // Lotes de servicio (gasolinera / taller): sin acera elevada
  // ---------------------------------------------------------------
  _buildServiceLot(cx, cz, type) {
    const pad = new THREE.BoxGeometry(this.blockSize, 0.04, this.blockSize);
    this._batch.add(pad, this._mat.concrete, new THREE.Vector3(cx, 0.02, cz), { cast: false });
    if (type === 'gas') {
      this.serviceSpots.gas = new THREE.Vector3(cx, 0, cz);
    } else {
      // El taller queda al fondo del lote, con el porton (-Z) mirando a la calle.
      this.serviceSpots.garage = new THREE.Vector3(cx, 0, cz + 6);
    }
  }

  _placeBillboards() {
    const candidates = this._billboardCandidates ?? [];
    const step = Math.max(1, Math.floor(candidates.length / BILLBOARDS.length));
    BILLBOARDS.forEach(([title, subtitle, bg, fg], i) => {
      const spot = candidates[i * step];
      if (!spot) return;
      const tex = createBillboardTexture(title, subtitle, bg, fg);
      const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.6 });
      this._billboardMats.push(mat);

      const board = new THREE.Mesh(new THREE.PlaneGeometry(7, 2.6), mat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(7.2, 2.8, 0.15), this._mat.pole);
      const holder = new THREE.Group();
      holder.position.set(spot.x, spot.topY + 3.2, spot.z);
      holder.rotation.y = (i % 4) * (Math.PI / 2);
      board.position.z = 0.09;
      holder.add(back, board);
      for (const px of [-2.6, 2.6]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.0, 0.15), this._mat.pole);
        post.position.set(px, -2.2, -0.1);
        holder.add(post);
      }
      this.group.add(holder);
    });
  }

  // ---------------------------------------------------------------
  // Marcas viales: lineas discontinuas y pasos de cebra (instanciados)
  // ---------------------------------------------------------------
  _streetLines() {
    const lines = [];
    for (let i = 0; i <= this.blocksX; i++) lines.push(-this.halfExtentX + i * this.step);
    return lines; // incluye las calles de borde
  }

  _buildRoadMarkings() {
    const lines = this._streetLines();
    const half = this.streetWidth / 2;
    const dashLen = 1.8;
    const dashGap = 1.6;
    const dummy = new THREE.Object3D();

    const dashes = [];
    for (const c of lines) {
      for (let s = 0; s < lines.length - 1; s++) {
        const start = lines[s] + half + 2.8; // deja libre el paso de cebra
        const end = lines[s + 1] - half - 2.8;
        for (let p = start; p + dashLen <= end; p += dashLen + dashGap) {
          dashes.push({ x: c, z: p + dashLen / 2, rot: 0 });
          dashes.push({ x: p + dashLen / 2, z: c, rot: Math.PI / 2 });
        }
      }
    }
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xf2d24b, roughness: 0.7 });
    const dashMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.22, dashLen), dashMat, dashes.length);
    dashes.forEach((dsh, i) => {
      dummy.position.set(dsh.x, 0.015, dsh.z);
      dummy.rotation.set(-Math.PI / 2, 0, dsh.rot);
      dummy.updateMatrix();
      dashMesh.setMatrixAt(i, dummy.matrix);
    });
    dashMesh.receiveShadow = true;
    this.group.add(dashMesh);

    // Pasos de cebra en cada acceso a un cruce.
    const bars = [];
    const barCount = 6;
    for (const x of lines) {
      for (const z of lines) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ax = x + dx * (half + 1.3);
          const az = z + dz * (half + 1.3);
          if (Math.abs(ax) > this.halfExtentX + 1 || Math.abs(az) > this.halfExtentZ + 1) continue;
          for (let k = 0; k < barCount; k++) {
            const off = -half + 0.9 + k * ((this.streetWidth - 1.8) / (barCount - 1));
            if (dx !== 0) bars.push({ x: ax, z: z + off, rot: Math.PI / 2 });
            else bars.push({ x: x + off, z: az, rot: 0 });
          }
        }
      }
    }
    const barMat = new THREE.MeshStandardMaterial({ color: 0xe9e6dd, roughness: 0.8 });
    const barMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.6, 2.2), barMat, bars.length);
    bars.forEach((bar, i) => {
      dummy.position.set(bar.x, 0.016, bar.z);
      dummy.rotation.set(-Math.PI / 2, 0, bar.rot);
      dummy.updateMatrix();
      barMesh.setMatrixAt(i, dummy.matrix);
    });
    barMesh.receiveShadow = true;
    this.group.add(barMesh);
  }

  // ---------------------------------------------------------------
  // Faroles: poste + brazo + luminaria + charco de luz (todo instanciado)
  // ---------------------------------------------------------------
  _buildStreetlights() {
    const lines = this._streetLines();
    const corner = this.streetWidth / 2 + 0.45;
    const spots = [];
    for (const x of lines) {
      for (const z of lines) {
        // Esquina que mira hacia el centro de la ciudad (siempre cae sobre una acera).
        const sx = x === 0 ? 1 : -Math.sign(x);
        const sz = z === 0 ? 1 : -Math.sign(z);
        spots.push({ x: x + sx * corner, z: z + sz * corner, ax: -sx, az: -sz });
      }
    }

    const count = spots.length;
    const poleMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.12, 5.4, 6), this._mat.pole, count);
    const armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.08, 2.4), this._mat.pole, count);
    this._lampMat = new THREE.MeshStandardMaterial({ color: 0xfff2c9, emissive: 0xffc46b, emissiveIntensity: 0.2, roughness: 0.5 });
    const headMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.14, 0.8), this._lampMat, count);

    const glowTex = createRadialGlowTexture();
    this._poolMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      color: 0xffb35c,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const poolMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(11, 11), this._poolMat, count);

    const dummy = new THREE.Object3D();
    spots.forEach((s, i) => {
      const yaw = Math.atan2(s.ax, s.az);
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(s.x, GROUND_Y + 2.7, s.z);
      dummy.updateMatrix();
      poleMesh.setMatrixAt(i, dummy.matrix);

      const reach = 1.2 / Math.SQRT2;
      dummy.position.set(s.x + s.ax * reach, GROUND_Y + 5.3, s.z + s.az * reach);
      dummy.rotation.set(0, yaw, 0);
      dummy.updateMatrix();
      armMesh.setMatrixAt(i, dummy.matrix);

      const tip = 2.3 / Math.SQRT2;
      dummy.position.set(s.x + s.ax * tip, GROUND_Y + 5.22, s.z + s.az * tip);
      dummy.updateMatrix();
      headMesh.setMatrixAt(i, dummy.matrix);

      dummy.position.set(s.x + s.ax * tip * 1.6, 0.03, s.z + s.az * tip * 1.6);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.updateMatrix();
      poolMesh.setMatrixAt(i, dummy.matrix);
    });
    poleMesh.castShadow = true;
    poolMesh.renderOrder = 2;
    this.group.add(poleMesh, armMesh, headMesh, poolMesh);
  }

  // ---------------------------------------------------------------
  // Detalles de calle: arboles (eucalipto/molle), bancas, basureros y bolardos.
  // Todo se fusiona en el StaticBatcher (pocas draw calls) y usa un RNG propio,
  // asi no altera la disposicion de edificios ya generada.
  // ---------------------------------------------------------------
  _buildStreetDetails() {
    const rng = mulberry32(8080);
    const b = this._batch;
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4230, roughness: 1 });
    const leafMats = [0x4f7a3a, 0x6b8f3f, 0x3f6b4a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true }));
    const benchMat = this._mat.stallTable;
    const binMat = new THREE.MeshStandardMaterial({ color: 0x2f5f4a, roughness: 0.7, metalness: 0.2 });
    const bollardMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.6 });
    const bollardStripe = new THREE.MeshStandardMaterial({ color: 0xe8452c, roughness: 0.6 });

    const half = this.blockSize / 2;
    const edge = half - 1.5; // centro de la acera, entre el borde de la manzana y las casas
    let trees = 0;

    for (const blk of this.minimapBlocks) {
      if (blk.type === 'gas' || blk.type === 'garage' || blk.type === 'market') continue;
      for (const side of [0, 1, 2, 3]) {
        for (const t of [-6, 0, 6]) {
          const along = t + (rng() - 0.5) * 1.5;
          const lx = side < 2 ? along : (side === 2 ? edge : -edge);
          const lz = side < 2 ? (side === 0 ? edge : -edge) : along;
          const x = blk.x + lx;
          const z = blk.z + lz;
          const roll = rng();

          if (roll < 0.42) {
            // Arbol: tronco + copa de dos poliedros.
            const h = 2.0 + rng() * 1.3;
            b.add(new THREE.CylinderGeometry(0.1, 0.16, h, 6), trunkMat, new THREE.Vector3(x, GROUND_Y + h / 2, z));
            const leaf = leafMats[Math.floor(rng() * leafMats.length)];
            const r = 1.1 + rng() * 0.7;
            b.add(new THREE.IcosahedronGeometry(r, 0), leaf, new THREE.Vector3(x, GROUND_Y + h + r * 0.55, z), {
              rotation: new THREE.Euler(rng() * 3, rng() * 3, 0),
            });
            b.add(new THREE.IcosahedronGeometry(r * 0.7, 0), leaf, new THREE.Vector3(x + (rng() - 0.5) * 0.9, GROUND_Y + h + r * 1.1, z + (rng() - 0.5) * 0.9), {
              rotation: new THREE.Euler(rng() * 3, rng() * 3, 0),
            });
            this.collisionSystem.addStaticBox(new THREE.Box3(new THREE.Vector3(x - 0.25, 0, z - 0.25), new THREE.Vector3(x + 0.25, 2.6, z + 0.25)));
            trees++;
          } else if (roll < 0.52) {
            // Banca de madera con patas, paralela a la calle.
            const rot = new THREE.Euler(0, side < 2 ? 0 : Math.PI / 2, 0);
            b.add(new THREE.BoxGeometry(1.6, 0.08, 0.42), benchMat, new THREE.Vector3(x, GROUND_Y + 0.5, z), { rotation: rot });
            b.add(new THREE.BoxGeometry(1.6, 0.3, 0.06), benchMat, new THREE.Vector3(x + (side < 2 ? 0 : (side === 2 ? 0.2 : -0.2)), GROUND_Y + 0.8, z + (side < 2 ? (side === 0 ? 0.2 : -0.2) : 0)), { rotation: rot });
            b.add(new THREE.BoxGeometry(0.08, 0.5, 0.4), this._mat.pole, new THREE.Vector3(x + (side < 2 ? -0.65 : 0), GROUND_Y + 0.25, z + (side < 2 ? 0 : -0.65)), { rotation: rot });
            b.add(new THREE.BoxGeometry(0.08, 0.5, 0.4), this._mat.pole, new THREE.Vector3(x + (side < 2 ? 0.65 : 0), GROUND_Y + 0.25, z + (side < 2 ? 0 : 0.65)), { rotation: rot });
          } else if (roll < 0.6) {
            // Basurero.
            b.add(new THREE.CylinderGeometry(0.28, 0.24, 0.8, 8), binMat, new THREE.Vector3(x, GROUND_Y + 0.4, z));
            b.add(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 8), this._mat.pole, new THREE.Vector3(x, GROUND_Y + 0.83, z), { cast: false });
          }
        }
      }
      // Bolardos en las esquinas de cada manzana (protegen la acera y dan lectura de bordillo).
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const cx = blk.x + sx * (half - 0.5);
          const cz = blk.z + sz * (half - 0.5);
          b.add(new THREE.CylinderGeometry(0.1, 0.1, 0.75, 6), bollardMat, new THREE.Vector3(cx, GROUND_Y + 0.375, cz), { cast: false });
          b.add(new THREE.CylinderGeometry(0.102, 0.102, 0.14, 6), bollardStripe, new THREE.Vector3(cx, GROUND_Y + 0.55, cz), { cast: false });
        }
      }
    }
    this.treeCount = trees;
  }

  // ---------------------------------------------------------------
  // La ciudad continua hasta el horizonte (decorativa, instanciada)
  // ---------------------------------------------------------------
  _buildOuterCity() {
    const rng = mulberry32(2024);
    const mat = new THREE.MeshStandardMaterial({
      map: this._facadeTextures.map,
      emissiveMap: this._facadeTextures.emissiveMap,
      emissive: 0xffffff,
      emissiveIntensity: 0,
      roughness: 0.9,
    });
    this._windowMats.push(mat);

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.75, uv.getY(i) * 0.75);

    const inner = this.halfExtentX + this.streetWidth + 14;
    const placements = [];
    for (let tries = 0; placements.length < 650 && tries < 4000; tries++) {
      const angle = rng() * Math.PI * 2;
      const r = inner + 10 + Math.pow(rng(), 0.7) * 260;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      if (Math.abs(x) < inner && Math.abs(z) < inner) continue;
      if (CABLE_ANCHORS.some((a) => Math.hypot(a.x - x, a.z - z) < 16)) continue;
      placements.push({ x, z, w: 6 + rng() * 9, d: 6 + rng() * 9, h: 4 + rng() * (r < 200 ? 16 : 9), rot: Math.round(rng() * 4) * (Math.PI / 2) + (rng() - 0.5) * 0.2 });
    }

    const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const tones = [0xa8674a, 0x9a958c, 0xb0aa9e, 0x8c7266, 0xc98f62, 0xe8452c, 0x2b6fb3, 0xf5b400, 0x3ea66b];
    placements.forEach((p, i) => {
      dummy.position.set(p.x, 0, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.set(p.w, p.h, p.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.setHex(tones[Math.floor(rng() * tones.length)]);
      mesh.setColorAt(i, color);
    });
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------
  // Cordillera low-poly con el Illimani (tres picos nevados)
  // ---------------------------------------------------------------
  _buildMountains() {
    const rng = mulberry32(99);
    const rock = [new THREE.Color(0x5d4c45), new THREE.Color(0x6e5a50), new THREE.Color(0x4f4a52)];
    const snow = new THREE.Color(0xf4f6fa);
    const snowShade = new THREE.Color(0xc9d6e8);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, fog: false });

    const makePeak = (x, z, radius, height, snowLine) => {
      let geo = new THREE.ConeGeometry(radius, height, 9, 5);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y < -height / 2 + 0.01) continue; // base intacta
        const k = 1 - (y + height / 2) / height;
        pos.setX(i, pos.getX(i) + (rng() - 0.5) * radius * 0.22 * k);
        pos.setZ(i, pos.getZ(i) + (rng() - 0.5) * radius * 0.22 * k);
        pos.setY(i, y + (rng() - 0.5) * height * 0.06 * (1 - Math.abs(k - 0.5)));
      }
      geo = geo.toNonIndexed();
      const p = geo.attributes.position;
      const colors = new Float32Array(p.count * 3);
      const c = new THREE.Color();
      for (let f = 0; f < p.count; f += 3) {
        const cy = (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3;
        const t = (cy + height / 2) / height;
        if (t > snowLine + (rng() - 0.5) * 0.08) c.copy(rng() < 0.6 ? snow : snowShade);
        else c.copy(rock[Math.floor(rng() * rock.length)]);
        for (let v = 0; v < 3; v++) c.toArray(colors, (f + v) * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      geo.translate(x, height / 2 - 2, z);
      return geo;
    };

    const geos = [];
    // Illimani: macizo de tres cumbres al oeste-noroeste (se ve al arrancar).
    geos.push(makePeak(-560, -170, 150, 330, 0.55));
    geos.push(makePeak(-600, -60, 130, 290, 0.55));
    geos.push(makePeak(-540, -280, 120, 250, 0.58));
    // Resto de la cordillera alrededor.
    for (let i = 0; i < 26; i++) {
      const angle = (i / 26) * Math.PI * 2 + rng() * 0.15;
      if (Math.abs(Math.atan2(Math.sin(angle - Math.PI * 1.05), Math.cos(angle - Math.PI * 1.05))) < 0.35) continue;
      const r = 620 + rng() * 140;
      const h = 90 + rng() * 150;
      geos.push(makePeak(Math.cos(angle) * r, Math.sin(angle) * r, h * (0.7 + rng() * 0.4), h, 0.72));
    }

    const mountains = new THREE.Mesh(mergeGeometries(geos), mat);
    geos.forEach((g) => g.dispose());
    this.group.add(mountains);
  }

  // ---------------------------------------------------------------
  // Teleferico: torres, dos cables con catenaria, cabinas que se mecen
  // ---------------------------------------------------------------
  _buildCableCar() {
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.5, metalness: 0.5 });
    const stationMat = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.6 });
    const cabinMat = new THREE.MeshStandardMaterial({ color: 0x1f6fd1, roughness: 0.45, metalness: 0.2 });
    const cabinGlass = new THREE.MeshStandardMaterial({ color: 0x0e1a26, roughness: 0.15, metalness: 0.6, emissive: 0xffd98a, emissiveIntensity: 0 });
    this._cabinGlassMat = cabinGlass;

    // Estaciones y torres solo fuera de la zona jugable; el tramo central
    // cruza la ciudad en diagonal muy por encima de los edificios.
    const anchors = CABLE_ANCHORS;
    const start = new THREE.Vector3(anchors[0].x, 0, anchors[0].z);
    const end = new THREE.Vector3(anchors[anchors.length - 1].x, 0, anchors[anchors.length - 1].z);
    const lateral = new THREE.Vector3().subVectors(end, start).normalize().cross(UP).multiplyScalar(2.2);

    const towers = [];
    for (let i = 0; i < anchors.length; i++) {
      const { x, z, h } = anchors[i];
      const p = new THREE.Vector3(x, 0, z);
      towers.push(new THREE.Vector3(x, h, z));

      const isStation = i === 0 || i === anchors.length - 1;
      if (isStation) {
        this._batch.add(new THREE.BoxGeometry(14, h - 2, 12), stationMat, new THREE.Vector3(p.x, (h - 2) / 2, p.z));
        this._batch.add(new THREE.BoxGeometry(16, 1, 14), cabinMat, new THREE.Vector3(p.x, h - 1.5, p.z));
      } else {
        this._batch.add(new THREE.CylinderGeometry(0.5, 1.4, h, 4), towerMat, new THREE.Vector3(p.x, h / 2, p.z), {
          rotation: new THREE.Euler(0, Math.PI / 4, 0),
        });
        this._batch.add(new THREE.BoxGeometry(6, 0.5, 0.8), towerMat, new THREE.Vector3(p.x, h, p.z), {
          rotation: new THREE.Euler(0, Math.atan2(lateral.x, lateral.z) + Math.PI / 2, 0),
        });
      }
    }

    // Polilinea con caida (catenaria aproximada con parabola) entre torres.
    const buildPath = (offset) => {
      const pts = [];
      for (let i = 0; i < towers.length - 1; i++) {
        const a = towers[i].clone().add(offset);
        const b = towers[i + 1].clone().add(offset);
        const span = a.distanceTo(b);
        const sag = span * 0.045;
        const samples = Math.max(8, Math.round(span / 6));
        for (let s = 0; s < samples; s++) {
          const t = s / samples;
          const p = new THREE.Vector3().lerpVectors(a, b, t);
          p.y -= sag * 4 * t * (1 - t);
          pts.push(p);
        }
      }
      pts.push(towers[towers.length - 1].clone().add(offset));
      return pts;
    };

    const cableMat = new THREE.LineBasicMaterial({ color: 0x15171a });
    const pathA = buildPath(lateral);
    const pathB = buildPath(lateral.clone().negate()).reverse();
    for (const path of [pathA, pathB]) {
      this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(path), cableMat));
    }

    const curveA = new THREE.CatmullRomCurve3(pathA);
    const curveB = new THREE.CatmullRomCurve3(pathB);
    const cabinGeo = new THREE.BoxGeometry(1.8, 1.7, 1.8);
    const windowGeo = new THREE.BoxGeometry(1.84, 0.6, 1.84);
    const hangerGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.6, 4);
    const perCable = 7;

    for (const [curve, phase] of [[curveA, 0], [curveB, 0.5 / perCable]]) {
      for (let i = 0; i < perCable; i++) {
        const cabin = new THREE.Group();
        const box = new THREE.Mesh(cabinGeo, cabinMat);
        box.castShadow = true;
        box.position.y = -2.4;
        const win = new THREE.Mesh(windowGeo, cabinGlass);
        win.position.y = -2.2;
        const hanger = new THREE.Mesh(hangerGeo, towerMat);
        hanger.position.y = -0.8;
        cabin.add(box, win, hanger);
        this.group.add(cabin);
        this._cableCars.push({ mesh: cabin, curve, t: i / perCable + phase, sway: i * 1.7 });
      }
    }
  }

  _buildBoundaryColliders() {
    // Muros invisibles en el perimetro jugable para que el jugador no se
    // aleje indefinidamente hacia las montanas decorativas.
    const margin = this.streetWidth; // deja la ultima calle transitable
    const outerX = this.halfExtentX + margin;
    const outerZ = this.halfExtentZ + margin;
    const thickness = 4;
    const wallHeight = 10;

    const walls = [
      new THREE.Box3(new THREE.Vector3(-outerX, 0, outerZ), new THREE.Vector3(outerX, wallHeight, outerZ + thickness)),
      new THREE.Box3(new THREE.Vector3(-outerX, 0, -outerZ - thickness), new THREE.Vector3(outerX, wallHeight, -outerZ)),
      new THREE.Box3(new THREE.Vector3(outerX, 0, -outerZ), new THREE.Vector3(outerX + thickness, wallHeight, outerZ)),
      new THREE.Box3(new THREE.Vector3(-outerX - thickness, 0, -outerZ), new THREE.Vector3(-outerX, wallHeight, outerZ)),
    ];

    for (const wall of walls) {
      this.collisionSystem.addStaticBox(wall);
    }

    // Barrera visible (bloques de concreto pintados) donde termina la zona jugable.
    const barrierMat = new THREE.MeshStandardMaterial({ color: 0xd9d4c7, roughness: 0.9 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xe8452c, roughness: 0.8 });
    const len = 2.4;
    for (const [axis, sign] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]]) {
      const fixed = (axis === 'x' ? outerX : outerZ) * sign;
      const span = axis === 'x' ? outerZ : outerX;
      for (let p = -span; p < span; p += len + 0.6) {
        const pos = axis === 'x' ? new THREE.Vector3(fixed, 0.45, p + len / 2) : new THREE.Vector3(p + len / 2, 0.45, fixed);
        const rot = new THREE.Euler(0, axis === 'x' ? Math.PI / 2 : 0, 0);
        this._batch.add(new THREE.BoxGeometry(len, 0.9, 0.6), barrierMat, pos, { rotation: rot });
        this._batch.add(new THREE.BoxGeometry(len * 0.4, 0.92, 0.62), stripeMat, pos, { rotation: rot, cast: false });
      }
    }
  }

  /** 0 = dia, 1 = noche: ventanas, neon, faroles, letreros y cabinas. */
  setNight(factor) {
    const f = THREE.MathUtils.clamp(factor, 0, 1);
    for (const m of this._windowMats) m.emissiveIntensity = f * 1.15;
    for (const m of this._neonMats) m.emissiveIntensity = 0.5 + f * 2.6;
    for (const m of this._billboardMats) m.emissiveIntensity = 0.05 + f * 0.85;
    this._lampMat.emissiveIntensity = 0.2 + f * 4;
    this._poolMat.opacity = f * 0.5;
    this._cabinGlassMat.emissiveIntensity = f * 1.2;
  }

  /** 0 = seco, 1 = mojado: el asfalto se oscurece y brilla (refleja faros). */
  setWet(factor) {
    this.asphaltMat.roughness = 0.95 - factor * 0.6;
    this.asphaltMat.metalness = factor * 0.25;
    this.asphaltMat.color.setScalar(1 - factor * 0.35);
  }

  animate(delta) {
    // Las cabinas recorren el cable y se mecen levemente con el viento.
    const t = performance.now() * 0.001;
    for (const car of this._cableCars) {
      car.t = (car.t + delta * 0.012) % 1;
      const p = car.curve.getPointAt(car.t);
      const ahead = car.curve.getPointAt(Math.min(1, car.t + 0.002));
      car.mesh.position.copy(p);
      car.mesh.rotation.y = Math.atan2(ahead.x - p.x, ahead.z - p.z);
      car.mesh.rotation.z = Math.sin(t * 1.3 + car.sway) * 0.05;
      car.mesh.rotation.x = Math.sin(t * 0.9 + car.sway) * 0.03;
    }
  }
}
