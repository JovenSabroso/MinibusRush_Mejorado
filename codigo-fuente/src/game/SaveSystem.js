/**
 * SaveSystem
 * Persistencia simple en localStorage: progreso de la carrera (jornada,
 * dinero, estado del minibus, mejoras) y ajustes del jugador por separado.
 * Todas las lecturas/escrituras van en try/catch: en modo privado o con el
 * almacenamiento bloqueado el juego sigue funcionando, solo que sin guardar.
 */

const SAVE_KEY = 'minibus-rush.save.v1';
const SETTINGS_KEY = 'minibus-rush.settings.v1';

export const DEFAULT_SETTINGS = {
  quality: 'alta', // 'baja' | 'media' | 'alta'
  volume: 0.7,
  voice: true, // voceador ("¡Sube, sube!") con speechSynthesis
  showFps: false,
};

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const SaveSystem = {
  loadCareer() {
    const data = readJson(SAVE_KEY);
    return data && typeof data.day === 'number' ? data : null;
  },

  saveCareer(data) {
    return writeJson(SAVE_KEY, { ...data, savedAt: Date.now() });
  },

  clearCareer() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* sin almacenamiento: nada que borrar */
    }
  },

  loadSettings() {
    return { ...DEFAULT_SETTINGS, ...(readJson(SETTINGS_KEY) ?? {}) };
  },

  saveSettings(settings) {
    writeJson(SETTINGS_KEY, settings);
  },
};
