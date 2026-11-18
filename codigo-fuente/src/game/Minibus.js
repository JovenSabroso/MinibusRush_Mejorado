import * as THREE from 'three';
import { createBodyPanelTexture, createGrilleTexture, createRouteSignTexture } from './textureGenerators.js';
import { mergeChildrenByMaterial } from './meshUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Minibus (jugador)
 * Vehiculo construido enteramente con geometria procedural de Three.js,
 * con apariencia de minibus urbano boliviano ya usado/desgastado.
 * Incluye un modelo de movimiento arcade simple (aceleracion, frenado,
 * reversa, freno de mano y giro progresivo dependiente de la velocidad).
 */
export class Minibus {
  constructor() {
    this.mesh = new THREE.Group();
    this.mesh.name = 'Minibus';
    // La carroceria va en su propio grupo para poder inclinarla (cabeceo al
    // frenar, balanceo al girar) sin mover las ruedas ni la colision.
    this.body = new THREE.Group();
    this.mesh.add(this.body);

    // --- Parametros fisicos (arcade, no realistas) ---
    this.speed = 0; // m/s, positivo = adelante, negativo = reversa
    this.maxSpeed = 15; // ~54 km/h
    this.reverseMaxSpeed = 5.5;
    this.acceleration = 6.2;
    this.brakeDeceleration = 13;
    this.naturalFriction = 2.6;
    this.handbrakeDeceleration = 19;
    this.turnRate = 2.35; // rad/s a velocidad de referencia

    this._steerVisualAngle = 0; // para animar giro visual de ruedas delanteras

    // Traccion efectiva (1 = normal). El evento aleatorio "lluvia" la baja
    // un rato: menos agarre al girar y al frenar. Fase 4.
    this.tractionMultiplier = 1;

    // Mitad del tamano de la caja de colision (x=ancho, y=alto, z=largo)
    this.collisionHalfExtents = new THREE.Vector3(1.15, 1.05, 2.75);

    // --- Combustible ---
    this.maxFuel = 100;
    this.fuel = 100; // % — arranca lleno, se gasta conduciendo
    this.fuelConsumptionPerMeter = 0.05; // % de combustible por metro recorrido

    // --- Desgaste del vehiculo (empieza usado, como pide el concepto del juego) ---
    this.wear = { motor: 60, frenos: 60, neumaticos: 60, suspension: 60, carroceria: 60 };
    this._wearRates = {
      motorPerMeter: 0.015,
      neumaticosPerMeter: 0.018,
      frenosPerSecondBraking: 0.8,
    };

    // Valores base: las mejoras se aplican siempre sobre estos (ver applyUpgrades).
    this._base = {
      maxSpeed: this.maxSpeed,
      acceleration: this.acceleration,
      turnRate: this.turnRate,
      fuelConsumptionPerMeter: this.fuelConsumptionPerMeter,
      neumaticosPerMeter: this._wearRates.neumaticosPerMeter,
    };
    this.rainGrip = 0; // 0..1, mejora de llantas: cuanto se compensa la perdida de traccion por lluvia

    // Telemetria del ultimo frame (la usan audio, particulas y camara).
    this.telemetry = { throttle: false, braking: false, steer: 0, accel: 0 };
    this._bodyPitch = 0;
    this._bodyRoll = 0;
    this._steer = 0; // direccion suavizada (-1..1): evita giros bruscos al pulsar/soltar
    this._accelSmooth = 0; // aceleracion suavizada: evita tirones de velocidad
    this._fwd = new THREE.Vector3(); // vector temporal reutilizado (sin asignaciones por cuadro)
    this._time = 0;

    this._buildBody();
    this._buildWheels();
    this._buildHeadlightBeams();
    // La carroceria tiene ~50 piezas rigidas: fusionarlas por material la
    // deja en ~12 draw calls (las ruedas siguen separadas porque giran).
    mergeChildrenByMaterial(this.body);
  }

