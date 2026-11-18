/**
 * AudioSystem
 * Todo el sonido se sintetiza con WebAudio (osciladores + ruido filtrado):
 * motor, bocina, monedas, golpes, lluvia, trueno, silbato y sonidos de UI.
 * No hay archivos de audio. El contexto se crea con el primer clic del
 * jugador (los navegadores bloquean el audio sin interaccion).
 *
 * El "voceador" (el ayudante que grita las paradas) usa speechSynthesis
 * cuando el navegador lo soporta y el jugador no lo desactivo.
 */
export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.volume = 0.7;
    this.voiceEnabled = true;
    this._muted = false; // pausa: silencia el motor/lluvia sin destruir nodos
  }

  /** Crea el contexto de audio. Llamar desde un gesto del usuario. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();

    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    // Compresor suave para que bocina + motor + trueno no saturen.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);

    this._noiseBuffer = this._createNoiseBuffer();
    this._buildEngine();
    this._buildRain();
    this._buildHorn();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(this._muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  /** Silencia los loops (motor, lluvia) durante menus/pausa. */
  setMuted(muted) {
    this._muted = muted;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(0, t, 0.08);
    this.rainGain.gain.setTargetAtTime(0, t, 0.2);
    this.hornGain.gain.setTargetAtTime(0, t, 0.02);
  }

  _createNoiseBuffer() {
    const length = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  _noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = true;
    return src;
  }

  // --------------------------- loops ---------------------------

  _buildEngine() {
    // Motor diesel viejo: dos dientes de sierra levemente desafinados +
    // ruido grave, todo por un pasa-bajos que se abre al acelerar.
    const ctx = this.ctx;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;
    this.engineFilter.Q.value = 3;
    this.engineFilter.connect(this.engineGain).connect(this.master);

    this.engineOscA = ctx.createOscillator();
    this.engineOscA.type = 'sawtooth';
    this.engineOscB = ctx.createOscillator();
    this.engineOscB.type = 'square';
    const gA = ctx.createGain();
    gA.gain.value = 0.5;
    const gB = ctx.createGain();
    gB.gain.value = 0.22;
    this.engineOscA.connect(gA).connect(this.engineFilter);
    this.engineOscB.connect(gB).connect(this.engineFilter);

    const rumble = this._noiseSource();
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 180;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.35;
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(this.engineFilter);

    this.engineOscA.start();
    this.engineOscB.start();
    rumble.start();
  }

  _buildRain() {
    const ctx = this.ctx;
    const src = this._noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    src.connect(hp).connect(lp).connect(this.rainGain).connect(this.master);
    src.start();
  }

  _buildHorn() {
    // Bocina tipica de minibus: dos tonos cuadrados en tercera, nasal.
    const ctx = this.ctx;
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 1.2;
    bp.connect(this.hornGain).connect(this.master);
    for (const f of [392, 494]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      o.connect(g).connect(bp);
      o.start();
    }
  }

  /**
   * Actualiza loops cada frame. speedRatio 0..1, throttle bool,
   * rain 0..1, horn bool, engineOn bool.
   */
  update({ speedRatio, throttle, rain, horn, engineOn, engineHealth }) {
    if (!this.ctx || this._muted) return;
    const t = this.ctx.currentTime;
    const base = engineOn ? 34 + speedRatio * 70 + (throttle ? 10 : 0) : 0;
    // Motor gastado: un poco de "tos" (variacion aleatoria de tono).
    const cough = engineOn ? (1 - engineHealth) * (Math.random() - 0.5) * 8 : 0;
    this.engineOscA.frequency.setTargetAtTime(base + cough, t, 0.08);
    this.engineOscB.frequency.setTargetAtTime(base * 0.5 + 0.7, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(260 + speedRatio * 900 + (throttle ? 500 : 0), t, 0.1);
    this.engineGain.gain.setTargetAtTime(engineOn ? 0.1 + speedRatio * 0.06 + (throttle ? 0.05 : 0) : 0, t, 0.12);

    this.rainGain.gain.setTargetAtTime(rain * 0.16, t, 0.3);
    this.hornGain.gain.setTargetAtTime(horn ? 0.32 : 0, t, horn ? 0.01 : 0.03);
  }

  // --------------------------- one-shots ---------------------------

  _tone(freq, duration, { type = 'sine', gain = 0.2, delay = 0, slideTo = null } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + duration + 0.05);
  }

  _noiseBurst(duration, { freq = 400, type = 'lowpass', gain = 0.4, delay = 0 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const src = this._noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.05);
  }

  coin() {
    this._tone(1568, 0.09, { type: 'square', gain: 0.06 });
    this._tone(2093, 0.25, { type: 'square', gain: 0.06, delay: 0.07 });
  }

  crash(strength = 1) {
    this._noiseBurst(0.35, { freq: 260, gain: 0.55 * strength });
    this._tone(70, 0.3, { type: 'sine', gain: 0.4 * strength, slideTo: 40 });
    this._noiseBurst(0.15, { freq: 3000, type: 'highpass', gain: 0.12 * strength, delay: 0.02 });
  }

  thunder(strength = 1) {
    this._noiseBurst(2.8, { freq: 120, gain: 0.8 * strength });
    this._noiseBurst(1.2, { freq: 400, gain: 0.25 * strength, delay: 0.05 });
  }

  whistle() {
    // Silbato del policia: tono agudo con vibrato rapido, dos pitazos.
    if (!this.ctx) return;
    for (const delay of [0, 0.38]) {
      const t = this.ctx.currentTime + delay;
      const o = this.ctx.createOscillator();
      o.frequency.value = 2900;
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 32;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 120;
      lfo.connect(lfoGain).connect(o.frequency);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.setValueAtTime(0.12, t + 0.24);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(this.master);
      o.start(t);
      lfo.start(t);
      o.stop(t + 0.32);
      lfo.stop(t + 0.32);
    }
  }

  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 0.28, { type: 'triangle', gain: 0.14, delay: i * 0.1 }));
  }

  service() {
    this._tone(660, 0.12, { type: 'triangle', gain: 0.12 });
    this._tone(990, 0.2, { type: 'triangle', gain: 0.12, delay: 0.1 });
  }

  denied() {
    this._tone(220, 0.18, { type: 'square', gain: 0.08 });
    this._tone(165, 0.25, { type: 'square', gain: 0.08, delay: 0.14 });
  }

  uiHover() {
    this._tone(1200, 0.04, { type: 'square', gain: 0.025 });
  }

  uiClick() {
    this._tone(520, 0.06, { type: 'square', gain: 0.06 });
    this._tone(780, 0.08, { type: 'square', gain: 0.05, delay: 0.04 });
  }

  alert() {
    this._tone(880, 0.12, { type: 'triangle', gain: 0.1 });
    this._tone(660, 0.16, { type: 'triangle', gain: 0.1, delay: 0.12 });
  }

  /** Petardo del bloqueo: chasquido seco + retumbo grave. `volume` baja con la distancia. */
  petardo(volume = 1) {
    if (volume < 0.03) return;
    this._noiseBurst(0.18, { freq: 2400, gain: 0.45 * volume });
    this._noiseBurst(0.7, { freq: 200, gain: 0.5 * volume, delay: 0.01 });
    this._tone(85, 0.3, { gain: 0.35 * volume, slideTo: 40 });
  }

  /** Multitud coreando: murmullo + palmas al ritmo de "¡blo-que-o!". */
  crowd(volume = 1) {
    if (volume < 0.03) return;
    this._noiseBurst(2.2, { freq: 650, type: 'bandpass', gain: 0.35 * volume });
    for (let i = 0; i < 8; i++) {
      this._noiseBurst(0.06, { freq: 2000, type: 'bandpass', gain: 0.3 * volume, delay: i * 0.26 + (i % 3 === 2 ? 0.1 : 0) });
    }
  }

  // --------------------------- voceador ---------------------------

  /** Frase hablada (si el navegador tiene speechSynthesis). */
  shout(text) {
    if (!this.voiceEnabled || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-419';
      const voices = window.speechSynthesis.getVoices();
      const spanish = voices.find((v) => v.lang.startsWith('es-') && /MX|US|419|BO|AR|CO/.test(v.lang)) ?? voices.find((v) => v.lang.startsWith('es'));
      if (spanish) u.voice = spanish;
      u.rate = 1.15;
      u.pitch = 1.15;
      u.volume = Math.min(1, this.volume * 1.2);
      window.speechSynthesis.speak(u);
    } catch {
      /* sin voz: no pasa nada */
    }
  }
}
