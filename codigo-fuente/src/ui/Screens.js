import { UPGRADES, MAX_UPGRADE_LEVEL } from '../game/config.js';

const $ = (id) => document.getElementById(id);

const QUALITY_NOTES = {
  baja: 'Sin sombras ni brillo de neón, menos partículas. Para equipos modestos.',
  media: 'Sombras simples y brillo de neón. Buen equilibrio.',
  alta: 'Sombras suaves, brillo de neón y todas las partículas.',
};

/**
 * Screens
 * Controla las pantallas superpuestas (menu principal, pausa, como
 * manejar, ajustes, fin de jornada) y la tarjeta de inicio de jornada.
 * No conoce la logica del juego: emite acciones con `onAction(name, data)`.
 */
export class Screens {
  constructor({ audio, settings, onAction, onSettingsChange }) {
    this.audio = audio;
    this.settings = settings;
    this.onAction = onAction;
    this.onSettingsChange = onSettingsChange;

    this.screens = {
      menu: $('screen-menu'),
      pause: $('screen-pause'),
      howto: $('screen-howto'),
      settings: $('screen-settings'),
      dayend: $('screen-dayend'),
    };
    this.current = null;
    this._stack = []; // para "volver" desde ayuda/ajustes

    this._bindButtons();
    this._bindSettings();
  }

