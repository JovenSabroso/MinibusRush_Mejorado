const $ = (id) => document.getElementById(id);

const WEAR_LABELS = [
  ['motor', 'MOT', 'Motor'],
  ['frenos', 'FRE', 'Frenos'],
  ['neumaticos', 'LLA', 'Llantas'],
  ['suspension', 'SUS', 'Suspensión'],
  ['carroceria', 'CAR', 'Carrocería'],
];

// Los avisos de los sistemas traen un emoji al inicio; aqui se traduce a
// una etiqueta con color propio para que el feed se lea de un vistazo.
const TOAST_KINDS = [
  ['🚓', 'police', 'Policía'],
  ['🌧', 'weather', 'Clima'],
  ['🚧', 'road', 'Vía'],
  ['🔧', 'mech', 'Mecánica'],
  ['👥', 'people', 'Demanda'],
  ['🚦', 'traffic', 'Tráfico'],
];
const KIND_LABELS = { service: 'Servicio', bad: 'Ojo', good: 'Bien', info: 'Aviso', tow: 'Grúa' };

const SPEEDO_MAX = 70; // km/h al final del arco
const SPEEDO_ARC = Math.PI * 90; // largo del semicirculo (r = 90)

/**
 * HUD
 * Puente entre el estado del juego y el DOM. No contiene logica de juego:
 * solo lee y pinta. Para no tocar el DOM 60 veces por segundo, cada valor
 * se escribe unicamente cuando cambia.
 */
export class HUD {
  constructor({ stopNames, capacity }) {
    this.root = $('hud');
    // Ultimo valor escrito por elemento: evita tocar el DOM si no cambio.
    this._textCache = new WeakMap();
    this._styleCache = new WeakMap();
    this._classCache = new WeakMap();

    this.el = {
      dayNum: $('hud-day-num'),
      clock: $('hud-clock'),
      money: $('money-readout'),
      moneyPopups: $('money-popups'),
      goalText: $('goal-readout'),
      goalFill: $('goal-fill'),
      repText: $('reputation-readout'),
      stars: $('rep-stars'),
      stopName: $('gps-stop-name'),
      distance: $('gps-distance'),
      arrow: $('gps-arrow'),
      routeLine: $('route-line'),
      speed: $('speed-readout'),
      needle: $('speedo-needle'),
      speedArc: $('speedo-arc'),
      fuelFill: $('fuel-fill'),
      fuelText: $('fuel-readout'),
      pax: $('passengers-readout'),
      seatGrid: $('seat-grid'),
      wearBars: $('wear-bars'),
      prompt: $('prompt'),
      promptKey: $('prompt-key'),
      promptTitle: $('prompt-title'),
      promptDetail: $('prompt-detail'),
      promptRing: $('prompt-ring'),
      promptRingFill: $('prompt-ring-fill'),
      toastStack: $('toast-stack'),
      routeBanner: $('route-complete-banner'),
      routeDetail: $('route-complete-detail'),
      cameraLabel: $('camera-label'),
      fps: $('fps'),
      fxHit: $('fx-hit'),
      fxCritical: $('fx-critical'),
    };

    this._buildStars();
    this._buildRouteLine(stopNames);
    this._buildSeats(capacity);
    this._buildWearBars();
    this._buildSpeedoTicks();

    this.minimapCanvas = $('minimap-canvas');
    this.minimapCtx = this.minimapCanvas.getContext('2d');
    this._mapBackground = null; // canvas con las manzanas pre-dibujadas

    this._cameraTimer = null;
  }

  show(visible) {
    this.root.classList.toggle('is-hidden', !visible);
  }

  // ------------------------------------------------------------------
  // Construccion de elementos repetidos
  // ------------------------------------------------------------------
  _buildStars() {
    this.el.stars.innerHTML = Array.from({ length: 5 }, () => '<svg class="star"><use href="#i-star"/></svg>').join('');
    this._starEls = [...this.el.stars.children];
  }

