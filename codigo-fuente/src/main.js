// Fuentes empaquetadas localmente: el juego se ve igual sin internet
// (importante para la exposicion).
import '@fontsource/bungee/400.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '@fontsource/vt323/400.css';
import './style.css';

import { Game } from './game/index.js';
import { AudioSystem } from './game/AudioSystem.js';
import { SaveSystem } from './game/SaveSystem.js';
import { Screens } from './ui/Screens.js';
import { TouchControls } from './ui/TouchControls.js';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

function showFatal(message) {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = message;
  document.getElementById('loading-screen')?.classList.add('is-error');
}

/**
 * Punto de entrada: pantalla de carga -> genera la ciudad -> menu principal.
 * Las pantallas (menu, pausa, ajustes...) emiten acciones y aqui se
 * traducen a llamadas sobre el Game.
 */
async function boot() {
  const settings = SaveSystem.loadSettings();
  const audio = new AudioSystem();
  let game = null;

  const screens = new Screens({
    audio,
    settings,
    onAction: (action, data) => {
      if (!game) return;
      switch (action) {
        case 'new':
          game.newCareer();
          break;
        case 'continue':
          game.continueCareer();
          break;
        case 'resume':
          game.resume();
          break;
        case 'quit':
          game.quitToMenu();
          break;
        case 'next-day':
          game.nextDay();
          break;
        case 'menu':
          game.goToMenu();
          break;
        case 'buy':
          game.buyUpgrade(data.id);
          break;
        default:
          break;
      }
    },
    onSettingsChange: (s) => {
      SaveSystem.saveSettings(s);
      game?.applySettings(s);
    },
  });

  // Sin WebGL no hay juego: mejor un mensaje claro que una pantalla negra.
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2') && !probe.getContext('webgl')) {
    showFatal('Tu navegador no soporta WebGL. Prueba con Chrome, Edge o Firefox actualizados.');
    return;
  }

  screens.setLoading(0.15, 'Levantando la ciudad…');
  await document.fonts?.ready;
  await nextFrame();

  try {
    game = new Game(document.getElementById('game-canvas'), { settings, audio, screens });
  } catch (err) {
    console.error(err);
    showFatal('No se pudo iniciar el juego. Revisa la consola para más detalles.');
    return;
  }

  new TouchControls(game.input);
  screens.setLoading(0.7, 'Prendiendo los faroles…');
  await nextFrame();
  game.warmup();
  screens.setLoading(0.95, 'Calentando el motor…');
  await nextFrame();
  game.start();
  game.goToMenu();
  screens.setLoading(1, '¡Listo!');
  setTimeout(() => screens.hideLoading(), 450);

  // Expuesto para depuracion rapida desde la consola del navegador.
  window.__game = game;
}

boot();