  _bindButtons() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      this.audio.unlock();
      this.audio.uiClick();
      const action = btn.dataset.action;
      if (action === 'howto' || action === 'settings') {
        this.push(action);
      } else if (action === 'back') {
        this.back();
      } else {
        this.onAction(action, btn.dataset);
      }
    });

    // Sonido sutil al pasar por los letreros/botones.
    document.addEventListener('pointerover', (e) => {
      const btn = e.target.closest('.sign, .btn, .seg button, .shop-buy');
      if (btn && !btn.contains(e.relatedTarget)) this.audio.uiHover();
    });
  }

  _bindSettings() {
    for (const seg of document.querySelectorAll('.seg[data-setting]')) {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-value]');
        if (!b) return;
        const key = seg.dataset.setting;
        let value = b.dataset.value;
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        this.settings[key] = value;
        this._syncSettingsUI();
        this.onSettingsChange(this.settings);
      });
    }
    const slider = $('volume-slider');
    slider.addEventListener('input', () => {
      this.settings.volume = Number(slider.value) / 100;
      this._syncSettingsUI();
      this.onSettingsChange(this.settings);
    });
    this._syncSettingsUI();
  }

  _syncSettingsUI() {
    for (const seg of document.querySelectorAll('.seg[data-setting]')) {
      const value = String(this.settings[seg.dataset.setting]);
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.value === value);
    }
    $('volume-slider').value = Math.round(this.settings.volume * 100);
    $('volume-value').textContent = `${Math.round(this.settings.volume * 100)}%`;
    $('quality-note').textContent = QUALITY_NOTES[this.settings.quality];
  }

  // ------------------------------------------------------------------
  // Navegacion
  // ------------------------------------------------------------------
  show(name) {
    for (const [key, el] of Object.entries(this.screens)) el.classList.toggle('is-hidden', key !== name);
    this.current = name;
    this._stack = name ? [name] : [];
    if (name) this._focusFirst(name);
  }

  hideAll() {
    this.show(null);
  }

  push(name) {
    if (this.current) this.screens[this.current].classList.add('is-hidden');
    this.screens[name].classList.remove('is-hidden');
    this._stack.push(name);
    this.current = name;
    this._focusFirst(name);
  }

  back() {
    if (this._stack.length <= 1) return false;
    const top = this._stack.pop();
    this.screens[top].classList.add('is-hidden');
    this.current = this._stack[this._stack.length - 1];
    this.screens[this.current].classList.remove('is-hidden');
    return true;
  }

  _focusFirst(name) {
    const first = this.screens[name]?.querySelector('button:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------
  // Contenido dinamico
  // ------------------------------------------------------------------
  setContinue(save) {
    const btn = $('btn-continue');
    btn.disabled = !save;
    btn.classList.toggle('is-disabled', !save);
    $('continue-detail').textContent = save
      ? `Jornada ${save.day} · ${Math.floor(save.money)} Bs · ${save.clock ?? '06:00'}`
      : 'No hay partida guardada';
  }

  renderPause({ day, clock, money, earned, goal, routes, passengers, reputation }) {
    $('pause-ticket').textContent = String(100000 + day * 101 + passengers).padStart(6, '0');
    $('pause-stats').innerHTML = [
      ['Jornada', `${day} · ${clock}`],
      ['En el bolsillo', `${Math.floor(money)} Bs`],
      ['Meta del día', `${Math.floor(earned)} / ${goal} Bs`],
      ['Rutas completas', routes],
      ['Pasajeros', passengers],
      ['Reputación', reputation],
    ]
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
      .join('');
  }

  /**
   * Planilla del fin de jornada + tienda de mejoras.
   * @param {object} s - resumen { day, stats, goal, net, stars, reputation }
   * @param {object} shop - { money, levels }
   */
  renderDayEnd(s, shop) {
    $('de-day').textContent = s.day;
    const st = s.stats;
    const rows = [
      ['Pasajes cobrados', `${st.passengers} pasajeros`, null],
      ['Rutas completas', `${st.routes}`, null],
      ['Ingresos', `+${Math.floor(st.earned)} Bs`, 'pos'],
      ['Combustible', st.fuelSpent ? `−${Math.floor(st.fuelSpent)} Bs` : '—', st.fuelSpent ? 'neg' : null],
      ['Taller', st.repairSpent ? `−${Math.floor(st.repairSpent)} Bs` : '—', st.repairSpent ? 'neg' : null],
      [`Multas (${st.finesCount})`, st.fines ? `−${Math.floor(st.fines)} Bs` : '—', st.fines ? 'neg' : null],
      ['Choques', `${st.crashes}`, st.crashes ? 'neg' : null],
    ];
    $('de-rows').innerHTML = rows.map(([k, v, c]) => `<tr><th>${k}</th><td class="${c ?? ''}">${v}</td></tr>`).join('');
    const net = Math.floor(s.net);
    const netEl = $('de-net');
    netEl.textContent = `${net >= 0 ? '+' : '−'}${Math.abs(net)} Bs`;
    netEl.className = net >= 0 ? 'pos' : 'neg';

    const stamp = $('de-stamp');
    const reached = st.earned >= s.goal;
    stamp.textContent = reached ? 'META CUMPLIDA' : `FALTARON ${Math.ceil(s.goal - st.earned)} Bs`;
    stamp.classList.toggle('is-fail', !reached);
    stamp.classList.remove('stamp-in');
    void stamp.offsetWidth;
    stamp.classList.add('stamp-in');

    $('de-stars').innerHTML = Array.from(
      { length: 3 },
      (_, i) => `<svg class="star ${i < s.stars ? 'on' : ''}" style="--d:${0.35 + i * 0.18}s"><use href="#i-star"/></svg>`
    ).join('');

    this.renderShop(shop);
  }

  renderShop({ money, levels }) {
    $('shop-money').textContent = `${Math.floor(money)} Bs`;
    $('shop-items').innerHTML = UPGRADES.map((u) => {
      const level = levels[u.id] ?? 0;
      const maxed = level >= MAX_UPGRADE_LEVEL;
      const cost = maxed ? 0 : u.costs[level];
      const affordable = !maxed && money >= cost;
      const pips = Array.from({ length: MAX_UPGRADE_LEVEL }, (_, i) => `<i class="${i < level ? 'on' : ''}"></i>`).join('');
      return `
        <article class="shop-item ${maxed ? 'is-max' : ''}">
          <div class="shop-info">
            <h4>${u.name}</h4>
            <p>${u.desc}</p>
            <div class="pips">${pips}</div>
          </div>
          <button class="shop-buy" data-action="buy" data-id="${u.id}" ${affordable ? '' : 'disabled'}>
            ${maxed ? 'Al máximo' : `${cost} Bs`}
          </button>
        </article>`;
    }).join('');
  }

  /** Tarjeta grande al empezar cada jornada. */
  showDayIntro(day, goal, clock = '06:00') {
    const el = $('day-intro');
    $('di-title').textContent = `JORNADA ${day}`;
    $('di-goal').textContent = `Meta del día: ${goal} Bs`;
    el.querySelector('.di-time').textContent = `${clock} · LA PAZ — EL ALTO`;
    el.classList.remove('is-hidden', 'play');
    void el.offsetWidth;
    el.classList.add('play');
    clearTimeout(this._introTimer);
    this._introTimer = setTimeout(() => el.classList.add('is-hidden'), 3200);
  }

  setLoading(progress, text) {
    $('loading-bar-fill').style.transform = `scaleX(${progress})`;
    if (text) $('loading-text').textContent = text;
  }

  hideLoading() {
    $('loading-screen').classList.add('is-gone');
  }
}
