import { UPGRADES } from './config.js';

// Umbrales de reputacion segun el concepto del juego.
const REPUTATION_LEVELS = [
  { max: 20, label: 'Mal conductor' },
  { max: 40, label: 'Conductor novato' },
  { max: 60, label: 'Conductor regular' },
  { max: 80, label: 'Buen conductor' },
  { max: 100, label: 'Conductor destacado' },
];

function emptyDayStats() {
  return { earned: 0, fuelSpent: 0, repairSpent: 0, fines: 0, finesCount: 0, routes: 0, passengers: 0, crashes: 0 };
}

/**
 * GameState
 * Estado economico/progreso del jugador: dinero, ocupacion del minibus,
 * reputacion, jornada actual, mejoras compradas y estadisticas del dia.
 * Combustible y desgaste viven en el propio Minibus, ya que son
 * propiedades del vehiculo, no del conductor.
 */
export class GameState {
  constructor() {
    this.resetCareer();
  }

  resetCareer() {
    this.money = 15; // el jugador arranca con poco dinero, como pide el concepto
    this.passengersOnboard = 0;
    // Capacidad generosa a proposito: los pasajeros suben en el camino y
    // viajan hasta la ultima parada (nadie se baja a mitad de ruta), asi
    // que el bus debe poder llevar a casi todos los de las 4 paradas juntos.
    this.passengerCapacity = 18;
    this.reputation = 50; // arranca como "conductor regular"
    this.day = 1;
    this.upgrades = Object.fromEntries(UPGRADES.map((u) => [u.id, 0]));
    this.career = { routes: 0, passengers: 0, bestDay: 0 };
    this.dayStats = emptyDayStats();
  }

  startNewDay() {
    this.dayStats = emptyDayStats();
    this.passengersOnboard = 0;
  }

  addMoney(amount) {
    this.money += amount;
  }

  /** Gasto con categoria, para el resumen de fin de jornada. */
  spend(amount, category) {
    this.money -= amount;
    if (category === 'fuel') this.dayStats.fuelSpent += amount;
    else if (category === 'repair') this.dayStats.repairSpent += amount;
    else if (category === 'fine') {
      this.dayStats.fines += amount;
      this.dayStats.finesCount++;
    }
  }

  canBoard() {
    return this.passengersOnboard < this.passengerCapacity;
  }

  boardPassenger(fare) {
    this.passengersOnboard = Math.min(this.passengerCapacity, this.passengersOnboard + 1);
    this.money += fare;
    this.dayStats.earned += fare;
    this.dayStats.passengers++;
    this.career.passengers++;
  }

  /** Al completar la ruta se asume que todos los pasajeros llegaron a destino. */
  dropOffAll() {
    this.passengersOnboard = 0;
  }

  completeRoute(bonus) {
    this.money += bonus;
    this.dayStats.earned += bonus;
    this.dayStats.routes++;
    this.career.routes++;
  }

  addReputation(amount) {
    this.reputation = Math.min(100, Math.max(0, this.reputation + amount));
  }

  get reputationLevel() {
    const level = REPUTATION_LEVELS.find((l) => this.reputation <= l.max);
    return level ? level.label : REPUTATION_LEVELS[REPUTATION_LEVELS.length - 1].label;
  }

  toJSON() {
    return {
      money: this.money,
      reputation: this.reputation,
      day: this.day,
      upgrades: { ...this.upgrades },
      career: { ...this.career },
    };
  }

  loadFrom(data) {
    this.money = data.money ?? this.money;
    this.reputation = data.reputation ?? this.reputation;
    this.day = data.day ?? 1;
    this.upgrades = { ...this.upgrades, ...(data.upgrades ?? {}) };
    this.career = { ...this.career, ...(data.career ?? {}) };
    this.dayStats = emptyDayStats();
    this.passengersOnboard = 0;
  }
}
