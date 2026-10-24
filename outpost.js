// Outpost resource simulation for Lunar Guardian.
//
// Pure logic (no Three.js, no DOM) so it can be unit-tested in Node and driven
// by the existing game loop. Game.update() calls step() once per frame and the
// HUD reads the same state object, so there is a single source of truth.
//
// IMPORTANT: every number below is a GAMEPLAY PARAMETER. Crew consumption rates
// are rounded values in the range of NASA's Life Support Baseline Values and
// Assumptions Document (BVAD); equipment power figures, radiation rates and
// limits are illustrative. None of them are NASA operating specifications.
// See docs/RESOURCE_MANAGEMENT.md.

export const SIM_HOURS_PER_SEC = 0.05; // 1 real second = 3 simulated minutes

export const PARAMS = {
  crew: 2,
  // Power (kW / kWh)
  solarPeakKw: 6.0,
  batteryCapKwh: 40,
  batteryStartKwh: 32,
  emergencyReserveKwh: 4, // life support only, used when the main battery is empty
  shedFraction: 0.15, // non-essential loads are shed below this battery fraction
  lifeSupportKw: 1.2,
  hydroponicsKw: 1.0,
  roverChargeKw: 3.0, // per rover while docked
  // Crew consumables (per crew member per day)
  o2KgPerDay: 0.84,
  drinkWaterKgPerDay: 2.0,
  foodKgPerDay: 0.6, // dry food mass
  waterRecovery: 0.9, // fraction recovered while life support is powered
  hydroponicsWaterKgPerDay: 1.0,
  hydroponicsFoodKgPerDay: 0.9, // at full crop efficiency
  cropRampDays: 2, // delay before crops reach full yield
  cropDecayDays: 1,
  o2Start: 14,
  waterStart: 60,
  foodStart: 8,
  // Radiation (mSv per simulated hour) and mission dose limits
  surfaceDoseRate: 0.05,
  shelterDoseRate: 0.01,
  sepMultiplier: 15,
  doseWarn: 3,
  doseLimit: 5,
  // Life support may stay offline this long before the crew is lost
  lifeSupportOfflineLimitH: 12,
  shelterRadius: 14,
  chargeRadius: 16,
  roverSolarKw: 0.2, // rover's own panel trickle (lets a drained rover crawl back)
};

// Rover energy model (gameplay parameters). Rover.update() drains its battery
// with these figures and pathfinding.routeMetrics() predicts route energy with
// the same function, so the HUD estimate matches what actually happens.
export const ROVER = {
  capKwh: 8,
  idleKw: 0.1,
  drillKw: 1.0,
  driveKw: { scout: 0.9, mapper: 1.2, sampler: 1.4 },
  lowFraction: 0.05, // below this the rover crawls at 20% speed
};

/** Instantaneous rover electrical load in kW. */
export function roverLoadKw(kind, moving, slopeDeg = 0, drilling = false) {
  let kw = ROVER.idleKw;
  if (moving) kw += (ROVER.driveKw[kind] ?? 1.2) * (1 + Math.max(0, slopeDeg) / 30);
  if (drilling) kw += ROVER.drillKw;
  return kw;
}

/** Energy (kWh) to drive distM metres at speed (m/s) up a mean slope. */
export function driveEnergyKwh(kind, distM, slopeDeg, speed) {
  const realSeconds = distM / Math.max(speed, 0.01);
  return roverLoadKw(kind, true, slopeDeg) * realSeconds * SIM_HOURS_PER_SEC;
}

