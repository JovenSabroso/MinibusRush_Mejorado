/**
 * TouchControls
 * Controles tactiles para telefonos y tablets: volante (izq/der), acelerador,
 * freno/reversa, freno de mano y botones de accion. Usa Pointer Events con
 * captura (multitouch real: se puede girar y acelerar a la vez) y
 * `touch-action: none` para que el gesto no desplace ni haga zoom en la pagina.
 * Solo se muestra en dispositivos tactiles y mientras se esta jugando.
 */
const BUTTONS = [
  // [clase, codigo, etiqueta, tipo]
  ['tc-left', 'ArrowLeft', '◀', 'hold'],
  ['tc-right', 'ArrowRight', '▶', 'hold'],
  ['tc-gas', 'ArrowUp', 'ACEL', 'hold'],
  ['tc-brake', 'ArrowDown', 'FRENO', 'hold'],
  ['tc-hand', 'Space', 'MANO', 'hold'],
  ['tc-horn', 'KeyH', 'BOCINA', 'hold'],
  ['tc-cam', 'KeyC', 'CÁM', 'tap'],
  ['tc-act', 'KeyF', 'F', 'tap'],
  ['tc-fix', 'KeyG', 'G', 'tap'],
  ['tc-pause', 'Escape', 'II', 'tap'],
];

export class TouchControls {
  constructor(input) {
    this.input = input;
    const isTouch = window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    if (!isTouch) return;

    document.body.classList.add('has-touch');
    const root = document.createElement('div');
    root.id = 'touch-controls';
    root.setAttribute('aria-label', 'Controles táctiles');

    for (const [cls, code, label, kind] of BUTTONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tc-btn ${cls}`;
      b.textContent = label;
      b.setAttribute('aria-label', label);
      if (kind === 'hold') this._bindHold(b, code);
      else this._bindTap(b, code);
      root.appendChild(b);
    }
    document.getElementById('app').appendChild(root);

    // El gesto sobre los controles nunca debe mover la pagina.
    root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this._releaseAll());
    document.addEventListener('visibilitychange', () => document.hidden && this._releaseAll());
  }

  _bindHold(el, code) {
    const down = (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* navegador sin captura */ }
      this.input.setVirtual(code, true);
      el.classList.add('is-down');
      navigator.vibrate?.(8);
    };
    const up = (e) => {
      e.preventDefault();
      this.input.setVirtual(code, false);
      el.classList.remove('is-down');
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  _bindTap(el, code) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('is-down');
      this.input.tap(code);
      navigator.vibrate?.(8);
    });
    const up = () => el.classList.remove('is-down');
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  _releaseAll() {
    this.input.releaseVirtual();
    document.querySelectorAll('#touch-controls .is-down').forEach((n) => n.classList.remove('is-down'));
  }
}
