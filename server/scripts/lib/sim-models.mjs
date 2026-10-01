/**
 * @file Machine simulation models for the two edge gateways.
 *
 * These are the JavaScript twins of `firmware/cdo-edge-gateway/simulation.h`.
 * The two must implement the same equations, which are written out in
 * `docs/mqtt-contract.md` and the plan; `server/test/simulator.test.js` checks
 * the properties the demo depends on (alarm crossing times, RMS levels).
 *
 * The models are pure functions of simulated time, a scenario and a ramp value
 * `r` in [0, 1], plus a seeded random generator, so a test can reproduce a run
 * exactly.
 *
 * ## The two machines
 *
 * **Welding robot**, an 8 s cycle. Servo torque, path deviation and weld-gun
 * temperature. Fault `GEARBOX_WEAR` raises torque and deviation.
 *
 * **Stamping press**, a 4.6 s stroke (about 13 strokes per minute). Main motor
 * current, lube-oil pressure and bearing vibration. The vibration spectrum is
 * generated FIRST and the RMS scalar is computed from its bins, so the two
 * views of the same vibration always agree. Two faults share a symptom (high
 * vibration) but differ in evidence:
 *
 * - `CLOGGED_FILTER`: lube pressure falls (the transducer is downstream of the
 *   filter) and the spectrum gains a BROADBAND floor from 300 Hz up.
 * - `BEARING_WEAR`: pressure stays normal and the spectrum gains a DISCRETE
 *   harmonic family. RMS never reaches the alarm limit, so only a drift rule
 *   can catch it.
 *
 * @module scripts/lib/sim-models
 */

const TWO_PI = 2 * Math.PI;

/**
 * Small, fast, seedable PRNG (mulberry32). Output is uniform in [0, 1).
 *
 * @param {number} seed - Any 32-bit integer.
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal sample (Box-Muller).
 *
 * @param {() => number} rng - Uniform generator.
 * @returns {number}
 */
export function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Round to a fixed number of decimals, as the firmware's `%.Nf` would print.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
export function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Fault ramp: 0 before the fault starts, rising linearly to 1 over `rampSec`,
 * then held at 1.
 *
 * @param {{scenario: string, startedAtSec: number, rampSec: number}} scenario
 * @param {number} tSec - Simulated time.
 * @returns {number} `r` in [0, 1]; always 0 for `NORMAL`.
 */
export function rampOf(scenario, tSec) {
  if (scenario.scenario === 'NORMAL') return 0;
  return clamp((tSec - scenario.startedAtSec) / scenario.rampSec, 0, 1);
}

/* ─── Welding robot ────────────────────────────────────────────────────────── */

export class RobotModel {
  /**
   * @param {object} options
   * @param {number} options.cycleSec - Weld cycle length. Default 8.
   * @param {() => number} options.rng - Uniform generator.
   * @param {Array<{key: string, min: number, max: number}>} options.channels - For clamping.
   */
  constructor({ cycleSec = 8, rng, channels }) {
    this.cycleSec = cycleSec;
    this.rng = rng;
    this.range = Object.fromEntries(channels.map((c) => [c.key, c]));
    /** Weld-gun temperature is a state, not a function of time. */
    this.gunTemp = 32;
    this.lastT = null;
  }

  /**
   * Weld duty: the gun is energised for 20 percent of the cycle.
   * @param {number} p - Cycle phase in [0, 1).
   * @returns {0|1}
   */
  static weld(p) {
    return p > 0.55 && p < 0.75 ? 1 : 0;
  }