  /** Recalcula estadisticas segun los niveles de mejora comprados. */
  applyUpgrades(levels) {
    const motor = levels.motor ?? 0;
    const carb = levels.carburador ?? 0;
    const tires = levels.llantas ?? 0;
    this.maxSpeed = this._base.maxSpeed * (1 + 0.08 * motor);
    this.acceleration = this._base.acceleration * (1 + 0.1 * motor);
    this.fuelConsumptionPerMeter = this._base.fuelConsumptionPerMeter * (1 - 0.15 * carb);
    this.turnRate = this._base.turnRate * (1 + 0.06 * tires);
    this._wearRates.neumaticosPerMeter = this._base.neumaticosPerMeter * (1 - 0.25 * tires);
    this.rainGrip = 0.25 * tires;
  }

  /** Coloca el minibus detenido en una posicion/orientacion (inicio de jornada, grua). */
  placeAt(x, z, rotationY) {
    this.mesh.position.set(x, 0, z);
    this.mesh.rotation.y = rotationY;
    this.speed = 0;
    this._steer = 0;
    this._accelSmooth = 0;
  }

  _buildHeadlightBeams() {
    // Un solo SpotLight para ambos faros: suficiente para iluminar la calle
    // de noche y mucho mas barato que dos. Sin sombras.
    this.headlight = new THREE.SpotLight(0xffe7b0, 0, 55, THREE.MathUtils.degToRad(32), 0.55, 1.2);
    this.headlight.position.set(0, 1.0, 2.6);
    this.headlight.target.position.set(0, 0, 14);
    this.mesh.add(this.headlight, this.headlight.target);
  }

  /** factor 0 (dia) .. 1 (noche): enciende faros y realza luces traseras. */
  setNight(factor) {
    this._night = factor;
    this.headlight.intensity = factor * 60;
    this._headlightMat.emissiveIntensity = 0.9 + factor * 2.2;
  }

  /** Posicion de mundo del caño de escape (para el humo). */
  getExhaustWorldPosition(out) {
    return out.set(-0.65, 0.35, -2.75).applyMatrix4(this.mesh.matrixWorld);
  }

