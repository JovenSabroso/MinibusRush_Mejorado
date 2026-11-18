import * as THREE from 'three';

// Tipos de pasajero segun el concepto del juego: la mayoria paga tarifa
// normal, algunos son de "trayecto largo" y muy pocos son "especiales".
const FARE_TYPES = [
  { type: 'normal', fare: 2, weight: 0.65, color: 0x4a90d9 },
  { type: 'largo', fare: 3, weight: 0.25, color: 0x3ea66b },
  { type: 'especial', fare: 5, weight: 0.1, color: 0xf5b400 },
];

function pickFareType(rng) {
  const roll = rng();
  let acc = 0;
  for (const fareType of FARE_TYPES) {
    acc += fareType.weight;
    if (roll <= acc) return fareType;
  }
  return FARE_TYPES[0];
}

// --- Geometrias y materiales compartidos por todas las paradas/pasajeros ---
const GEO = {
  pole: new THREE.CylinderGeometry(0.07, 0.08, 2.6, 8),
  sign: new THREE.BoxGeometry(0.85, 0.5, 0.06),
  roof: new THREE.BoxGeometry(2.6, 0.08, 1.1),
  bench: new THREE.BoxGeometry(1.8, 0.08, 0.45),
  benchLeg: new THREE.BoxGeometry(0.08, 0.42, 0.4),
  ring: new THREE.RingGeometry(3.4, 3.9, 32),
  beacon: new THREE.CylinderGeometry(1.6, 1.6, 40, 20, 1, true),
  body: new THREE.CapsuleGeometry(0.22, 0.55, 4, 8),
  skirt: new THREE.ConeGeometry(0.42, 0.75, 10),
  head: new THREE.SphereGeometry(0.16, 10, 10),
  hatCrown: new THREE.CylinderGeometry(0.1, 0.13, 0.2, 10),
  hatBrim: new THREE.CylinderGeometry(0.2, 0.2, 0.02, 12),
  shawl: new THREE.CylinderGeometry(0.26, 0.3, 0.3, 10),
};

const MAT = {
  pole: new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.6, metalness: 0.2 }),
  sign: new THREE.MeshStandardMaterial({ color: 0x2b6fb3, roughness: 0.5, emissive: 0x2b6fb3, emissiveIntensity: 0.15 }),
  roof: new THREE.MeshStandardMaterial({ color: 0xe8452c, roughness: 0.6 }),
  bench: new THREE.MeshStandardMaterial({ color: 0x7a5233, roughness: 0.9 }),
  skin: new THREE.MeshStandardMaterial({ color: 0xb87a4b, roughness: 0.7 }),
  hat: new THREE.MeshStandardMaterial({ color: 0x1d1a18, roughness: 0.6 }),
  shawls: [0x8e2c48, 0x2f6b5a, 0xc36a2d, 0x5b3f8c].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 })),
};
const fareMats = new Map(FARE_TYPES.map((f) => [f.type, new THREE.MeshStandardMaterial({ color: f.color, roughness: 0.85 })]));