  /**
   * @param {number} tSec - Simulated time.
   * @param {string} scenario - `NORMAL` or `GEARBOX_WEAR`.
   * @param {number} r - Fault ramp in [0, 1].
   * @returns {{channels: Record<string, number>}}
   */
  sample(tSec, scenario, r) {
    const { rng } = this;
    const p = (tSec % this.cycleSec) / this.cycleSec;
    const worn = scenario === 'GEARBOX_WEAR';

    let torque =
      13.0 +
      7.0 * Math.sin(TWO_PI * p) +
      2.2 * Math.sin(8 * Math.PI * p) +
      0.45 * (worn ? 1 + 1.5 * r : 1) * gaussian(rng);
    let deviation = 0.085 + 0.03 * Math.abs(Math.sin(TWO_PI * p)) + 0.008 * gaussian(rng);

    if (worn) {
      // Mean shift, a sixth-harmonic ripple from the damaged gear mesh, and
      // noise that grows with wear (applied above). The shift is sized against
      // the PEAK of the combined waveform, not the sum of component peaks: the
      // ripple and the base cycle peak at different phases, so their maxima do
      // not add. With these values the noise-free peak crosses the warn limit
      // (26 Nm) at r = 0.48, the alarm limit (30 Nm) at r = 0.82, and reaches
      // 32.3 Nm at r = 1.
      torque += 10.5 * r + 3.0 * r * Math.sin(12 * Math.PI * p);
      deviation += 0.55 * r + 0.05 * r * Math.sin((TWO_PI * tSec) / 17);
    }

    // First-order thermal model, sub-stepped so a long gap between samples
    // cannot skip a weld pulse. dT = (16 weld - 0.22 (T - 32)) dt. The window
    // integrated is the one ENDING at tSec, capped at 30 s so a pathological
    // gap cannot stall the loop.
    const from = this.lastT ?? tSec;
    const span = clamp(tSec - from, 0, 30);
    const steps = Math.max(1, Math.ceil(span / 0.05));
    const dt = span / steps;
    for (let i = 1; i <= steps; i += 1) {
      const pp = (((tSec - span + i * dt) % this.cycleSec) / this.cycleSec) % 1;
      this.gunTemp += (16 * RobotModel.weld(pp) - 0.22 * (this.gunTemp - 32)) * dt;
    }
    this.lastT = tSec;

    const { AXIS_4_SERVO_TORQUE: tq, TOOL_CENTER_POINT_DEVIATION: dv, WELD_GUN_TEMP: gt } = this.range;
    return {
      channels: {
        AXIS_4_SERVO_TORQUE: clamp(torque, tq.min, tq.max),
        TOOL_CENTER_POINT_DEVIATION: clamp(deviation, dv.min, dv.max),
        WELD_GUN_TEMP: clamp(this.gunTemp, gt.min, gt.max),
      },
    };
  }
}

/* ─── Stamping press ───────────────────────────────────────────────────────── */

/**
 * Mean RMS of the NORMAL spectrum over a stroke, in mm/s. The fault energy is
 * sized against this so the documented factors (`1 + 2.75 r`, `1 + 1.1 r`) hold
 * for the average level. Measured by `simulator.test.js`; if the normal
 * spectrum is retuned, re-measure and update.
 */
export const PRESS_RMS_BASE_MEAN = 1.31;

/** Bearing-defect orders, multiples of the shaft frequency (illustrative). */
const DEFECT_ORDERS = [3.55, 7.1, 10.65, 14.2, 17.75];
/** Relative strength of each defect harmonic. */
const DEFECT_WEIGHTS = [1.0, 0.8, 0.6, 0.45, 0.3];
/** Sideband amplitude relative to its carrier. */
const SIDEBAND_RATIO = 0.4;

export class PressModel {
  /**
   * @param {object} options
   * @param {number} options.cycleSec - Stroke length. Default 4.6.
   * @param {number} options.shaftHz - Motor shaft frequency (1X). Default 24.7.
   * @param {{startHz: number, stepHz: number, count: number}} options.spectrum - Bin layout.
   * @param {() => number} options.rng - Uniform generator.
   * @param {Array<{key: string, min: number, max: number}>} options.channels - For clamping.
   */
  constructor({ cycleSec = 4.6, shaftHz = 24.7, spectrum, rng, channels }) {
    this.cycleSec = cycleSec;
    this.shaftHz = shaftHz;
    this.layout = spectrum;
    this.rng = rng;
    this.range = Object.fromEntries(channels.map((c) => [c.key, c]));
  }