export const POWER_MODES = {
  balanced: { label: "BALANCED", order: ["hydro", "charge"] },
  surface_ops: { label: "SURFACE OPS", order: ["charge"] },
  life_support: { label: "LIFE SUPPORT PRIORITY", order: [] },
};
export const POWER_MODE_ORDER = ["balanced", "surface_ops", "life_support"];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Outpost {
  constructor(overrides = {}) {
    this.p = { ...PARAMS, ...overrides };
    const p = this.p;
    this.mode = "balanced";
    this.batteryKwh = p.batteryStartKwh;
    this.emergencyKwh = p.emergencyReserveKwh;
    this.o2Kg = p.o2Start;
    this.waterKg = p.waterStart;
    this.foodKg = p.foodStart;
    this.cropEff = 0;
    this.doseMsv = 0;
    this.sepActive = false;
    this.sheltered = true;
    this.simHours = 0;
    this.lifeSupportPowered = true;
    this.lifeSupportOfflineH = 0;
    this.hydroponicsPowered = false;
    // Flow bookkeeping for the HUD / debrief (kWh)
    this.totals = { generated: 0, lifeSupport: 0, hydroponics: 0, rovers: 0, curtailed: 0, shortfall: 0 };
    this.flow = { genKw: 0, loadKw: 0 }; // instantaneous, for display
    this.min = { battery: p.batteryStartKwh, o2: p.o2Start, water: p.waterStart, food: p.foodStart };
    this.failure = null;
    this.events = [];
    this._warned = new Set();
    this.decisions = [];
  }

  setMode(mode, note = true) {
    if (!POWER_MODES[mode] || mode === this.mode) return;
    this.mode = mode;
    if (note) this.decisions.push({ t: this.simHours, text: `Power mode set to ${POWER_MODES[mode].label}` });
  }

  cycleMode() {
    const i = POWER_MODE_ORDER.indexOf(this.mode);
    this.setMode(POWER_MODE_ORDER[(i + 1) % POWER_MODE_ORDER.length]);
    return this.mode;
  }

  setSolarEvent(active) {
    if (active === this.sepActive) return;
    this.sepActive = active;
    this._event(active ? "alert:sep" : "info:sep-end", active
      ? "SOLAR PARTICLE EVENT — SHELTER IN THE HABITAT"
      : "SOLAR PARTICLE EVENT ENDED");
  }

  _event(key, text) {
    this.events.push({ key, text });
  }

  _warnOnce(key, text) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this._event(key, text);
  }

  /**
   * Advance the simulation.
   * @param {number} dt real seconds
   * @param {object} ctx
   *   solarFactor   0..1 illumination at the habitat (from terrain illumination)
   *   evaOutside    true when the astronaut is outside the shelter radius
   *   chargeRequests [{ id, kw }] rovers docked and wanting charge
   * @returns {{ charged: Object<string, number> }} kWh delivered per requester
   */
  step(dt, ctx = {}) {
    const p = this.p;
    const h = dt * SIM_HOURS_PER_SEC;
    this.simHours += h;
    const out = { charged: {} };
    if (h <= 0 || this.failure) return out;

    // ---- Power ledger -----------------------------------------------------
    // newEnergy = clamp(previousEnergy + generated - consumed, 0, capacity)
    const solar = clamp(ctx.solarFactor ?? 1, 0, 1);
    const generated = p.solarPeakKw * solar * h;
    const prev = this.batteryKwh;
    const pool = generated + prev;

    const essentialNeed = p.lifeSupportKw * h;
    const essentialFromMain = Math.min(essentialNeed, pool);
    let essentialShort = essentialNeed - essentialFromMain;
    const fromEmergency = Math.min(essentialShort, this.emergencyKwh);
    this.emergencyKwh -= fromEmergency;
    essentialShort -= fromEmergency;
    this.lifeSupportPowered = essentialShort <= 1e-9;
    if (fromEmergency > 0) this._warnOnce("warn:emergency", "MAIN POWER EMPTY — LIFE SUPPORT ON EMERGENCY RESERVE");

    // Non-essential loads may only use what is left above the shed level.
    const shedLevel = p.shedFraction * p.batteryCapKwh;
    let avail = Math.max(0, pool - essentialFromMain - shedLevel);
    if (pool - essentialFromMain < shedLevel) this._warnOnce("warn:shed", "LOW POWER — NON-ESSENTIAL LOADS SHED");

    const order = POWER_MODES[this.mode].order;
    let hydroServed = 0;
    let roverServed = 0;
    const requests = ctx.chargeRequests || [];
    for (const item of order) {
      if (item === "hydro") {
        const want = p.hydroponicsKw * h;
        const give = Math.min(want, avail);
        hydroServed = give;
        avail -= give;
        this.hydroponicsPowered = give >= want - 1e-9;
      } else if (item === "charge") {
        for (const rq of requests) {
          const want = rq.kw * h;
          const give = Math.min(want, avail);
          if (give > 0) out.charged[rq.id] = (out.charged[rq.id] || 0) + give;
          roverServed += give;
          avail -= give;
        }
      }
    }
    if (!order.includes("hydro")) this.hydroponicsPowered = false;

    const consumed = essentialFromMain + hydroServed + roverServed;
    const unclamped = prev + generated - consumed;
    this.batteryKwh = clamp(unclamped, 0, p.batteryCapKwh);
    this.totals.generated += generated;
    this.totals.lifeSupport += essentialFromMain + fromEmergency;
    this.totals.hydroponics += hydroServed;
    this.totals.rovers += roverServed;
    this.totals.curtailed += Math.max(0, unclamped - p.batteryCapKwh);
    this.totals.shortfall += essentialShort;
    this.flow.genKw = p.solarPeakKw * solar;
    this.flow.loadKw = (essentialFromMain + fromEmergency + hydroServed + roverServed) / h;

    // ---- Life support & consumables ---------------------------------------
    const days = h / 24;
    const crew = p.crew;
    if (this.lifeSupportPowered) {
      this.lifeSupportOfflineH = 0;
    } else {
      this.lifeSupportOfflineH += h;
      this._warnOnce("alert:ls-off", "LIFE SUPPORT OFFLINE — RESTORE POWER");
    }
    const recovery = this.lifeSupportPowered ? p.waterRecovery : 0;
    this.o2Kg = Math.max(0, this.o2Kg - crew * p.o2KgPerDay * days);
    this.waterKg = Math.max(
      0,
      this.waterKg - crew * p.drinkWaterKgPerDay * (1 - recovery) * days - (this.hydroponicsPowered ? p.hydroponicsWaterKgPerDay * days : 0)
    );

    // Crops: ramp up while powered, decay when not.
    if (this.hydroponicsPowered) this.cropEff = Math.min(1, this.cropEff + days / p.cropRampDays);
    else this.cropEff = Math.max(0, this.cropEff - days / p.cropDecayDays);
    const produced = p.hydroponicsFoodKgPerDay * this.cropEff * days;
    this.foodKg = Math.max(0, this.foodKg + produced - crew * p.foodKgPerDay * days);

    // ---- Radiation --------------------------------------------------------
    this.sheltered = !ctx.evaOutside;
    let rate = this.sheltered ? p.shelterDoseRate : p.surfaceDoseRate;
    if (this.sepActive) rate *= this.sheltered ? 2 : p.sepMultiplier;
    this.doseMsv += rate * h;
    this.doseRateMsvH = rate;
    if (this.doseMsv >= p.doseWarn) this._warnOnce("warn:dose", "RADIATION DOSE APPROACHING MISSION LIMIT");

    // ---- Warnings, minima, failure ----------------------------------------
    if (this.batteryKwh < 0.25 * p.batteryCapKwh) this._warnOnce("warn:battery", "HABITAT BATTERY BELOW 25%");
    if (this.o2Kg < 0.25 * p.o2Start) this._warnOnce("warn:o2", "OXYGEN RESERVE BELOW 25%");
    if (this.waterKg < 0.25 * p.waterStart) this._warnOnce("warn:water", "WATER RESERVE BELOW 25%");
    if (this.foodKg < 0.25 * p.foodStart) this._warnOnce("warn:food", "FOOD RESERVE BELOW 25%");
    this.min.battery = Math.min(this.min.battery, this.batteryKwh);
    this.min.o2 = Math.min(this.min.o2, this.o2Kg);
    this.min.water = Math.min(this.min.water, this.waterKg);
    this.min.food = Math.min(this.min.food, this.foodKg);

    if (this.o2Kg <= 0) this.failure = "Oxygen reserve exhausted.";
    else if (this.waterKg <= 0) this.failure = "Water reserve exhausted; habitat water loop cannot support the crew.";
    else if (this.foodKg <= 0) this.failure = "Food reserve exhausted; the outpost is not sustainable at this crew size.";
    else if (this.lifeSupportOfflineH >= p.lifeSupportOfflineLimitH) this.failure = "Life support stayed offline too long (no power for scrubbers and water recovery).";
    else if (this.doseMsv >= p.doseLimit) this.failure = "Crew radiation dose exceeded the mission limit.";
    return out;
  }

  /** Remaining endurance in simulated days for each consumable, at current rates. */
  endurance() {
    const p = this.p;
    const recovery = this.lifeSupportPowered ? p.waterRecovery : 0;
    const o2Rate = p.crew * p.o2KgPerDay;
    const waterRate = p.crew * p.drinkWaterKgPerDay * (1 - recovery) + (this.hydroponicsPowered ? p.hydroponicsWaterKgPerDay : 0);
    const foodRate = p.crew * p.foodKgPerDay - p.hydroponicsFoodKgPerDay * this.cropEff;
    const d = (stock, rate) => (rate <= 1e-9 ? Infinity : stock / rate);
    const o2 = d(this.o2Kg, o2Rate);
    const water = d(this.waterKg, waterRate);
    const food = d(this.foodKg, foodRate);
    const limiting = Math.min(o2, water, food);
    const which = limiting === o2 ? "OXYGEN" : limiting === water ? "WATER" : "FOOD";
    return { o2, water, food, limiting, which };
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  snapshot() {
    return {
      mode: POWER_MODES[this.mode].label,
      simHours: this.simHours,
      batteryKwh: this.batteryKwh,
      batteryMinKwh: this.min.battery,
      emergencyKwh: this.emergencyKwh,
      o2Kg: this.o2Kg,
      o2MinKg: this.min.o2,
      waterKg: this.waterKg,
      waterMinKg: this.min.water,
      foodKg: this.foodKg,
      foodMinKg: this.min.food,
      doseMsv: this.doseMsv,
      totals: { ...this.totals },
      decisions: this.decisions.slice(),
      failure: this.failure,
    };
  }
}