// Haz de luz vertical: se desvanece hacia arriba. Additive para que brille
// sin tapar lo que hay detras, y sin escribir profundidad.
function createBeaconMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        float fade = pow(1.0 - vUv.y, 1.6);
        float bands = 0.75 + 0.25 * sin(vUv.y * 40.0 - uTime * 4.0);
        gl_FragColor = vec4(uColor * 1.6, fade * bands * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/**
 * BusStop
 * Parada de minibus: poste + letrero + techito + banca, anillo indicador en
 * el piso y un haz de luz visible a la distancia cuando es la parada activa.
 * Los pasajeros esperan alrededor; al abordar caminan hacia la puerta del
 * minibus antes de desaparecer. El RouteSystem decide cuando se embarca.
 */
export class BusStop {
  /**
   * @param {number} facingYaw - rotacion Y para que el +Z local mire a la calle
   *   (la banca y los pasajeros quedan contra la vereda, nunca dentro de una fachada).
   */
  constructor(name, position, order, rng, facingYaw = 0) {
    this.name = name;
    this.position = position.clone();
    this.order = order;
    this.rng = rng;

    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.position.y = 0.22; // altura de la acera: la parada queda sobre la vereda, no en la calle
    this.group.rotation.y = facingYaw;
    this.group.name = `BusStop_${name}`;

    this.waiting = []; // { mesh, fareType, phase }
    this._walkers = []; // pasajeros caminando hacia el bus { mesh, target, t }
    this.dwellTimer = 0; // segundos que el bus lleva quieto y en rango
    this.boardTimer = 0; // cuenta regresiva entre embarques individuales
    this.extraPerRefill = 0; // mejora "letrero luminoso"

    this._pulseT = 0;

    this._buildMarker();
    this.refillPassengers();
  }

  _buildMarker() {
    // Local: +Z mira a la calle, -Z hacia la fachada (hay ~1m de vereda detras).
    const pole = new THREE.Mesh(GEO.pole, MAT.pole);
    pole.position.set(-1.6, 1.3, 0.5);
    this.group.add(pole);

    const sign = new THREE.Mesh(GEO.sign, MAT.sign);
    sign.position.set(-1.6, 2.5, 0.5);
    sign.rotation.y = Math.PI / 2;
    this.group.add(sign);

    // Techito y banca: la tipica "caseta" de parada urbana.
    const roof = new THREE.Mesh(GEO.roof, MAT.roof);
    roof.position.set(0, 2.3, -0.4);
    roof.castShadow = true;
    this.group.add(roof);
    for (const x of [-1.15, 1.15]) {
      const post = new THREE.Mesh(GEO.pole, MAT.pole);
      post.scale.y = 0.88;
      post.position.set(x, 1.14, -0.85);
      this.group.add(post);
    }

    const bench = new THREE.Mesh(GEO.bench, MAT.bench);
    bench.position.set(0, 0.45, -0.65);
    this.group.add(bench);
    for (const x of [-0.75, 0.75]) {
      const leg = new THREE.Mesh(GEO.benchLeg, MAT.pole);
      leg.position.set(x, 0.21, -0.65);
      this.group.add(leg);
    }

    // Anillo en el suelo que marca la zona de parada; su opacidad/color
    // cambia segun sea la parada activa (ver pulse()).
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(GEO.ring, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    this.group.add(ring);
    this.ring = ring;

    // Haz de luz: se ve desde cualquier punto de la ciudad, guia al jugador.
    this.beacon = new THREE.Mesh(GEO.beacon, createBeaconMaterial(0xffc21a));
    this.beacon.position.y = 20;
    this.beacon.renderOrder = 5;
    this.beacon.frustumCulled = false;
    this.group.add(this.beacon);
  }

  _buildPassengerMesh(fareType) {
    const group = new THREE.Group();
    const fareMat = fareMats.get(fareType.type);
    const isCholita = this.rng() < 0.4;

    if (isCholita) {
      // Pollera (cono), manta, sombrero bombin: silueta reconocible de El Alto.
      const skirt = new THREE.Mesh(GEO.skirt, fareMat);
      skirt.position.y = 0.38;
      skirt.castShadow = true;
      group.add(skirt);

      const shawl = new THREE.Mesh(GEO.shawl, MAT.shawls[Math.floor(this.rng() * MAT.shawls.length)]);
      shawl.position.y = 0.88;
      group.add(shawl);

      const head = new THREE.Mesh(GEO.head, MAT.skin);
      head.position.y = 1.16;
      group.add(head);

      const brim = new THREE.Mesh(GEO.hatBrim, MAT.hat);
      brim.position.y = 1.28;
      group.add(brim);
      const crown = new THREE.Mesh(GEO.hatCrown, MAT.hat);
      crown.position.y = 1.39;
      group.add(crown);
    } else {
      const body = new THREE.Mesh(GEO.body, fareMat);
      body.position.y = 0.68;
      body.castShadow = true;
      group.add(body);

      const head = new THREE.Mesh(GEO.head, MAT.skin);
      head.position.y = 1.16;
      group.add(head);
    }

    const s = 0.92 + this.rng() * 0.16;
    group.scale.setScalar(s);
    return group;
  }

  _addWaiting(count) {
    for (let i = 0; i < count; i++) {
      const fareType = pickFareType(this.rng);
      const mesh = this._buildPassengerMesh(fareType);
      // Fila informal a lo largo de la vereda, mirando hacia la calle.
      const slot = this.waiting.length;
      const x = -1.1 + (slot % 6) * 0.75 + (this.rng() - 0.5) * 0.2;
      const z = 0.05 + Math.floor(slot / 6) * 0.55 + this.rng() * 0.25;
      mesh.position.set(x, 0, z);
      mesh.rotation.y = (this.rng() - 0.5) * 1.2;
      this.group.add(mesh);
      this.waiting.push({ mesh, fareType, phase: this.rng() * Math.PI * 2 });
    }
  }

  /** Genera un nuevo grupo de pasajeros esperando (usado al iniciar y al reiniciar la ruta). */
  refillPassengers() {
    for (const passenger of this.waiting) this.group.remove(passenger.mesh);
    this.waiting = [];
    this.dwellTimer = 0;
    this.boardTimer = 0;

    const count = 2 + Math.floor(this.rng() * 4) + this.extraPerRefill; // entre 2 y 5 personas (+mejora)
    this._addWaiting(count);
  }

  /**
   * Agrega pasajeros extra a la fila de espera actual, sin tocar a los que
   * ya estaban. Usado por el evento aleatorio "mucha demanda de pasajeros"
   * (fase 4): esa parada en particular se llena mas de lo normal.
   */
  addExtraWaiting(count) {
    this._addWaiting(count);
  }

  /**
   * Hace subir a un pasajero al minibus. El mesh camina hacia `busWorldPos`
   * y se elimina al llegar (ver pulse()). Devuelve la tarifa.
   */
  boardNextPassenger(busWorldPos) {
    const passenger = this.waiting.shift();
    if (!passenger) return null;
    if (busWorldPos) {
      const target = this.group.worldToLocal(busWorldPos.clone());
      target.y = 0;
      this._walkers.push({ mesh: passenger.mesh, from: passenger.mesh.position.clone(), target, t: 0 });
    } else {
      this.group.remove(passenger.mesh);
    }
    return passenger.fareType;
  }

  get isDone() {
    return this.waiting.length === 0;
  }

  /** Anima anillo, haz de luz, pasajeros esperando y los que caminan al bus. */
  pulse(delta, isActive) {
    this._pulseT += delta;
    const baseOpacity = isActive ? 0.45 : 0.1;
    const osc = isActive ? Math.sin(this._pulseT * 3.2) * 0.15 : 0;
    this.ring.material.opacity = Math.max(0, baseOpacity + osc);
    this.ring.material.color.set(isActive ? 0xf5d142 : 0x888888);

    const beaconUniforms = this.beacon.material.uniforms;
    const targetOpacity = isActive && this.waiting.length > 0 ? 0.55 : 0;
    beaconUniforms.uOpacity.value += (targetOpacity - beaconUniforms.uOpacity.value) * Math.min(1, delta * 3);
    beaconUniforms.uTime.value = this._pulseT;
    this.beacon.visible = beaconUniforms.uOpacity.value > 0.01;

    // Pequeno balanceo de los que esperan: la parada se siente viva.
    for (const p of this.waiting) {
      p.mesh.position.y = Math.abs(Math.sin(this._pulseT * 2 + p.phase)) * 0.03;
    }

    for (let i = this._walkers.length - 1; i >= 0; i--) {
      const w = this._walkers[i];
      w.t += delta / 0.45;
      const k = Math.min(1, w.t);
      w.mesh.position.lerpVectors(w.from, w.target, k);
      w.mesh.position.y = Math.abs(Math.sin(k * Math.PI * 4)) * 0.12;
      w.mesh.lookAt(this.group.localToWorld(w.target.clone()));
      if (k >= 1) {
        this.group.remove(w.mesh);
        this._walkers.splice(i, 1);
      }
    }
  }
}