  /**
   * Working-stroke load profile: a sin-squared pulse over 38 to 60 percent of
   * the stroke, zero elsewhere.
   *
   * @param {number} p - Stroke phase in [0, 1).
   * @returns {number} Load factor in [0, 1].
   */
  static work(p) {
    if (p <= 0.38 || p >= 0.6) return 0;
    return Math.sin((Math.PI * (p - 0.38)) / 0.22) ** 2;
  }

  /** @param {number} hz @returns {number} Nearest bin index, clamped to the layout. */
  binOf(hz) {
    const index = Math.round((hz - this.layout.startHz) / this.layout.stepHz);
    return clamp(index, 0, this.layout.count - 1);
  }

  /**
   * Add a discrete spectral line, with a little leakage into the neighbours the
   * way a windowed FFT smears a real tone.
   *
   * @param {number[]} bins - Amplitude bins (RMS per bin), mutated.
   * @param {number} index - Centre bin.
   * @param {number} amplitude - Line amplitude in mm/s RMS.
   * @returns {void}
   */
  #addLine(bins, index, amplitude) {
    const add = (i, a) => {
      if (i < 0 || i >= bins.length) return;
      bins[i] = Math.sqrt(bins[i] ** 2 + a ** 2);
    };
    add(index, amplitude);
    add(index - 1, 0.25 * amplitude);
    add(index + 1, 0.25 * amplitude);
  }

  /**
   * Build the vibration spectrum for one instant.
   *
   * @param {number} work - Load factor from {@link PressModel.work}.
   * @param {string} scenario - Active scenario.
   * @param {number} r - Fault ramp in [0, 1].
   * @returns {number[]} Amplitude per bin, mm/s RMS.
   */
  buildSpectrum(work, scenario, r) {
    const { rng, layout } = this;
    const bins = new Array(layout.count);

    // Noise floor.
    for (let i = 0; i < layout.count; i += 1) {
      bins[i] = 0.03 * Math.abs(1 + 0.3 * gaussian(rng));
    }

    // Healthy signature: motor shaft 1X and 2X, a low stroke-rate band, and
    // structural impact energy that swells during the working stroke.
    this.#addLine(bins, this.binOf(this.shaftHz), 1.05 * (1 + 0.03 * gaussian(rng)));
    this.#addLine(bins, this.binOf(2 * this.shaftHz), 0.45 * (1 + 0.04 * gaussian(rng)));
    bins[0] = Math.sqrt(bins[0] ** 2 + 0.08 ** 2);
    bins[1] = Math.sqrt(bins[1] ** 2 + 0.08 ** 2);
    const impact = 0.25 * (0.4 + 1.2 * work);
    for (let i = this.binOf(62.5); i <= this.binOf(150); i += 1) {
      bins[i] = Math.sqrt(bins[i] ** 2 + (impact * (1 + 0.06 * gaussian(rng))) ** 2);
    }

    const baseSq = PRESS_RMS_BASE_MEAN ** 2;

    if (scenario === 'CLOGGED_FILTER' && r > 0) {
      // Lubrication starvation: broadband noise from 300 Hz to the top of the
      // span, no discrete peaks. Energy is sized so RMS scales by 1 + 2.75 r.
      const energy = Math.max(0, (PRESS_RMS_BASE_MEAN * (1 + 2.75 * r)) ** 2 - baseSq);
      const first = this.binOf(300);
      const count = layout.count - first;
      const amplitude = Math.sqrt(energy / count);
      for (let i = first; i < layout.count; i += 1) {
        bins[i] = Math.sqrt(bins[i] ** 2 + (amplitude * Math.abs(1 + 0.18 * gaussian(rng))) ** 2);
      }
    }

    if (scenario === 'BEARING_WEAR' && r > 0) {
      // Outer-race defect: a harmonic family at non-integer orders of the shaft
      // frequency, each with sidebands at +/- 1X. RMS scales by 1 + 1.1 r.
      const energy = (PRESS_RMS_BASE_MEAN * (1 + 1.1 * r)) ** 2 - baseSq;
      const weightEnergy = DEFECT_WEIGHTS.reduce(
        (sum, w) => sum + w ** 2 * (1 + 2 * SIDEBAND_RATIO ** 2),
        0,
      );
      const scale = Math.sqrt(energy / weightEnergy);
      const sideOffset = Math.round(this.shaftHz / layout.stepHz);

      DEFECT_ORDERS.forEach((order, k) => {
        const centre = this.binOf(order * this.shaftHz);
        const amplitude = scale * DEFECT_WEIGHTS[k] * (1 + 0.05 * gaussian(rng));
        this.#addLine(bins, centre, amplitude);
        this.#addLine(bins, centre - sideOffset, SIDEBAND_RATIO * amplitude);
        this.#addLine(bins, centre + sideOffset, SIDEBAND_RATIO * amplitude);
      });
    }

    return bins;
  }

  /**
   * Overall RMS of a spectrum of per-bin RMS amplitudes (energies add).
   *
   * @param {number[]} bins
   * @returns {number} mm/s RMS.
   */
  static rmsOf(bins) {
    return Math.sqrt(bins.reduce((sum, a) => sum + a * a, 0));
  }

  /**
   * @param {number} tSec - Simulated time.
   * @param {string} scenario - `NORMAL`, `CLOGGED_FILTER` or `BEARING_WEAR`.
   * @param {number} r - Fault ramp in [0, 1].
   * @returns {{channels: Record<string, number>, spectrum: number[]}}
   */
  sample(tSec, scenario, r) {
    const { rng } = this;
    const p = (tSec % this.cycleSec) / this.cycleSec;
    const work = PressModel.work(p);
    const clogged = scenario === 'CLOGGED_FILTER';
    const worn = scenario === 'BEARING_WEAR';

    let current = 88 + 62 * work + 4 * Math.sin(16 * Math.PI * p) + 1.8 * gaussian(rng);
    if (clogged) current *= 1 + 0.03 * r; // friction
    if (worn) current *= 1 + 0.08 * r;

    // Gear-pump pulsation at 1 Hz. The transducer sits downstream of the lube
    // filter, so a clog LOWERS the reading.
    let pressure = 4.5 + 0.12 * Math.sin(TWO_PI * tSec) + 0.03 * gaussian(rng);
    if (clogged) pressure = pressure * (1 - 0.45 * r) + 0.06 * r * gaussian(rng);

    const spectrum = this.buildSpectrum(work, scenario, r);
    const rms = PressModel.rmsOf(spectrum);

    const { MAIN_MOTOR_CURRENT: cur, LUBE_OIL_PRESSURE: lube, BEARING_VIBRATION_RMS: vib } = this.range;
    return {
      channels: {
        MAIN_MOTOR_CURRENT: clamp(current, cur.min, cur.max),
        LUBE_OIL_PRESSURE: clamp(pressure, lube.min, lube.max),
        BEARING_VIBRATION_RMS: clamp(rms, vib.min, vib.max),
      },
      spectrum,
    };
  }
}

/**
 * Build the model for a catalog machine.
 *
 * @param {string} machineType - `robot` or `press`.
 * @param {any} machine - The machine's entry in `firmware/catalog.json`.
 * @param {() => number} rng - Uniform generator.
 * @returns {RobotModel|PressModel}
 */
export function createModel(machineType, machine, rng) {
  if (machineType === 'robot') {
    return new RobotModel({ cycleSec: machine.sim.cycleSec, rng, channels: machine.channels });
  }
  if (machineType === 'press') {
    return new PressModel({
      cycleSec: machine.sim.cycleSec,
      // The shaft speed is declared once, in the spectrum layout that the
      // device also announces in its birth message.
      shaftHz: machine.spectrum.fundamentalHz,
      spectrum: machine.spectrum,
      rng,
      channels: machine.channels,
    });
  }
  throw new Error(`No simulation model for machine type "${machineType}"`);
}

export default { mulberry32, gaussian, clamp, roundTo, rampOf, RobotModel, PressModel, createModel };
