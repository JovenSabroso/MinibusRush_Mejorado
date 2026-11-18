import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { InputSystem } from './InputSystem.js';
import { CameraSystem } from './CameraSystem.js';
import { CollisionSystem } from './CollisionSystem.js';
import { GameState } from './GameState.js';
import { RouteSystem } from './RouteSystem.js';
import { ServiceSystem } from './ServiceSystem.js';
import { TrafficSystem } from './TrafficSystem.js';
import { TrafficLightSystem } from './TrafficLightSystem.js';
import { setTrafficNight } from './TrafficVehicles.js';
import { PoliceSystem } from './PoliceSystem.js';
import { EventSystem } from './EventSystem.js';
import { BlockadeSystem } from './BlockadeSystem.js';
import { Sky } from './Sky.js';
import { createEnvironmentMap } from './Environment.js';
import { DayNightSystem } from './DayNightSystem.js';
import { WeatherSystem } from './WeatherSystem.js';
import { ParticleSystem } from './ParticleSystem.js';
import { SaveSystem } from './SaveSystem.js';
import { mulberry32 } from './rng.js';
import { City } from './City.js';
import { Minibus } from './Minibus.js';
import { HUD } from '../ui/HUD.js';
import {
  DAY_START_HOUR,
  dailyGoal,
  BUILDING_HIT,
  TRAFFIC_HIT,
  TOW_COST,
  TOW_REPUTATION,
  UPGRADES,
  MAX_UPGRADE_LEVEL,
} from './config.js';

// Perfiles de calidad grafica (ver Ajustes). `pixelRatio` es el maximo:
// la resolucion dinamica lo baja hasta `minPixelRatio` si no se llega a 60 FPS.
const QUALITY = {
  baja: { pixelRatio: 0.9, minPixelRatio: 0.6, shadows: false, shadowSize: 512, bloom: false, particles: 0.4, msaa: 0 },
  media: { pixelRatio: 1, minPixelRatio: 0.7, shadows: true, shadowSize: 1024, bloom: true, particles: 0.75, msaa: 0 },
  alta: { pixelRatio: 1.5, minPixelRatio: 0.75, shadows: true, shadowSize: 2048, bloom: true, particles: 1, msaa: 2 },
};
const TARGET_FRAME_MS = 1000 / 58; // un poco de margen sobre 60 FPS

// Frases del voceador al llegar a cada parada.
const SHOUTS = ['¡Sube, sube, hay campo!', '¡Pasajes, pasajes!', '¡Atrás hay campo, caserita!', '¡Vamos, vamos, que se va!'];

/**
 * Game
 * Orquesta la escena 3D, los sistemas y el bucle principal, y maneja los
 * estados del juego: menu (ciudad de fondo con camara cinematica),
 * jugando, pausa y fin de jornada.
 */