  _buildBody() {
    const BODY_COLOR = 0xc9a227;
    const STRIPE_COLOR = 0x8a2f22; // franja de acento, rojo ladrillo apagado

    // Pintura vieja: amarillo desgastado, poco metalico, bastante rugoso.
    // Los paneles usan texturas generadas por codigo (Canvas2D) en vez de
    // color plano: pintura con variaciones de tono, costuras de chapa,
    // franja de acento y mugre/oxido hacia abajo — nada de imagenes externas.
    const sidePanelTexture = createBodyPanelTexture(BODY_COLOR, STRIPE_COLOR);
    const sideMat = new THREE.MeshPhysicalMaterial({ map: sidePanelTexture, roughness: 0.6, metalness: 0.12, clearcoat: 0.45, clearcoatRoughness: 0.4 });
    const frontTexture = createGrilleTexture(BODY_COLOR);
    const frontMat = new THREE.MeshPhysicalMaterial({ map: frontTexture, roughness: 0.55, metalness: 0.15, clearcoat: 0.4, clearcoatRoughness: 0.4 });
    const flatBodyMat = new THREE.MeshPhysicalMaterial({ color: BODY_COLOR, roughness: 0.6, metalness: 0.12, clearcoat: 0.45, clearcoatRoughness: 0.4 });

    const roofMat = new THREE.MeshStandardMaterial({ color: 0xb8951f, roughness: 0.7, metalness: 0.1 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.7, metalness: 0.2 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0f1a24, roughness: 0.07, metalness: 0.9 });
    const bumperMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.3, metalness: 0.75 });
    const rustMat = new THREE.MeshStandardMaterial({ color: 0x6b3a24, roughness: 1, metalness: 0 });

    // --- Chasis principal ---
    // BoxGeometry asigna un material por cara cuando se le pasa un arreglo:
    // [+x (derecha), -x (izquierda), +y (techo), -y (piso), +z (frente), -z (atras)].
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.05, 1.35, 5.0), [
      sideMat,
      sideMat,
      flatBodyMat,
      flatBodyMat,
      frontMat,
      sideMat,
    ]);
    chassis.position.set(0, 1.05, 0);
    chassis.castShadow = true;
    this.body.add(chassis);

    // --- Techo (mas angosto, da la silueta clasica de minibus) ---
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.5), roofMat);
    roof.position.set(0, 2.0, -0.15);
    roof.castShadow = true;
    this.body.add(roof);

    // --- Parabrisas delantero (inclinado) ---
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.85, 0.08), glassMat);
    windshield.position.set(0, 1.55, 2.42);
    windshield.rotation.x = THREE.MathUtils.degToRad(-8);
    this.body.add(windshield);

    // --- Ventanas laterales (una franja continua por lado) ---
    const sideWindowGeo = new THREE.BoxGeometry(0.06, 0.65, 3.6);
    const leftWindow = new THREE.Mesh(sideWindowGeo, glassMat);
    leftWindow.position.set(-1.02, 1.65, -0.3);
    this.body.add(leftWindow);
    const rightWindow = leftWindow.clone();
    rightWindow.position.x = 1.02;
    this.body.add(rightWindow);

    // --- Puertas (panel + linea + manija) lado derecho, tipico de acceso de pasajeros ---
    this._addDoor(1.04, 0.35, trimMat, bumperMat);
    this._addDoor(1.04, 1.55, trimMat, bumperMat);

    // --- Parachoques ---
    const bumperGeo = new THREE.BoxGeometry(2.15, 0.35, 0.35);
    const frontBumper = new THREE.Mesh(bumperGeo, bumperMat);
    frontBumper.position.set(0, 0.55, 2.55);
    this.body.add(frontBumper);
    const rearBumper = new THREE.Mesh(bumperGeo, bumperMat);
    rearBumper.position.set(0, 0.55, -2.55);
    this.body.add(rearBumper);

    // --- Luces delanteras (mas anchas, hacia las esquinas, como una van real) ---
    const headlightMat = new THREE.MeshStandardMaterial({ color: 0xfff3c9, emissive: 0xffe27a, emissiveIntensity: 0.9, roughness: 0.4 });
    this._headlightMat = headlightMat;
    const headlightGeo = new THREE.BoxGeometry(0.36, 0.28, 0.08);
    const headlightL = new THREE.Mesh(headlightGeo, headlightMat);
    headlightL.position.set(-0.82, 0.92, 2.53);
    this.body.add(headlightL);
    const headlightR = headlightL.clone();
    headlightR.position.x = 0.82;
    this.body.add(headlightR);

    // Marcadores ambar en la esquina exterior de cada faro (detalle tipico de van).
    const markerMat = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xcc7a1a, emissiveIntensity: 0.6, roughness: 0.5 });
    const markerGeo = new THREE.BoxGeometry(0.07, 0.28, 0.08);
    const markerL = new THREE.Mesh(markerGeo, markerMat);
    markerL.position.set(-1.02, 0.92, 2.53);
    this.body.add(markerL);
    const markerR = markerL.clone();
    markerR.position.x = 1.02;
    this.body.add(markerR);

    // --- Luces traseras (mas verticales/integradas, con marcador ambar) ---
    const taillightMat = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xb5140c, emissiveIntensity: 0.7, roughness: 0.4 });
    this._taillightMat = taillightMat;
    const taillightGeo = new THREE.BoxGeometry(0.24, 0.42, 0.08);
    const taillightL = new THREE.Mesh(taillightGeo, taillightMat);
    taillightL.position.set(-0.85, 0.95, -2.53);
    this.body.add(taillightL);
    const taillightR = taillightL.clone();
    taillightR.position.x = 0.85;
    this.body.add(taillightR);
    // Guarda referencia para futuras fases (frenado = luces mas intensas).
    this.taillights = [taillightL, taillightR];

    const rearMarkerL = new THREE.Mesh(markerGeo, markerMat);
    rearMarkerL.position.set(-1.0, 0.95, -2.53);
    this.body.add(rearMarkerL);
    const rearMarkerR = rearMarkerL.clone();
    rearMarkerR.position.x = 1.0;
    this.body.add(rearMarkerR);

    // --- Ventana trasera + tercera luz de freno (como en un minibus real) ---
    const rearWindow = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 0.08), glassMat);
    rearWindow.position.set(0, 1.6, -2.44);
    this.body.add(rearWindow);

    const thirdBrakeLight = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 0.05), taillightMat);
    thirdBrakeLight.position.set(0, 1.93, -2.46);
    this.body.add(thirdBrakeLight);

    // --- Espejos laterales ---
    const mirrorArmGeo = new THREE.BoxGeometry(0.06, 0.06, 0.35);
    const mirrorHeadGeo = new THREE.BoxGeometry(0.1, 0.25, 0.32);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(mirrorArmGeo, trimMat);
      arm.position.set(side * 1.08, 1.75, 2.05);
      arm.rotation.y = side * 0.3;
      this.body.add(arm);
      const head = new THREE.Mesh(mirrorHeadGeo, trimMat);
      head.position.set(side * 1.28, 1.75, 2.1);
      this.body.add(head);
    }

    // --- Letrero de destino en el frente, con el numero de ruta dibujado por codigo ---
    const signTexture = createRouteSignTexture('101');
    const signMat = new THREE.MeshStandardMaterial({ map: signTexture, roughness: 0.6, metalness: 0 });
    const sign = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.28, 0.06), signMat);
    sign.position.set(0, 2.15, 2.35);
    this.body.add(sign);

    // --- Detalles: pilares de ventana, faldones, parrilla cromada, portaequipajes, placas ---
    for (const side of [-1, 1]) {
      for (const pz of [-1.9, -0.9, 0.3, 1.4]) {
        const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.7, 0.09), trimMat);
        pillar.position.set(side * 1.03, 1.65, pz);
        this.body.add(pillar);
      }
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.18, 3.6), trimMat);
      skirt.position.set(side * 1.04, 0.5, 0);
      this.body.add(skirt);
      const gutter = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 4.4), trimMat);
      gutter.position.set(side * 0.97, 2.26, -0.15);
      this.body.add(gutter);
    }
    const grilleBar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.07, 0.05), bumperMat);
    grilleBar.position.set(0, 0.95, 2.53);
    this.body.add(grilleBar);
    const grilleBar2 = grilleBar.clone();
    grilleBar2.position.y = 0.82;
    this.body.add(grilleBar2);
    // Portaequipajes del techo (muy comun en minibuses de linea).
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 3.4), trimMat);
      rail.position.set(side * 0.78, 2.36, -0.1);
      this.body.add(rail);
    }
    for (const rz of [-1.6, -0.5, 0.6, 1.5]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.035, 0.04), trimMat);
      bar.position.set(0, 2.36, rz);
      this.body.add(bar);
    }
    // Placas (frontal y trasera) y limpiaparabrisas.
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xf2efe2, roughness: 0.5 });
    for (const sz of [1, -1]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.17, 0.03), plateMat);
      plate.position.set(0, 0.56, sz * 2.74);
      this.body.add(plate);
    }
    for (const wx of [-0.4, 0.3]) {
      const wiper = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.025, 0.025), trimMat);
      wiper.position.set(wx, 1.2, 2.47);
      wiper.rotation.z = 0.25;
      this.body.add(wiper);
    }

    // --- Un par de manchas de oxido para reforzar el aspecto "vetusto" ---
    const rustSpot1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.02), rustMat);
    rustSpot1.position.set(-1.04, 0.55, 1.4);
    rustSpot1.rotation.y = Math.PI / 2;
    this.body.add(rustSpot1);
    const rustSpot2 = rustSpot1.clone();
    rustSpot2.position.set(1.04, 0.5, -1.6);
    this.body.add(rustSpot2);
  }

  /** Llanta compartida por las 4 ruedas: disco, aro y 5 tuercas por lado, en una sola geometria. */
  _rimGeometry(radius, thickness) {
    if (this._rimGeo) return this._rimGeo;
    const parts = [];
    const disc = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, thickness + 0.03, 20);
    parts.push(disc);
    for (const side of [-1, 1]) {
      const lip = new THREE.TorusGeometry(radius * 0.62, 0.03, 6, 20);
      lip.rotateX(Math.PI / 2); // el eje de la llanta es Y (la malla entera se gira luego)
      lip.translate(0, side * (thickness / 2 + 0.015), 0);
      parts.push(lip);
      const cap = new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, 0.05, 10);
      cap.translate(0, side * (thickness / 2 + 0.03), 0);
      parts.push(cap);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const nut = new THREE.CylinderGeometry(0.03, 0.03, 0.05, 6);
        nut.translate(Math.cos(a) * radius * 0.34, side * (thickness / 2 + 0.03), Math.sin(a) * radius * 0.34);
        parts.push(nut);
      }
    }
    this._rimGeo = mergeGeometries(parts.map((g) => (g.index ? g : g.toNonIndexed())), false);
    parts.forEach((g) => g.dispose());
    return this._rimGeo;
  }

  _addDoor(x, z, trimMat, bumperMat) {
    // Linea de separacion de la puerta.
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.1, 0.03), trimMat);
    seam.position.set(x, 1.0, z);
    this.body.add(seam);
    // Manija.
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.18), bumperMat);
    handle.position.set(x + 0.02, 0.95, z);
    this.body.add(handle);
  }

  _buildWheels() {
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, metalness: 0.0 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xb4b8bd, roughness: 0.3, metalness: 0.8 });
    const archMat = new THREE.MeshStandardMaterial({ color: 0x232629, roughness: 0.85, metalness: 0.1 });

    const wheelRadius = 0.45;
    const wheelThickness = 0.32;

    const wheelPositions = {
      frontLeft: new THREE.Vector3(-1.1, wheelRadius, 1.7),
      frontRight: new THREE.Vector3(1.1, wheelRadius, 1.7),
      rearLeft: new THREE.Vector3(-1.1, wheelRadius, -1.6),
      rearRight: new THREE.Vector3(1.1, wheelRadius, -1.6),
    };

    this.wheels = {};

    // Arcos/salpicaderas: medio-anillo oscuro sobre cada rueda, le da un
    // acabado mucho mas "de van real" en vez de ruedas pegadas a un costado liso.
    for (const pos of Object.values(wheelPositions)) {
      const arch = new THREE.Mesh(new THREE.TorusGeometry(wheelRadius + 0.14, 0.1, 8, 16, Math.PI), archMat);
      arch.rotation.y = Math.PI / 2;
      arch.rotation.z = Math.PI;
      arch.position.set(pos.x, wheelRadius, pos.z);
      this.body.add(arch);
    }

    for (const [key, pos] of Object.entries(wheelPositions)) {
      // Grupo "steer" permite rotar visualmente la rueda delantera al girar.
      const steerPivot = new THREE.Group();
      steerPivot.position.copy(pos);
      this.mesh.add(steerPivot);

      const rollPivot = new THREE.Group(); // este es el que rueda (rotacion X)
      steerPivot.add(rollPivot);

      const tire = new THREE.Mesh(this._tireGeo ??= new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelThickness, 24), tireMat);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      rollPivot.add(tire);

      const hub = new THREE.Mesh(this._rimGeometry(wheelRadius, wheelThickness), hubMat);
      hub.rotation.z = Math.PI / 2;
      rollPivot.add(hub);

      this.wheels[key] = { steerPivot, rollPivot, isFront: key.startsWith('front') };
    }
  }

  /**
   * Actualiza fisica y visuales del minibus.
   * @param {number} delta - segundos desde el ultimo frame
   * @param {InputSystem} input
   */
  update(delta, input) {
    // El desgaste reduce el rendimiento del vehiculo por debajo de ciertos
    // umbrales (motor -> aceleracion/velocidad, frenos -> frenado, neumaticos -> giro).
    const motorFactor = this._wearFactor(this.wear.motor);
    const brakeFactor = this._wearFactor(this.wear.frenos);
    const tireFactor = this._wearFactor(this.wear.neumaticos);

    const effAcceleration = this.acceleration * motorFactor;
    const effMaxSpeed = this.maxSpeed * motorFactor;
    // Las llantas mejoradas recuperan parte del agarre perdido bajo la lluvia.
    const traction = 1 - (1 - this.tractionMultiplier) * (1 - this.rainGrip);
    const effBrakeDeceleration = this.brakeDeceleration * brakeFactor * traction;
    const effTurnRate = this.turnRate * tireFactor * traction;

    const engineOn = this.fuel > 0;
    let accel = 0;
    let isBraking = false;

    if (!engineOn) {
      // Sin combustible el motor no responde: solo queda la friccion natural.
      accel = -Math.sign(this.speed) * this.naturalFriction;
    } else if (input.handbrake) {
      accel = -Math.sign(this.speed) * this.handbrakeDeceleration;
    } else if (input.throttle) {
      accel = effAcceleration;
    } else if (input.brakeOrReverse) {
      // Si va hacia adelante, frenar; si ya esta detenido o en reversa, acelerar en reversa.
      if (this.speed > 0.15) {
        accel = -effBrakeDeceleration;
        isBraking = true;
      } else {
        accel = -effAcceleration * 0.7;
      }
    } else {
      // Friccion natural / motor al ralenti, hacia 0.
      accel = -Math.sign(this.speed) * this.naturalFriction;
    }

    // La aceleracion se aplica con una rampa corta (respuesta firme pero sin tirones).
    this._accelSmooth += (accel - this._accelSmooth) * (1 - Math.exp(-(accel === 0 ? 12 : 9) * delta));
    const prevSpeed = this.speed;
    this.speed += this._accelSmooth * delta;

    // La friccion/frenado nunca invierte el signo de la velocidad (evita vibracion cerca de 0).
    const braking0 = !engineOn || input.handbrake || (!input.throttle && !input.brakeOrReverse) || (input.brakeOrReverse && prevSpeed > 0.15);
    if (braking0 && prevSpeed !== 0 && Math.sign(prevSpeed) !== Math.sign(this.speed)) this.speed = 0;
    if ((!engineOn || (!input.throttle && !input.brakeOrReverse)) && Math.abs(this.speed) < 0.05) {
      this.speed = 0;
      this._accelSmooth = 0;
    }

    this.speed = THREE.MathUtils.clamp(this.speed, -this.reverseMaxSpeed, effMaxSpeed);

    // --- Giro ---
    // Nota: el signo esta invertido a proposito respecto al calculo "teorico"
    // de rotacion en Y, para que coincida con la percepcion real del jugador
    // detras del volante (A = izquierda en pantalla, D = derecha en pantalla).
    let steerInput = 0;
    if (input.steerLeft) steerInput += 1;
    if (input.steerRight) steerInput -= 1;
    // Volante suavizado: entra rapido y vuelve al centro un poco mas lento.
    const steerRate = steerInput === 0 ? 9 : 7;
    this._steer += (steerInput - this._steer) * (1 - Math.exp(-steerRate * delta));
    if (Math.abs(this._steer) < 0.002) this._steer = 0;

    const speedFactor = THREE.MathUtils.clamp(Math.abs(this.speed) / 1.5, 0, 1);
    // A alta velocidad el giro se reduce un poco: mas estable, menos "trompo".
    const highSpeedDamp = 1 - 0.38 * Math.min(1, Math.abs(this.speed) / Math.max(1, this.maxSpeed));
    const turnSign = this.speed >= 0 ? 1 : -1;
    const turnDelta = this._steer * effTurnRate * highSpeedDamp * delta * speedFactor * turnSign;
    this.mesh.rotation.y += turnDelta;

    // --- Traslacion segun heading actual (sin crear vectores nuevos) ---
    const forward = this._fwd.set(Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y));
    const frameDistance = this.speed * delta;
    this.mesh.position.addScaledVector(forward, frameDistance);

    this._updateWheelVisuals(delta, this._steer);
    this._updateFuelAndWear(delta, Math.abs(frameDistance), isBraking || (input.handbrake && Math.abs(this.speed) > 0.5));

    const braking = isBraking || (input.handbrake && Math.abs(this.speed) > 0.3);
    this.telemetry.throttle = engineOn && input.throttle;
    this.telemetry.braking = braking;
    this.telemetry.steer = this._steer;
    this.telemetry.accel = accel;

    this._updateBodyMotion(delta, this._accelSmooth, this._steer, speedFactor);

    // Luces de freno: se encienden fuerte al frenar (con bloom brillan).
    const night = this._night ?? 0;
    const tailTarget = braking ? 3.2 : 0.7 + night * 0.9;
    this._taillightMat.emissiveIntensity += (tailTarget - this._taillightMat.emissiveIntensity) * Math.min(1, delta * 14);
  }

  _updateBodyMotion(delta, accel, steerInput, speedFactor) {
    // Cabeceo: nariz abajo al frenar, arriba al acelerar. Balanceo: la
    // carroceria se va hacia afuera de la curva. Todo suavizado.
    const targetPitch = THREE.MathUtils.clamp(-accel * 0.0045, -0.035, 0.055);
    const speedRatio = Math.min(1, Math.abs(this.speed) / this.maxSpeed);
    const targetRoll = steerInput * 0.05 * speedFactor * speedRatio * Math.sign(this.speed || 1);
    const k = 1 - Math.exp(-6 * delta);
    this._bodyPitch += (targetPitch - this._bodyPitch) * k;
    this._bodyRoll += (targetRoll - this._bodyRoll) * k;

    // Vibracion leve del motor viejo; mas fuerte si la suspension esta gastada.
    this._time += delta;
    const t = this._time;
    const idleShake = Math.abs(this.speed) < 0.3 ? 1.6 : 1; // ralenti del motor viejo, apenas perceptible
    const shake = (0.0025 + (1 - this.wear.suspension / 100) * 0.006) * (0.3 + speedRatio) * idleShake;
    this.body.rotation.x = this._bodyPitch;
    this.body.rotation.z = this._bodyRoll + Math.sin(t * 31) * shake * 0.3;
    this.body.position.y = Math.sin(t * 23) * shake;
  }

  _wearFactor(value) {
    if (value >= 40) return 1;
    if (value >= 20) return 0.75;
    return 0.5;
  }

  _updateFuelAndWear(delta, distanceMeters, isBraking) {
    if (this.fuel > 0) {
      this.fuel = Math.max(0, this.fuel - distanceMeters * this.fuelConsumptionPerMeter);
    }

    this.wear.motor = Math.max(0, this.wear.motor - distanceMeters * this._wearRates.motorPerMeter);
    this.wear.neumaticos = Math.max(0, this.wear.neumaticos - distanceMeters * this._wearRates.neumaticosPerMeter);
    if (isBraking) {
      this.wear.frenos = Math.max(0, this.wear.frenos - delta * this._wearRates.frenosPerSecondBraking);
    }
  }

  /** Llamado por el sistema de colisiones cuando el minibus choca contra algo. */
  applyCollisionDamage() {
    this.wear.suspension = Math.max(0, this.wear.suspension - 3);
    this.wear.carroceria = Math.max(0, this.wear.carroceria - 5);
  }

  refuel(amount) {
    this.fuel = Math.min(this.maxFuel, this.fuel + amount);
  }

  /** Reparacion completa disponible en el garaje (fase 3: todo o nada). */
  repairAll() {
    for (const key of Object.keys(this.wear)) this.wear[key] = 100;
  }

  get outOfFuel() {
    return this.fuel <= 0;
  }

  _updateWheelVisuals(delta, steerInput) {
    const wheelRadius = 0.45;
    const rollAmount = (this.speed * delta) / wheelRadius;

    const targetSteerAngle = steerInput * THREE.MathUtils.degToRad(28);
    this._steerVisualAngle = THREE.MathUtils.lerp(this._steerVisualAngle, targetSteerAngle, 1 - Math.exp(-10 * delta));

    for (const wheel of Object.values(this.wheels)) {
      wheel.rollPivot.rotation.x -= rollAmount;
      if (wheel.isFront) {
        wheel.steerPivot.rotation.y = this._steerVisualAngle;
      }
    }
  }

  get speedKmh() {
    return Math.abs(this.speed) * 3.6;
  }
}
