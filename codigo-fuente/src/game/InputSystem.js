/**
 * InputSystem
 * Centraliza la lectura de teclado. Otros sistemas consultan el estado
 * en vez de escuchar eventos por su cuenta, para evitar duplicar listeners.
 *
 * `enabled` permite congelar el control del vehiculo mientras hay un menu
 * abierto (pausa, fin de jornada). Las teclas registradas con
 * `{ always: true }` (ej. ESC) siguen respondiendo igual.
 */
export class InputSystem {
  constructor() {
    this.keys = new Set();
    this.enabled = true;
    // Entradas virtuales (controles tactiles): se comportan como teclas mantenidas.
    this.virtual = new Set();

    // Callbacks para teclas "de un solo disparo" (no mantenidas), como C o ESC.
    this._onKeyDownOnce = new Map(); // code -> [{ callback, always }]

    window.addEventListener('keydown', (event) => this._handleKeyDown(event));
    window.addEventListener('keyup', (event) => this._handleKeyUp(event));
    // Si la ventana pierde foco, soltar todo (evita quedar acelerando "pegado").
    window.addEventListener('blur', () => this.keys.clear());

    // Evita que el scroll de la pagina se mueva con flechas/espacio.
    window.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) {
        event.preventDefault();
      }
    });
  }

  _handleKeyDown(event) {
    const code = event.code;
    if (!this.keys.has(code)) {
      for (const { callback, always } of this._onKeyDownOnce.get(code) ?? []) {
        if (always || this.enabled) callback();
      }
    }
    this.keys.add(code);
  }

  _handleKeyUp(event) {
    this.keys.delete(event.code);
  }

  /** Registra una funcion que se dispara una sola vez al presionar `code`. */
  onKeyPressed(code, callback, { always = false } = {}) {
    if (!this._onKeyDownOnce.has(code)) this._onKeyDownOnce.set(code, []);
    this._onKeyDownOnce.get(code).push({ callback, always });
  }

  isDown(code) {
    return this.enabled && (this.keys.has(code) || this.virtual.has(code));
  }

  /** Mantiene/suelta una tecla virtual (botones tactiles). */
  setVirtual(code, down) {
    if (down) this.virtual.add(code);
    else this.virtual.delete(code);
  }

  releaseVirtual() {
    this.virtual.clear();
  }

  /** Dispara una tecla "de un solo disparo" desde la pantalla tactil. */
  tap(code) {
    for (const { callback, always } of this._onKeyDownOnce.get(code) ?? []) {
      if (always || this.enabled) callback();
    }
  }

  // Helpers de alto nivel usados por el vehiculo.
  get throttle() {
    return this.isDown('KeyW') || this.isDown('ArrowUp');
  }

  get brakeOrReverse() {
    return this.isDown('KeyS') || this.isDown('ArrowDown');
  }

  get steerLeft() {
    return this.isDown('KeyA') || this.isDown('ArrowLeft');
  }

  get steerRight() {
    return this.isDown('KeyD') || this.isDown('ArrowRight');
  }

  get handbrake() {
    return this.isDown('Space');
  }

  get horn() {
    return this.isDown('KeyH');
  }
}