export class Game {
  constructor(canvas, { settings, audio, screens }) {
    this.canvas = canvas;
    this.settings = settings;
    this.audio = audio;
    this.screens = screens;
    this.clock = new THREE.Clock();
    this.state = 'loading';
    this._elapsed = 0;

    this._initRenderer();
    this._initScene();
    this._initLights();

    this.sky = new Sky(this.scene);
    try {
      // Reflejos y luz ambiental procedurales (si falla, el juego sigue sin ellos).
      this.scene.environment = createEnvironmentMap(this.renderer);
      this.scene.environmentIntensity = 0.5;
    } catch (err) {
      console.warn('Entorno no disponible:', err);
    }
    this.dayNight = new DayNightSystem({
      scene: this.scene,
      sky: this.sky,
      sun: this.sun,
      hemi: this.hemi,
      ambient: this.ambient,
      renderer: this.renderer,
    });
    this.weather = new WeatherSystem(this.scene, mulberry32(123));
    this.particles = new ParticleSystem(this.scene, mulberry32(321));

    this.input = new InputSystem();
    this.input.enabled = false;
    this.collisionSystem = new CollisionSystem();
    this.city = new City(this.scene, this.collisionSystem);

    this.gameState = new GameState();
    // Seed distinto al de la ciudad para que la cantidad/tipo de pasajeros
    // no quede correlacionada con el diseno de las manzanas.
    this.routeSystem = new RouteSystem(this.scene, this.gameState, mulberry32(4242));

    this.minibus = new Minibus();
    this.scene.add(this.minibus.mesh);
    this._placeAtTerminal();

    this.cameraSystem = new CameraSystem(this.camera, this.minibus);
    this.hud = new HUD({ stopNames: this.routeSystem.stopNames, capacity: this.gameState.passengerCapacity });

    this.serviceSystem = new ServiceSystem(this.scene, this.collisionSystem, this.input, this.city.serviceSpots);

    // --- Fase 4: trafico NPC, semaforos, policia y eventos aleatorios ---
    this.trafficSystem = new TrafficSystem(this.scene, this.city, mulberry32(555));
    this.trafficLightSystem = new TrafficLightSystem(this.scene, this.city, mulberry32(777));
    this.policeSystem = new PoliceSystem(this.scene, this.city, mulberry32(888));
    // Pasar un semaforo en rojo es una infraccion de transito (la registra la policia).
    this.trafficLightSystem.onRedLightInfraction = (pos) => this.policeSystem.registerInfraction(this.gameState, pos);

    // Bloqueo de calle con gente (no tapa paradas ni servicios).
    this.blockadeSystem = new BlockadeSystem(this.scene, this.city, {
      particles: this.particles,
      avoidPoints: [
        ...this.routeSystem.stops.map((s) => s.position),
        this.serviceSystem.gasStation.position,
        this.serviceSystem.garage.position,
      ],
    });
    this.trafficSystem.blockade = this.blockadeSystem;

    this.eventSystem = new EventSystem({
      minibus: this.minibus,
      trafficSystem: this.trafficSystem,
      policeSystem: this.policeSystem,
      routeSystem: this.routeSystem,
      blockadeSystem: this.blockadeSystem,
      rng: mulberry32(999),
      onToast: (text) => {
        this.hud.showToast(text);
        this.audio.alert();
      },
      onRainChange: (active) => this.weather.setRain(active),
    });

    this._wireCallbacks();
    this._bindKeys();

    // Cooldown para que un choque prolongado (bus empujado contra una pared)
    // no destruya la reputacion/carroceria cuadro a cuadro.
    this._collisionPenaltyCooldown = 0;
    // Mismo concepto pero para choques leves contra trafico NPC.
    this._trafficCollisionCooldown = 0;

    this._lastNight = -1;
    this._lastWet = -1;
    this._menuAngle = 0.6;
    this._autosaveTimer = 0;
    this._fpsFrames = 0;
    this._fpsTimer = 0;
    this._fps = 60;
    this._tmpVec = new THREE.Vector3();

    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('blur', () => {
      if (this.state === 'playing') this.pause();
    });
    window.addEventListener('beforeunload', () => {
      if (this.state === 'playing' || this.state === 'paused') this._saveMidDay();
    });

    this.applySettings(settings);
    this._onResize();
  }