  _buildRouteLine(names) {
    this.el.routeLine.innerHTML = names.map((n, i) => `<li data-i="${i}"><i></i><span>${n}</span></li>`).join('');
    this._routeEls = [...this.el.routeLine.children];
  }

  _buildSeats(capacity) {
    this.el.seatGrid.innerHTML = Array.from({ length: capacity }, () => '<i></i>').join('');
    this._seatEls = [...this.el.seatGrid.children];
  }

  _buildWearBars() {
    this.el.wearBars.innerHTML = WEAR_LABELS.map(
      ([key, short, long]) => `<div class="wear" data-key="${key}" title="${long}"><div class="wear-track"><i></i></div><label>${short}</label></div>`
    ).join('');
    this._wearEls = Object.fromEntries(
      WEAR_LABELS.map(([key]) => {
        const el = this.el.wearBars.querySelector(`[data-key="${key}"]`);
        return [key, { root: el, fill: el.querySelector('i') }];
      })
    );
  }

  _buildSpeedoTicks() {
    const g = document.getElementById('speedo-ticks');
    let html = '';
    for (let v = 0; v <= SPEEDO_MAX; v += 5) {
      const a = Math.PI - (v / SPEEDO_MAX) * Math.PI;
      const major = v % 10 === 0;
      const r1 = major ? 72 : 78;
      const x1 = 120 + Math.cos(a) * r1;
      const y1 = 130 - Math.sin(a) * r1;
      const x2 = 120 + Math.cos(a) * 84;
      const y2 = 130 - Math.sin(a) * 84;
      html += `<line class="${major ? 'tick-major' : 'tick'}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
      if (major) {
        const lx = 120 + Math.cos(a) * 58;
        const ly = 130 - Math.sin(a) * 58 + 4;
        html += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}">${v}</text>`;
      }
    }
    g.innerHTML = html;
    this.el.speedArc.style.strokeDasharray = `${SPEEDO_ARC}`;
  }

  // ------------------------------------------------------------------
  // Escritura con cache
  // ------------------------------------------------------------------
  _text(el, value) {
    if (this._textCache.get(el) !== value) {
      this._textCache.set(el, value);
      el.textContent = value;
    }
  }

  _style(el, prop, value) {
    let map = this._styleCache.get(el);
    if (!map) {
      map = {};
      this._styleCache.set(el, map);
    }
    if (map[prop] !== value) {
      map[prop] = value;
      el.style[prop] = value;
    }
  }

  _toggle(el, cls, on) {
    let map = this._classCache.get(el);
    if (!map) {
      map = {};
      this._classCache.set(el, map);
    }
    if (map[cls] !== on) {
      map[cls] = on;
      el.classList.toggle(cls, on);
    }
  }

  // ------------------------------------------------------------------
  // Frame
  // ------------------------------------------------------------------
  /** Llamado una vez por frame desde el loop principal. */
  update({ gameState, routeSystem, minibus, city, serviceSystem, dayNight, goal, trafficSystem, policeSystem, blockadeSystem }) {
    const el = this.el;

    // --- Jornada ---
    this._text(el.dayNum, String(gameState.day));
    this._text(el.clock, dayNight.clockText);
    this._toggle(el.clock, 'is-late', dayNight.hour >= 20.5);
    this._text(el.money, String(Math.floor(gameState.money)));
    const earned = Math.floor(gameState.dayStats.earned);
    this._text(el.goalText, `${earned} / ${goal} Bs`);
    this._style(el.goalFill, 'transform', `scaleX(${Math.min(1, earned / goal).toFixed(3)})`);
    this._toggle(el.goalFill, 'is-done', earned >= goal);

    this._text(el.repText, gameState.reputationLevel);
    const stars = Math.round(gameState.reputation / 20);
    this._starEls.forEach((s, i) => this._toggle(s, 'on', i < stars));

    // --- Letrero LED ---
    const ui = routeSystem.uiState;
    this._text(el.stopName, ui.nextStopName);
    const dist = ui.distanceToNextStop;
    this._text(el.distance, dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist / 5) * 5} m`);
    const stop = routeSystem.currentStop.position;
    const bus = minibus.mesh.position;
    const targetAngle = Math.atan2(stop.x - bus.x, stop.z - bus.z);
    let rel = targetAngle - minibus.mesh.rotation.y;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    this._style(el.arrow, 'transform', `rotate(${(-rel * 180) / Math.PI}deg)`);
    this._routeEls.forEach((li, i) => {
      this._toggle(li, 'done', i < ui.routeIndex);
      this._toggle(li, 'current', i === ui.routeIndex);
    });

    // --- Tablero ---
    const kmh = minibus.speedKmh;
    this._text(el.speed, String(Math.round(kmh)));
    const frac = Math.min(1, kmh / SPEEDO_MAX);
    this._style(el.needle, 'transform', `rotate(${(-90 + frac * 180).toFixed(1)}deg)`);
    this._style(el.speedArc, 'strokeDashoffset', `${(SPEEDO_ARC * (1 - frac)).toFixed(1)}`);

    const fuel = minibus.fuel;
    this._text(el.fuelText, `${Math.round(fuel)}%`);
    this._style(el.fuelFill, 'transform', `scaleX(${(fuel / 100).toFixed(3)})`);
    this._toggle(el.fuelFill.parentElement.parentElement, 'is-low', fuel < 20);

    this._text(el.pax, `${gameState.passengersOnboard}/${gameState.passengerCapacity}`);
    this._seatEls.forEach((s, i) => this._toggle(s, 'on', i < gameState.passengersOnboard));

    // --- Mecanica ---
    let critical = fuel < 12;
    for (const [key] of WEAR_LABELS) {
      const value = minibus.wear[key];
      const w = this._wearEls[key];
      this._style(w.fill, 'transform', `scaleY(${(value / 100).toFixed(3)})`);
      this._toggle(w.root, 'warn', value < 40 && value >= 20);
      this._toggle(w.root, 'bad', value < 20);
      if (value < 15) critical = true;
    }
    this._toggle(el.fxCritical, 'on', critical);

    this._updatePrompt(ui, serviceSystem, minibus, routeSystem);
    this._updateRouteBanner(ui);
    // El minimapa a ~20 Hz basta y libera el hilo principal.
    this._mapFrame = (this._mapFrame ?? 0) + 1;
    if (this._mapFrame % 3 === 0) this._drawMinimap(routeSystem, minibus, city, serviceSystem, trafficSystem, policeSystem, blockadeSystem);
  }

  _updatePrompt(ui, serviceSystem, minibus, routeSystem) {
    const el = this.el;
    let visible = true;
    let key = '';
    let title = '';
    let detail = '';
    let ring = -1;
    let kind = 'service';

    if (minibus.outOfFuel && Math.abs(minibus.speed) < 0.5) {
      key = 'R';
      title = 'Sin combustible';
      detail = 'Llama a la grúa: te lleva a la gasolinera';
      kind = 'danger';
    } else if (ui.promptVisible) {
      kind = 'stop';
      title = routeSystem.currentStop.name;
      if (ui.boarding) {
        detail = ui.boardingProgress < 1 ? 'Abriendo la puerta…' : `Subiendo · quedan ${ui.waitingAtCurrent}`;
        ring = ui.boardingProgress < 1 ? ui.boardingProgress : 1;
      } else {
        detail = `${ui.waitingAtCurrent} esperando · frena aquí`;
        ring = 0;
      }
    } else if (serviceSystem.uiState.fuelPromptVisible) {
      key = 'F';
      title = 'Gasolinera';
      detail = `Llenar el tanque · ${serviceSystem.uiState.fuelCost} Bs`;
    } else if (serviceSystem.uiState.garagePromptVisible) {
      key = 'G';
      title = 'Taller mecánico';
      detail = `Reparación completa · ${serviceSystem.uiState.repairCost} Bs`;
    } else {
      visible = false;
    }

    this._toggle(el.prompt, 'is-hidden', !visible);
    if (!visible) return;
    this._text(el.promptKey, key);
    this._toggle(el.promptKey, 'is-hidden', !key);
    this._text(el.promptTitle, title);
    this._text(el.promptDetail, detail);
    this._toggle(el.prompt, 'kind-stop', kind === 'stop');
    this._toggle(el.prompt, 'kind-danger', kind === 'danger');
    this._toggle(el.promptRing, 'is-hidden', ring < 0);
    if (ring >= 0) this._style(el.promptRingFill, 'strokeDashoffset', `${(94.25 * (1 - ring)).toFixed(1)}`);
  }

  _updateRouteBanner(ui) {
    this._toggle(this.el.routeBanner, 'is-hidden', !ui.routeCompleteVisible);
    if (ui.routeCompleteVisible) {
      const count = ui.passengersDroppedOff;
      const passengerLine = count > 0 ? `${count} pasajero${count === 1 ? '' : 's'} bajaron · ` : '';
      this._text(this.el.routeDetail, `${passengerLine}+${ui.lastBonus} Bs de bono`);
    }
  }

  // ------------------------------------------------------------------
  // Eventos puntuales
  // ------------------------------------------------------------------
  /** Muestra un "+X Bs" flotante junto al contador de dinero. */
  spawnMoneyPopup(amount) {
    const popup = document.createElement('div');
    popup.className = amount >= 0 ? 'money-popup' : 'money-popup is-negative';
    popup.textContent = `${amount >= 0 ? '+' : '−'}${Math.abs(amount)}`;
    this.el.moneyPopups.appendChild(popup);
    setTimeout(() => popup.remove(), 1300);
  }

  /** Aviso en el feed lateral. `kind`: service | bad | good | info | police... */
  showToast(text, kind = null) {
    let label = null;
    let clean = text.trim();
    for (const [emoji, k, l] of TOAST_KINDS) {
      if (clean.startsWith(emoji)) {
        kind = kind ?? k;
        label = l;
        clean = clean.slice(emoji.length).replace(/^️/, '').trim();
        break;
      }
    }
    kind = kind ?? 'info';
    label = label ?? KIND_LABELS[kind] ?? 'Aviso';

    const toast = document.createElement('div');
    toast.className = `toast toast-${kind}`;
    toast.innerHTML = `<span class="toast-tag"></span><span class="toast-text"></span>`;
    toast.firstChild.textContent = label;
    toast.lastChild.textContent = clean;
    this.el.toastStack.prepend(toast);

    while (this.el.toastStack.children.length > 4) this.el.toastStack.lastChild.remove();
    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 400);
    }, 4200);
  }

  /** Destello rojo en los bordes al chocar. */
  flashHit(strength = 1) {
    const fx = this.el.fxHit;
    fx.style.setProperty('--hit', String(Math.min(1, 0.45 + strength * 0.4)));
    fx.classList.remove('on');
    void fx.offsetWidth; // reinicia la animacion CSS
    fx.classList.add('on');
  }

  showCameraLabel(name) {
    this.el.cameraLabel.textContent = name;
    this.el.cameraLabel.classList.remove('is-hidden');
    clearTimeout(this._cameraTimer);
    this._cameraTimer = setTimeout(() => this.el.cameraLabel.classList.add('is-hidden'), 1400);
  }

  setFps(text, visible) {
    this.el.fps.classList.toggle('is-hidden', !visible);
    if (visible) this._text(this.el.fps, text);
  }

  clearTransient() {
    this.el.toastStack.innerHTML = '';
    this.el.moneyPopups.innerHTML = '';
  }

  // ------------------------------------------------------------------
  // Minimapa (norte arriba; el eje X se espeja para que coincida con lo
  // que ve el jugador detras del minibus)
  // ------------------------------------------------------------------
  _drawMapBackground(city, size, toMap, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#1d1f22';
    ctx.fillRect(0, 0, size, size);

    const colors = { houses: '#3a3631', cholet: '#5b2a6e', market: '#6b3b1d', gas: '#2a2c2f', garage: '#2a2c2f' };
    for (const b of city.minimapBlocks) {
      const p = toMap(b.x, b.z);
      const s = b.size * scale;
      ctx.fillStyle = colors[b.type] ?? colors.houses;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    return canvas;
  }

  _drawMinimap(routeSystem, minibus, city, serviceSystem, trafficSystem, policeSystem, blockadeSystem) {
    const ctx = this.minimapCtx;
    const size = this.minimapCanvas.width;
    const range = city.halfExtentX + city.streetWidth + 4;
    const scale = size / 2 / range;
    const toMap = (x, z) => ({ x: size / 2 - x * scale, y: size / 2 - z * scale });

    if (!this._mapBackground) this._mapBackground = this._drawMapBackground(city, size, toMap, scale);
    ctx.drawImage(this._mapBackground, 0, 0);

    // Linea de ruta entre paradas.
    ctx.strokeStyle = 'rgba(242, 183, 5, 0.75)';
    ctx.lineWidth = 4;
    ctx.setLineDash([10, 7]);
    ctx.beginPath();
    routeSystem.stops.forEach((stop, i) => {
      const p = toMap(stop.position.x, stop.position.z);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Trafico (puntos tenues).
    if (trafficSystem) {
      ctx.fillStyle = 'rgba(200, 205, 212, 0.55)';
      for (const v of trafficSystem.vehicles) {
        const p = toMap(v.mesh.position.x, v.mesh.position.z);
        ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
      }
    }

    // Servicios: gasolinera (rojo) y taller (amarillo).
    const icon = (pos, fill, letter) => {
      const p = toMap(pos.x, pos.z);
      ctx.fillStyle = fill;
      ctx.fillRect(p.x - 11, p.y - 11, 22, 22);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 3;
      ctx.strokeRect(p.x - 11, p.y - 11, 22, 22);
      ctx.fillStyle = '#111';
      ctx.font = 'bold 15px "Barlow Condensed", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, p.x, p.y + 1);
    };
    icon(serviceSystem.gasStation.position, '#e8452c', 'F');
    icon(serviceSystem.garage.position, '#f2b705', 'G');

    if (policeSystem) {
      for (const cp of policeSystem.checkpoints) {
        const p = toMap(cp.position.x, cp.position.z);
        ctx.fillStyle = '#3d8bff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Bloqueo: barra roja atravesando la calle cerrada.
    if (blockadeSystem?.active) {
      const r = blockadeSystem.rect;
      const a = toMap(r.minX, r.minZ);
      const b = toMap(r.maxX, r.maxZ);
      const blink = 0.6 + 0.4 * Math.sin(performance.now() * 0.01);
      ctx.fillStyle = `rgba(228, 40, 30, ${blink})`;
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 2;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }

    // Paradas numeradas.
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
    routeSystem.stops.forEach((stop, i) => {
      const p = toMap(stop.position.x, stop.position.z);
      const current = i === routeSystem.currentIndex;
      const done = i < routeSystem.currentIndex;
      if (current) {
        ctx.fillStyle = `rgba(242, 183, 5, ${0.25 + pulse * 0.3})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 18 + pulse * 6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = current ? '#f2b705' : done ? '#2fa36b' : '#e9e4d8';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.font = 'bold 14px "Barlow Condensed", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y + 1);
    });

    // Jugador.
    const pp = toMap(minibus.mesh.position.x, minibus.mesh.position.z);
    ctx.save();
    ctx.translate(pp.x, pp.y);
    ctx.rotate(-minibus.mesh.rotation.y);
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(10, 10);
    ctx.lineTo(0, 5);
    ctx.lineTo(-10, 10);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#e8452c';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }
}
