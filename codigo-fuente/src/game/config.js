/**
 * config
 * Valores de balance de la Fase 5 (jornadas, meta diaria, mejoras, grua).
 * Centralizados aqui para poder ajustar la jugabilidad sin tocar sistemas.
 */

// --- Jornada laboral ---
export const DAY_START_HOUR = 6; // la jornada arranca a las 06:00
export const DAY_END_HOUR = 22; // y termina a las 22:00
export const DAY_REAL_SECONDS = 540; // duracion real de una jornada completa (9 min)

/** Meta de ganancia bruta (Bs) para la jornada `day` (1, 2, 3...). */
export function dailyGoal(day) {
  return 70 + (day - 1) * 25;
}

// --- Choques ---
export const BUILDING_HIT = { reputation: -4, cooldown: 1.5 };
export const TRAFFIC_HIT = { carroceria: 2, suspension: 1, reputation: -2, cooldown: 1.2 };

// --- Grua (evita quedar trabado sin combustible) ---
export const TOW_COST = 20;
export const TOW_REPUTATION = -3;

// --- Mejoras del minibus (se compran entre jornadas) ---
export const UPGRADES = [
  {
    id: 'motor',
    name: 'Motor rectificado',
    desc: '+8% velocidad máx. y +10% aceleración por nivel.',
    costs: [60, 120, 200],
  },
  {
    id: 'carburador',
    name: 'Carburador afinado',
    desc: '-15% consumo de combustible por nivel.',
    costs: [50, 100, 170],
  },
  {
    id: 'llantas',
    name: 'Llantas nuevas',
    desc: 'Más agarre al girar y bajo lluvia, menos desgaste.',
    costs: [45, 90, 150],
  },
  {
    id: 'letrero',
    name: 'Letrero luminoso',
    desc: '+1 pasajero esperando por parada y nivel.',
    costs: [70, 140, 230],
  },
];

export const MAX_UPGRADE_LEVEL = 3;