  // ------------------------------------------------------------------
  // Inicializacion
  // ------------------------------------------------------------------
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    // Las estadisticas se reinician a mano por cuadro (el composer hace varios renders).
    this.renderer.info.autoReset = false;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1600);
    this.camera.position.set(0, 60, 140);
  }

  _initLights() {
    this.ambient = new THREE.AmbientLight(0xffffff, 0.3);
    this.scene.add(this.ambient);

    // Sol/luna: una sola luz direccional que sigue al jugador para que el
    // mapa de sombras tenga buena resolucion donde importa.
    const sun = new THREE.DirectionalLight(0xfff2d9, 2.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 70;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    this.hemi = new THREE.HemisphereLight(0xbcd8f0, 0x3a332c, 1);
    this.scene.add(this.hemi);
  }

  _setupComposer(msaa) {
    if (this.composer) {
      this.composer.dispose();
      this.bloomPass?.dispose();
    }
    const size = this.renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: msaa });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Umbral alto: solo brillan las cosas emisivas (neon, faros, semaforos, sol).
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.55, 0.88);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  /** Aplica calidad, volumen y voz. Se llama al iniciar y desde Ajustes. */
  applySettings(settings) {
    this.settings = settings;
    const q = QUALITY[settings.quality] ?? QUALITY.alta;
    this._quality = q;

    this._maxPixelRatio = Math.min(window.devicePixelRatio, q.pixelRatio);
    this._minPixelRatio = Math.min(this._maxPixelRatio, q.minPixelRatio);
    this._pixelRatio = this._maxPixelRatio;
    this._frameSamples = [];
    this.renderer.setPixelRatio(this._pixelRatio);
    if (this.renderer.shadowMap.enabled !== q.shadows) {
      this.renderer.shadowMap.enabled = q.shadows;
      // Cambiar sombras en caliente obliga a recompilar los shaders.
      this.scene.traverse((o) => {
        if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true;
      });
    }
    // PCF simple: PCFSoft cuesta bastante mas y casi no se nota en movimiento.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    if (this.sun.shadow.mapSize.x !== q.shadowSize) {
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }

    this._useBloom = q.bloom;
    if (q.bloom) this._setupComposer(q.msaa);
    this.particles.setDensity(q.particles);
    this.weather.setDensity(q.particles);

    this.audio.setVolume(settings.volume);
    this.audio.voiceEnabled = settings.voice;
    this._onResize();
  }

  _wireCallbacks() {
    this.serviceSystem.onToast = (text, kind) => this.hud.showToast(text, kind);
    this.serviceSystem.onService = (type) => {
      if (type === 'denied') this.audio.denied();
      else this.audio.service();
    };

    this.routeSystem.onPassengerBoarded = (fareType) => {
      this.hud.spawnMoneyPopup(fareType.fare);
      this.audio.coin();
      this.particles.coins(this.minibus.mesh.position);
    };
    this.routeSystem.onRouteComplete = () => {
      this.audio.fanfare();
      this.audio.shout('¡Zona Sur, última parada! Gracias, caseritos.');
    };
    this.routeSystem.onArriveAtStop = (stop) => {
      const name = stop.name.charAt(0) + stop.name.slice(1).toLowerCase();
      this.audio.shout(`¡${name}! ${SHOUTS[Math.floor(Math.random() * SHOUTS.length)]}`);
    };

    this.policeSystem.onFine = (text, amount) => {
      this.hud.showToast(text, 'police');
      this.audio.whistle();
      if (amount > 0) this.hud.spawnMoneyPopup(-amount);
    };

    this.weather.onThunder = (strength) => this.audio.thunder(strength);

    const blockade = this.blockadeSystem;
    blockade.onApproach = () => {
      this.audio.crowd(1);
      this.audio.shout('¡Bloqueo, bloqueo! ¡No pasa nadie, compañero!');
      this.hud.showToast('✊ "¡No pasa nadie!" La gente no se va a mover: da la vuelta por otra cuadra.', 'bad');
    };
    blockade.onHonk = () => {
      this.audio.crowd(0.8);
      this.gameState.addReputation(-1);
      this.hud.showToast('😠 Tocar bocina al bloqueo solo enoja más a la gente.', 'bad');
    };
    blockade.onPush = (impact) => {
      this.gameState.addReputation(-6);
      this.minibus.wear.carroceria = Math.max(0, this.minibus.wear.carroceria - 2);
      this.cameraSystem.shake(0.35);
      this.audio.crowd(1);
      this.audio.denied();
      this.hud.flashHit(Math.min(1, impact / 8));
      this.hud.showToast('⚠️ ¡Casi atropellas a los bloqueadores! Te empujan el micro y te insultan.', 'bad');
    };
    blockade.onPetardo = (pos, distance) => {
      const volume = Math.max(0, 1 - distance / 80);
      this.audio.petardo(volume);
      if (volume > 0.15) this.particles.burst(pos, 0.45);
    };
    blockade.onLifted = () => {
      this.hud.showToast('✅ Se levantó el bloqueo: la calle vuelve a estar libre.', 'good');
    };
  }

  _bindKeys() {
    this.input.onKeyPressed('KeyC', () => this.hud.showCameraLabel(this.cameraSystem.cycleMode()));
    this.input.onKeyPressed('KeyR', () => this._callTowTruck());
    // Provoca un bloqueo al instante (para mostrarlo sin esperar el evento aleatorio).
    this.input.onKeyPressed('KeyB', () => {
      if (this.state === 'playing' && !this.eventSystem.streetBlock()) this.hud.showToast('🚧 Ya hay un bloqueo en la ciudad.', 'info');
    });

    const togglePause = () => {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') {
        if (!this.screens.back()) this.resume();
      } else if (this.state === 'menu') this.screens.back();
    };
    this.input.onKeyPressed('Escape', togglePause, { always: true });
    this.input.onKeyPressed('KeyP', togglePause, { always: true });
  }

  _placeAtTerminal() {
    // Arranca en el carril que pasa junto a la Terminal, unos metros antes,
    // mirando hacia ella: basta con avanzar y frenar en el circulo.
    const first = this.routeSystem.stops[0].position;
    this.minibus.placeAt(first.x + 4.75, first.z - 15, 0);
  }

  // ------------------------------------------------------------------
  // Flujo de juego
  // ------------------------------------------------------------------
  start() {
    this.renderer.setAnimationLoop(() => this._tick());
  }

  goToMenu() {
    this.state = 'menu';
    this.input.enabled = false;
    this.audio.setMuted(true);
    this.weather.reset();
    this.hud.show(false);
    this.hud.clearTransient();
    this.screens.show('menu');
    this.screens.setContinue(SaveSystem.loadCareer());
    this.blockadeSystem.clear();
    this._placeAtTerminal();
    this.minibus.mesh.visible = true;
  }

  newCareer() {
    SaveSystem.clearCareer();
    this.gameState.resetCareer();
    this.minibus.fuel = this.minibus.maxFuel;
    for (const key of Object.keys(this.minibus.wear)) this.minibus.wear[key] = 60;
    this._startDay();
  }

  continueCareer() {
    const save = SaveSystem.loadCareer();
    if (!save) return this.newCareer();
    this.gameState.loadFrom(save);
    if (save.dayStats) this.gameState.dayStats = { ...this.gameState.dayStats, ...save.dayStats };
    if (typeof save.fuel === 'number') this.minibus.fuel = save.fuel;
    if (save.wear) Object.assign(this.minibus.wear, save.wear);
    this._startDay(save.hour ?? DAY_START_HOUR, true);
  }

  _startDay(hour = DAY_START_HOUR, resuming = false) {
    if (!resuming) this.gameState.startNewDay();
    this.gameState.passengersOnboard = 0;

    const levels = this.gameState.upgrades;
    this.minibus.applyUpgrades(levels);
    this.eventSystem.setDefaultMaxSpeed(this.minibus.maxSpeed);
    this.routeSystem.setExtraPassengers(levels.letrero ?? 0);

    this.eventSystem.reset();
    this.weather.reset();
    this.policeSystem.reset();
    this.routeSystem.reset();
    this._placeAtTerminal();
    this.minibus.mesh.visible = true;
    this.cameraSystem.snap();
    this.dayNight.setHour(hour);

    this.hud.clearTransient();
    this.hud.show(true);
    this.screens.hideAll();
    this.state = 'playing';
    this.input.enabled = true;
    this.audio.setMuted(false);

    this.screens.showDayIntro(this.gameState.day, dailyGoal(this.gameState.day), this.dayNight.clockText);
    setTimeout(() => this.audio.shout('¡Terminal, Mercado, Centro, Zona Sur! ¡Sube, sube, hay campo!'), 900);
    this._saveMidDay();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.enabled = false;
    this.audio.setMuted(true);
    const gs = this.gameState;
    this.screens.renderPause({
      day: gs.day,
      clock: this.dayNight.clockText,
      money: gs.money,
      earned: gs.dayStats.earned,
      goal: dailyGoal(gs.day),
      routes: gs.dayStats.routes,
      passengers: gs.dayStats.passengers,
      reputation: `${Math.round(gs.reputation)} · ${gs.reputationLevel}`,
    });
    this.screens.show('pause');
    this._saveMidDay();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.screens.hideAll();
    this.state = 'playing';
    this.input.enabled = true;
    this.audio.setMuted(false);
    this.clock.getDelta(); // descarta el tiempo que estuvo en pausa
  }

  quitToMenu() {
    this._saveMidDay();
    this.goToMenu();
  }

  _endDay() {
    this.state = 'dayend';
    this.input.enabled = false;
    this.audio.setMuted(true);
    this.audio.fanfare();
    this.hud.show(false);

    const gs = this.gameState;
    const st = gs.dayStats;
    const goal = dailyGoal(gs.day);
    const net = st.earned - st.fuelSpent - st.repairSpent - st.fines;
    const stars = (st.earned >= goal ? 1 : 0) + (st.earned >= goal * 1.4 ? 1 : 0) + (gs.reputation >= 70 ? 1 : 0);
    gs.career.bestDay = Math.max(gs.career.bestDay, Math.floor(st.earned));

    const summary = { day: gs.day, stats: { ...st }, goal, net, stars };
    gs.day += 1;
    this._saveNextDay();

    this.screens.renderDayEnd(summary, { money: gs.money, levels: gs.upgrades });
    this.screens.show('dayend');
  }

  buyUpgrade(id) {
    const def = UPGRADES.find((u) => u.id === id);
    const gs = this.gameState;
    const level = gs.upgrades[id] ?? 0;
    if (!def || level >= MAX_UPGRADE_LEVEL) return;
    const cost = def.costs[level];
    if (gs.money < cost) {
      this.audio.denied();
      return;
    }
    gs.money -= cost;
    gs.upgrades[id] = level + 1;
    this.audio.service();
    this._saveNextDay();
    this.screens.renderShop({ money: gs.money, levels: gs.upgrades });
  }

  nextDay() {
    this._startDay(DAY_START_HOUR);
  }

  // ------------------------------------------------------------------
  // Guardado
  // ------------------------------------------------------------------
  _vehicleSnapshot() {
    return { fuel: this.minibus.fuel, wear: { ...this.minibus.wear } };
  }

  _saveMidDay() {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    SaveSystem.saveCareer({
      ...this.gameState.toJSON(),
      ...this._vehicleSnapshot(),
      hour: this.dayNight.hour,
      clock: this.dayNight.clockText,
      dayStats: { ...this.gameState.dayStats },
    });
  }

  _saveNextDay() {
    SaveSystem.saveCareer({ ...this.gameState.toJSON(), ...this._vehicleSnapshot(), hour: DAY_START_HOUR, clock: '06:00' });
  }

  // ------------------------------------------------------------------
  // Grua: evita quedar trabado sin combustible y sin poder llegar a la gasolinera
  // ------------------------------------------------------------------
  _callTowTruck() {
    if (this.state !== 'playing' || !this.minibus.outOfFuel || Math.abs(this.minibus.speed) > 0.5) return;
    const gs = this.gameState;
    const cost = Math.min(TOW_COST, Math.max(0, Math.floor(gs.money)));
    if (cost > 0) {
      gs.spend(cost, 'fuel');
      this.hud.spawnMoneyPopup(-cost);
    }
    gs.addReputation(TOW_REPUTATION);
    const gas = this.serviceSystem.gasStation.position;
    this.minibus.placeAt(gas.x, gas.z - 10, 0);
    this.minibus.refuel(12); // bidon de emergencia para poder moverse un poco
    this.cameraSystem.snap();
    this.hud.showToast(`La grúa te dejó en la gasolinera${cost ? ` · -${cost} Bs` : ''}. Te regalaron un bidón.`, 'tow');
    this.audio.service();
  }

  // ------------------------------------------------------------------
  // Bucle principal
  // ------------------------------------------------------------------
  _onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this._pixelRatio ?? 1);
    this.renderer.setSize(width, height);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(width, height);
    }
    this.particles.setViewportHeight(height * this.renderer.getPixelRatio() * 0.87);
  }

  /** Precompila todos los shaders durante la carga (evita tirones al jugar). */
  warmup() {
    const hidden = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    this.renderer.compile(this.scene, this.camera);
    if (this._useBloom && this.composer) this.composer.render(0);
    else this.renderer.render(this.scene, this.camera);
    for (const o of hidden) o.visible = false;
  }

  /**
   * Resolucion dinamica: si el promedio de cuadros pasa de ~17 ms, baja la
   * resolucion interna; si sobra margen por un rato, la vuelve a subir. Asi
   * el juego se sostiene a 60 FPS sin que el jugador toque los ajustes.
   */
  _adaptResolution(frameMs) {
    if (this.state === 'loading' || this.state === 'paused') return;
    this._frameSamples.push(frameMs);
    if (this._frameSamples.length < 45) return;

    const sorted = [...this._frameSamples].sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length * 0.6)]; // ignora picos sueltos
    this._frameSamples.length = 0;
    this._goodWindows ??= 0;

    if (typical > TARGET_FRAME_MS * 1.1 && this._pixelRatio > this._minPixelRatio + 0.001) {
      this._setPixelRatio(Math.max(this._minPixelRatio, this._pixelRatio - (typical > 25 ? 0.2 : 0.1)));
      this._prCeiling = this._pixelRatio; // no volver a subir enseguida a donde fallo
      this._goodWindows = 0;
    } else if (typical < TARGET_FRAME_MS * 0.97) {
      this._goodWindows++;
      // Tras ~10 s estables se permite probar un escalon mas.
      if (this._goodWindows >= 13) {
        this._goodWindows = 0;
        this._prCeiling = Math.min(this._maxPixelRatio, (this._prCeiling ?? this._maxPixelRatio) + 0.05);
        if (this._pixelRatio < this._prCeiling) this._setPixelRatio(Math.min(this._prCeiling, this._pixelRatio + 0.05));
      }
    } else {
      this._goodWindows = 0;
    }
  }

  _setPixelRatio(pr) {
    this._pixelRatio = Math.round(pr * 100) / 100;
    this._onResize();
  }

  _tick() {
    const now = performance.now();
    if (this._lastFrameTime !== undefined) this._adaptResolution(now - this._lastFrameTime);
    this._lastFrameTime = now;

    // Clamp del delta para evitar saltos grandes si la pestana pierde foco.
    const delta = Math.min(this.clock.getDelta(), 0.1);
    this._elapsed += delta;

    if (document.body.dataset.state !== this.state) document.body.dataset.state = this.state;
    if (this.state === 'playing') this._updatePlaying(delta);
    else this._updateAmbient(delta);

    this._updateWorld(delta);
    this._updateFps(delta);

    this.renderer.info.reset();
    if (this._useBloom && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** Lo que se simula en todos los estados (ciudad viva de fondo). */
  _updateWorld(delta) {
    const simulate = this.state !== 'paused';
    if (simulate) {
      this.trafficSystem.update(delta, this.state === 'playing' ? this.minibus : null, this.trafficLightSystem);
      this.trafficLightSystem.update(delta, this.state === 'playing' ? this.minibus : this._offscreenProbe());
      this.city.animate(delta);
      this.weather.update(delta, this.camera);
      this.particles.update(delta);
      for (const stop of this.routeSystem.stops) {
        if (this.state !== 'playing') stop.pulse(delta, false);
      }
    }

    // Luz del dia aplicada a todo lo que se enciende de noche.
    this.dayNight.rain = this.weather.intensity;
    this.dayNight.flash = this.weather.flash;
    const focus = this.state === 'menu' ? this._tmpVec.set(0, 0, 0) : this.minibus.mesh.position;
    this.dayNight.apply(focus);
    const night = this.dayNight.night;
    if (Math.abs(night - this._lastNight) > 0.004) {
      this._lastNight = night;
      this.city.setNight(night);
      this.minibus.setNight(night);
      setTrafficNight(night);
      this.serviceSystem.gasStation.setNight(night);
      this.serviceSystem.garage.setNight(night);
    }
    const wet = this.weather.intensity;
    if (Math.abs(wet - this._lastWet) > 0.01) {
      this._lastWet = wet;
      this.city.setWet(wet);
    }

    this.sky.follow(this.camera, this._elapsed, this.renderer.getPixelRatio());
  }

  /** Para que los semaforos no registren infracciones fuera del juego. */
  _offscreenProbe() {
    this._probe ??= { mesh: new THREE.Object3D(), speed: 0 };
    this._probe.mesh.position.set(9999, 0, 9999);
    return this._probe;
  }

  _updatePlaying(delta) {
    const input = this.input;
    this.dayNight.tick(delta);

    this.minibus.update(delta, input);

    const collided = this.collisionSystem.resolveVehicleCollisions(this.minibus);
    this._collisionPenaltyCooldown = Math.max(0, this._collisionPenaltyCooldown - delta);
    if (collided && this._collisionPenaltyCooldown <= 0) {
      this.minibus.applyCollisionDamage();
      this.gameState.addReputation(BUILDING_HIT.reputation);
      this._collisionPenaltyCooldown = BUILDING_HIT.cooldown;
      this._crashFeedback(1);
    } else if (!collided) {
      // Manejar sin chocar recupera reputacion lentamente con el tiempo.
      this.gameState.addReputation(0.02 * delta);
    }

    // Choque leve contra trafico NPC: dano menor al de un edificio.
    const trafficCollided = this.trafficSystem.checkPlayerCollision(this.minibus, this.collisionSystem);
    this._trafficCollisionCooldown = Math.max(0, this._trafficCollisionCooldown - delta);
    if (trafficCollided && this._trafficCollisionCooldown <= 0) {
      this.minibus.wear.carroceria = Math.max(0, this.minibus.wear.carroceria - TRAFFIC_HIT.carroceria);
      this.minibus.wear.suspension = Math.max(0, this.minibus.wear.suspension - TRAFFIC_HIT.suspension);
      this.gameState.addReputation(TRAFFIC_HIT.reputation);
      this._trafficCollisionCooldown = TRAFFIC_HIT.cooldown;
      this._crashFeedback(0.6);
    }

    this.routeSystem.update(delta, this.minibus);
    this.serviceSystem.update(delta, this.minibus, this.gameState);
    this.policeSystem.update(delta);
    this.eventSystem.update(delta);
    this.blockadeSystem.update(delta, this.minibus, input, this.collisionSystem);
    this.cameraSystem.update(delta);
    this.particles.updateExhaust(delta, this.minibus);

    this.audio.update({
      speedRatio: Math.min(1, Math.abs(this.minibus.speed) / this.minibus.maxSpeed),
      throttle: this.minibus.telemetry.throttle,
      rain: this.weather.intensity,
      horn: input.horn,
      engineOn: this.minibus.fuel > 0,
      engineHealth: this.minibus.wear.motor / 100,
    });

    this.hud.update({
      gameState: this.gameState,
      routeSystem: this.routeSystem,
      minibus: this.minibus,
      city: this.city,
      serviceSystem: this.serviceSystem,
      dayNight: this.dayNight,
      goal: dailyGoal(this.gameState.day),
      trafficSystem: this.trafficSystem,
      policeSystem: this.policeSystem,
      blockadeSystem: this.blockadeSystem,
    });

    this._autosaveTimer += delta;
    if (this._autosaveTimer > 45) {
      this._autosaveTimer = 0;
      this._saveMidDay();
    }

    if (this.dayNight.isOver) this._endDay();
  }

  _crashFeedback(strength) {
    this.gameState.dayStats.crashes++;
    const front = this._tmpVec.set(0, 0, 2.6).applyMatrix4(this.minibus.mesh.matrixWorld);
    this.particles.burst(front, strength);
    this.cameraSystem.shake(0.6 * strength);
    this.hud.flashHit(strength);
    this.audio.crash(strength);
  }

  /** Menu y fin de jornada: camara cinematica alrededor de la ciudad o del minibus. */
  _updateAmbient(delta) {
    if (this.state === 'menu' || this.state === 'loading') {
      // Atardecer que va y viene: se lucen el neon, los faroles y el sol bajo.
      this.dayNight.setHour(18.75 + Math.sin(this._elapsed * 0.05) * 0.85);
      this._menuAngle += delta * 0.035;
      const r = 128;
      this.camera.position.set(Math.cos(this._menuAngle) * r, 42 + Math.sin(this._elapsed * 0.2) * 4, Math.sin(this._menuAngle) * r);
      this.camera.lookAt(0, 8, 0);
      if (this.camera.fov !== 55) {
        this.camera.fov = 55;
        this.camera.updateProjectionMatrix();
      }
    } else if (this.state === 'dayend') {
      this._menuAngle += delta * 0.12;
      const p = this.minibus.mesh.position;
      this.camera.position.set(p.x + Math.cos(this._menuAngle) * 11, 4.5, p.z + Math.sin(this._menuAngle) * 11);
      this.camera.lookAt(p.x, 1.4, p.z);
    }
  }

  _updateFps(delta) {
    this._fpsFrames++;
    this._fpsTimer += delta;
    if (this._fpsTimer >= 0.5) {
      this._fps = Math.round(this._fpsFrames / this._fpsTimer);
      this._fpsFrames = 0;
      this._fpsTimer = 0;
      const info = this.renderer.info.render;
      this.hud.setFps(
        `${this._fps} FPS · res ${this._pixelRatio.toFixed(2)}x · ${info.calls} draws`,
        this.settings.showFps && this.state === 'playing'
      );
    }
  }
}
