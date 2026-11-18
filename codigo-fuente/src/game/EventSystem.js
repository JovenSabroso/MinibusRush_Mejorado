const MIN_INTERVAL = 28; // segundos entre eventos aleatorios
const MAX_INTERVAL = 55;

/**
 * EventSystem
 * Dispara ocasionalmente uno de los eventos del concepto (trafico pesado,
 * lluvia, bloqueo de calle, accidente, control de transito, desperfecto
 * mecanico, mucha demanda de pasajeros). Cada evento es una version
 * simplificada: un efecto corto sobre sistemas que ya existen, mas un
 * aviso en pantalla. Nada de sistemas nuevos pesados (clima/dia-noche
 * completos quedan para la fase 5, como marca el concepto).
 */
export class EventSystem {
  constructor({ minibus, trafficSystem, policeSystem, routeSystem, blockadeSystem, rng, onToast, onRainChange }) {
    this.minibus = minibus;
    this.trafficSystem = trafficSystem;
    this.blockadeSystem = blockadeSystem;
    this.policeSystem = policeSystem;
    this.routeSystem = routeSystem;
    this.rng = rng;
    this.onToast = onToast;
    this.onRainChange = onRainChange;

    this._defaultMaxSpeed = minibus.maxSpeed;
    this._pendingEffects = []; // { timer, onExpire }

    this._nextEventTimer = this._randomInterval();

    this._events = [
      this._heavyTraffic.bind(this),
      this._rain.bind(this),
      this._streetBlock.bind(this),
      this._accident.bind(this),
      this._policeControl.bind(this),
      this._mechanicalFault.bind(this),
      this._highDemand.bind(this),
    ];
  }

  /** Cancela efectos activos (inicio de jornada / reinicio). */
  reset() {
    for (const effect of this._pendingEffects) effect.onExpire();
    this._pendingEffects = [];
    this.blockadeSystem?.clear();
    this._nextEventTimer = this._randomInterval();
  }

  /** Velocidad base del minibus tras aplicar mejoras (el bloqueo de calle la restaura). */
  setDefaultMaxSpeed(value) {
    this._defaultMaxSpeed = value;
  }

  _randomInterval() {
    return MIN_INTERVAL + this.rng() * (MAX_INTERVAL - MIN_INTERVAL);
  }

  _toast(text) {
    if (this.onToast) this.onToast(text);
  }

  update(delta) {
    this._nextEventTimer -= delta;
    if (this._nextEventTimer <= 0) {
      this._triggerRandomEvent();
      this._nextEventTimer = this._randomInterval();
    }

    for (let i = this._pendingEffects.length - 1; i >= 0; i--) {
      const effect = this._pendingEffects[i];
      effect.timer -= delta;
      if (effect.timer <= 0) {
        effect.onExpire();
        this._pendingEffects.splice(i, 1);
      }
    }
  }

  _triggerRandomEvent() {
    const handler = this._events[Math.floor(this.rng() * this._events.length)];
    handler();
  }

  _scheduleExpire(durationSeconds, onExpire) {
    this._pendingEffects.push({ timer: durationSeconds, onExpire });
  }

  _heavyTraffic() {
    this.trafficSystem.setGlobalSpeedMultiplier(0.5, 14);
    this._toast('🚦 Tráfico pesado en la zona: circula más lento.');
  }

  _rain() {
    this.minibus.tractionMultiplier = 0.75;
    if (this.onRainChange) this.onRainChange(true);
    this._toast('🌧️ Empieza a lloviznar: cuidado al frenar y girar.');

    this._scheduleExpire(18, () => {
      this.minibus.tractionMultiplier = 1;
      if (this.onRainChange) this.onRainChange(false);
    });
  }

  /** Bloqueo de calle con gente: cierra una calle por delante del minibus. */
  streetBlock() {
    if (!this.blockadeSystem?.start(this.minibus)) return false;
    this.trafficSystem.clearBlockedZone(this.blockadeSystem);
    this._toast('🚧 ¡Bloqueo! Vecinos tomaron la calle de adelante. Busca otra ruta.');
    return true;
  }

  _streetBlock() {
    // Si ya hay un bloqueo armado, el evento se convierte en trafico pesado.
    if (!this.streetBlock()) this._heavyTraffic();
  }

  _accident() {
    this.trafficSystem.stallRandomVehicle(10);
    this._toast('🚧 Accidente de tránsito: un vehículo quedó detenido en la vía.');
  }

  _policeControl() {
    this.policeSystem.boostVigilance(20);
    this._toast('🚓 Control de tránsito reforzado en la zona.');
  }

  _mechanicalFault() {
    const keys = Object.keys(this.minibus.wear);
    const key = keys[Math.floor(this.rng() * keys.length)];
    const damage = 10 + this.rng() * 8;
    this.minibus.wear[key] = Math.max(0, this.minibus.wear[key] - damage);
    const labels = { motor: 'motor', frenos: 'frenos', neumaticos: 'neumáticos', suspension: 'suspensión', carroceria: 'carrocería' };
    this._toast(`🔧 Se escucha un ruido raro... (${labels[key] ?? key} dañado)`);
  }

  _highDemand() {
    const stop = this.routeSystem.currentStop;
    stop.addExtraWaiting(2 + Math.floor(this.rng() * 2));
    this._toast('👥 ¡Hoy hay mucha gente esperando el micro!');
  }
}
