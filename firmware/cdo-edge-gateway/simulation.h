/*
 * Machine simulation models for the two edge gateways.
 *
 * This is the C++ twin of server/scripts/lib/sim-models.mjs. The two implement
 * the SAME equations, in the same order, drawing random numbers in the same
 * sequence, so that with the same seed they produce the same numbers. The
 * self-test (scripts/fw.mjs selftest) proves it on the real chip: it prints
 * fixed-seed samples and compares them with the JavaScript models.
 *
 * If you change an equation here, change it there, and run the self-test.
 *
 * The models are pure functions of simulated time, a scenario and a ramp value
 * r in [0, 1], plus a seeded random generator. This header deliberately does not
 * include Arduino.h, so it depends on nothing but <math.h>.
 *
 * Rules that keep the port exact:
 *   - double, not float: the JavaScript models are double precision.
 *   - One draw from the random generator per statement. C++ does not define the
 *     order in which the operands of an expression are evaluated, so an
 *     expression with two draws would not be reproducible.
 *   - Squares are written x * x, which is what JavaScript's x ** 2 computes.
 *
 * Robot (8 s weld cycle): servo torque, path deviation, weld-gun temperature.
 *   GEARBOX_WEAR raises torque and deviation.
 * Press (4.6 s stroke): motor current, lube-oil pressure, bearing vibration.
 *   The vibration spectrum is built FIRST and the RMS scalar is computed from its
 *   bins, so the two views of the same vibration always agree.
 *   CLOGGED_FILTER lowers lube pressure (the transducer is downstream of the
 *   filter) and adds a BROADBAND floor above 300 Hz.
 *   BEARING_WEAR leaves pressure alone and adds a DISCRETE harmonic family. Its
 *   RMS never reaches the alarm limit, so only a drift rule can catch it.
 */

#pragma once

#include <math.h>
#include <stddef.h>
#include <stdint.h>

#include "catalog.h"

namespace cdo {
namespace sim {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;

/* Mean RMS of the NORMAL spectrum over a stroke, in mm/s. The fault energy is
 * sized against it, so the documented factors (1 + 2.75 r, 1 + 1.1 r) hold for
 * the average level. Must equal PRESS_RMS_BASE_MEAN in sim-models.mjs. */
constexpr double kPressRmsBaseMean = 1.31;

/* Bearing-defect orders (multiples of the shaft frequency) and their strengths. */
constexpr int kDefectCount = 5;
constexpr double kDefectOrders[kDefectCount] = {3.55, 7.1, 10.65, 14.2, 17.75};
constexpr double kDefectWeights[kDefectCount] = {1.0, 0.8, 0.6, 0.45, 0.3};
/* Sideband amplitude relative to its carrier. */
constexpr double kSidebandRatio = 0.4;

/* ---- Random numbers ------------------------------------------------------- */

/* mulberry32, bit for bit the generator in sim-models.mjs. All arithmetic is on
 * uint32_t, which wraps modulo 2^32 exactly as Math.imul and >>> 0 do. */
class Rng {
 public:
  explicit Rng(uint32_t seed = 1) : state_(seed) {}

  void seed(uint32_t seed) { state_ = seed; }

  /* Uniform in [0, 1). */
  double uniform() {
    state_ += 0x6d2b79f5u;
    uint32_t t = state_;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
  }

  /* Standard normal (Box-Muller). Draws u first, then v, like the JS. */
  double gaussian() {
    double u = uniform();
    if (u < 1e-12) u = 1e-12;
    const double v = uniform();
    return sqrt(-2.0 * log(u)) * cos(kTwoPi * v);
  }

 private:
  uint32_t state_;
};

/* ---- Helpers -------------------------------------------------------------- */

inline double clampd(double value, double lo, double hi) {
  const double floored = value > lo ? value : lo;
  return floored < hi ? floored : hi;
}

enum Scenario : uint8_t {
  SC_NORMAL = 0,
  SC_GEARBOX_WEAR,
  SC_CLOGGED_FILTER,
  SC_BEARING_WEAR,
  SC_UNKNOWN = 255,
};

inline const char* scenarioName(Scenario scenario) {
  switch (scenario) {
    case SC_NORMAL: return "NORMAL";
    case SC_GEARBOX_WEAR: return "GEARBOX_WEAR";
    case SC_CLOGGED_FILTER: return "CLOGGED_FILTER";
    case SC_BEARING_WEAR: return "BEARING_WEAR";
    default: return "UNKNOWN";
  }
}

/* Map a scenario name to its enum, or SC_UNKNOWN. Case sensitive, like the wire. */
inline Scenario scenarioFromName(const char* name) {
  if (name == nullptr) return SC_UNKNOWN;
  for (int s = SC_NORMAL; s <= SC_BEARING_WEAR; ++s) {
    const char* candidate = scenarioName(static_cast<Scenario>(s));
    size_t i = 0;
    while (candidate[i] != '\0' && candidate[i] == name[i]) ++i;
    if (candidate[i] == '\0' && name[i] == '\0') return static_cast<Scenario>(s);
  }
  return SC_UNKNOWN;
}

/* Which scenario is active, when it started and how long its ramp takes. */
struct ScenarioState {
  Scenario scenario = SC_NORMAL;
  double startedAtSec = 0.0;
  double rampSec = 120.0;
};

/* Fault ramp: 0 before the fault starts, rising linearly to 1 over rampSec, then
 * held at 1. Always 0 for NORMAL. */
inline double rampOf(const ScenarioState& state, double tSec) {
  if (state.scenario == SC_NORMAL) return 0.0;
  return clampd((tSec - state.startedAtSec) / state.rampSec, 0.0, 1.0);
}

/* ---- Welding robot -------------------------------------------------------- */

class RobotModel {
 public:
  /* channels: the robot's three catalog channels, in catalog order (torque,
   * deviation, gun temperature). Used for clamping only. */
  RobotModel(double cycleSec, Rng* rng, const CdoChannel* channels)
      : cycleSec_(cycleSec), rng_(rng), channels_(channels) {}

  /* Weld duty: the gun is energised for 20 percent of the cycle. */
  static int weld(double p) { return (p > 0.55 && p < 0.75) ? 1 : 0; }

  /* Writes the three channel values, in catalog order, to out. */
  void sample(double tSec, Scenario scenario, double r, double out[3]) {
    const double p = fmod(tSec, cycleSec_) / cycleSec_;
    const bool worn = scenario == SC_GEARBOX_WEAR;

    double torque = 13.0 + 7.0 * sin(kTwoPi * p) + 2.2 * sin(8.0 * kPi * p) +
                    0.45 * (worn ? 1.0 + 1.5 * r : 1.0) * rng_->gaussian();
    double deviation = 0.085 + 0.03 * fabs(sin(kTwoPi * p)) + 0.008 * rng_->gaussian();

    if (worn) {
      /* Mean shift, a sixth-harmonic ripple from the damaged gear mesh, and noise
       * that grows with wear (above). Sized against the PEAK of the combined
       * waveform: with these values the noise-free peak crosses warn (26 Nm) at
       * r = 0.48, alarm (30 Nm) at r = 0.82, and reaches 32.3 Nm at r = 1. */
      torque += 10.5 * r + 3.0 * r * sin(12.0 * kPi * p);
      deviation += 0.55 * r + 0.05 * r * sin((kTwoPi * tSec) / 17.0);
    }

    /* First-order thermal model, sub-stepped so a long gap between samples cannot
     * skip a weld pulse: dT = (16 weld - 0.22 (T - 32)) dt. The window integrated
     * is the one ENDING at tSec, capped at 30 s so a pathological gap cannot
     * stall the loop. */
    const double from = haveLast_ ? lastT_ : tSec;
    const double span = clampd(tSec - from, 0.0, 30.0);
    const double wanted = ceil(span / 0.05);
    const int steps = wanted < 1.0 ? 1 : static_cast<int>(wanted);
    const double dt = span / steps;
    for (int i = 1; i <= steps; ++i) {
      const double pp = fmod(fmod(tSec - span + i * dt, cycleSec_) / cycleSec_, 1.0);
      gunTemp_ += (16.0 * weld(pp) - 0.22 * (gunTemp_ - 32.0)) * dt;
    }
    lastT_ = tSec;
    haveLast_ = true;

    out[0] = clampd(torque, channels_[0].lo, channels_[0].hi);
    out[1] = clampd(deviation, channels_[1].lo, channels_[1].hi);
    out[2] = clampd(gunTemp_, channels_[2].lo, channels_[2].hi);
  }

 private:
  double cycleSec_;
  Rng* rng_;
  const CdoChannel* channels_;
  /* Weld-gun temperature is a state, not a function of time. */
  double gunTemp_ = 32.0;
  double lastT_ = 0.0;
  bool haveLast_ = false;
};

/* ---- Stamping press ------------------------------------------------------- */

class PressModel {
 public:
  static constexpr int kMaxBins = 64;

  /* channels: the press's three catalog channels, in catalog order (motor
   * current, lube pressure, vibration RMS). Used for clamping only. */
  PressModel(double cycleSec, double shaftHz, double startHz, double stepHz, int count, Rng* rng,
             const CdoChannel* channels)
      : cycleSec_(cycleSec),
        shaftHz_(shaftHz),
        startHz_(startHz),
        stepHz_(stepHz),
        count_(count > kMaxBins ? kMaxBins : count),
        rng_(rng),
        channels_(channels) {}

  /* Working-stroke load: a sin-squared pulse over 38 to 60 percent of the stroke. */
  static double work(double p) {
    if (p <= 0.38 || p >= 0.6) return 0.0;
    const double s = sin((kPi * (p - 0.38)) / 0.22);
    return s * s;
  }

  /* Nearest bin to a frequency, clamped to the layout. */
  int binOf(double hz) const {
    const int index = static_cast<int>(round((hz - startHz_) / stepHz_));
    return index < 0 ? 0 : (index > count_ - 1 ? count_ - 1 : index);
  }

  /* Overall RMS of per-bin RMS amplitudes (energies add). */
  double rmsOf(const double* bins) const {
    double sum = 0.0;
    for (int i = 0; i < count_; ++i) sum += bins[i] * bins[i];
    return sqrt(sum);
  }

  /* Build the vibration spectrum for one instant into bins[0 .. count). */
  void buildSpectrum(double workLoad, Scenario scenario, double r, double* bins) {
    /* Noise floor. */
    for (int i = 0; i < count_; ++i) bins[i] = 0.03 * fabs(1.0 + 0.3 * rng_->gaussian());

    /* Healthy signature: motor shaft 1X and 2X, a low stroke-rate band, and
     * structural impact energy that swells during the working stroke. */
    double amplitude = 1.05 * (1.0 + 0.03 * rng_->gaussian());
    addLine(bins, binOf(shaftHz_), amplitude);
    amplitude = 0.45 * (1.0 + 0.04 * rng_->gaussian());
    addLine(bins, binOf(2.0 * shaftHz_), amplitude);

    bins[0] = sqrt(bins[0] * bins[0] + 0.08 * 0.08);
    bins[1] = sqrt(bins[1] * bins[1] + 0.08 * 0.08);

    const double impact = 0.25 * (0.4 + 1.2 * workLoad);
    for (int i = binOf(62.5); i <= binOf(150.0); ++i) {
      const double a = impact * (1.0 + 0.06 * rng_->gaussian());
      bins[i] = sqrt(bins[i] * bins[i] + a * a);
    }

    const double baseSq = kPressRmsBaseMean * kPressRmsBaseMean;

    if (scenario == SC_CLOGGED_FILTER && r > 0.0) {
      /* Lubrication starvation: broadband noise from 300 Hz to the top of the
       * span, no discrete peaks. Energy is sized so RMS scales by 1 + 2.75 r. */
      const double scaled = kPressRmsBaseMean * (1.0 + 2.75 * r);
      const double raw = scaled * scaled - baseSq;
      const double energy = raw > 0.0 ? raw : 0.0;
      const int first = binOf(300.0);
      const int n = count_ - first;
      const double floorAmp = sqrt(energy / n);
      for (int i = first; i < count_; ++i) {
        const double a = floorAmp * fabs(1.0 + 0.18 * rng_->gaussian());
        bins[i] = sqrt(bins[i] * bins[i] + a * a);
      }
    }

    if (scenario == SC_BEARING_WEAR && r > 0.0) {
      /* Outer-race defect: a harmonic family at non-integer orders of the shaft
       * frequency, each with sidebands at +/- 1X. RMS scales by 1 + 1.1 r. */
      const double scaled = kPressRmsBaseMean * (1.0 + 1.1 * r);
      const double energy = scaled * scaled - baseSq;
      double weightEnergy = 0.0;
      for (int k = 0; k < kDefectCount; ++k) {
        weightEnergy += kDefectWeights[k] * kDefectWeights[k] *
                        (1.0 + 2.0 * (kSidebandRatio * kSidebandRatio));
      }
      const double scale = sqrt(energy / weightEnergy);
      const int sideOffset = static_cast<int>(round(shaftHz_ / stepHz_));

      for (int k = 0; k < kDefectCount; ++k) {
        const int centre = binOf(kDefectOrders[k] * shaftHz_);
        const double a = scale * kDefectWeights[k] * (1.0 + 0.05 * rng_->gaussian());
        addLine(bins, centre, a);
        addLine(bins, centre - sideOffset, kSidebandRatio * a);
        addLine(bins, centre + sideOffset, kSidebandRatio * a);
      }
    }
  }

  /* Writes the three channel values, in catalog order, to out, and the spectrum
   * to bins[0 .. count). */
  void sample(double tSec, Scenario scenario, double r, double out[3], double* bins) {
    const double p = fmod(tSec, cycleSec_) / cycleSec_;
    const double load = work(p);
    const bool clogged = scenario == SC_CLOGGED_FILTER;
    const bool worn = scenario == SC_BEARING_WEAR;

    double current = 88.0 + 62.0 * load + 4.0 * sin(16.0 * kPi * p) + 1.8 * rng_->gaussian();
    if (clogged) current *= 1.0 + 0.03 * r; /* friction */
    if (worn) current *= 1.0 + 0.08 * r;

    /* Gear-pump pulsation at 1 Hz. The transducer sits downstream of the lube
     * filter, so a clog LOWERS the reading. */
    double pressure = 4.5 + 0.12 * sin(kTwoPi * tSec) + 0.03 * rng_->gaussian();
    if (clogged) {
      const double g = rng_->gaussian();
      pressure = pressure * (1.0 - 0.45 * r) + 0.06 * r * g;
    }

    buildSpectrum(load, scenario, r, bins);
    const double rms = rmsOf(bins);

    out[0] = clampd(current, channels_[0].lo, channels_[0].hi);
    out[1] = clampd(pressure, channels_[1].lo, channels_[1].hi);
    out[2] = clampd(rms, channels_[2].lo, channels_[2].hi);
  }

  int binCount() const { return count_; }

 private:
  /* Add a discrete spectral line, with a little leakage into the neighbours the
   * way a windowed FFT smears a real tone. */
  void addLine(double* bins, int index, double amplitude) const {
    add(bins, index, amplitude);
    add(bins, index - 1, 0.25 * amplitude);
    add(bins, index + 1, 0.25 * amplitude);
  }

  void add(double* bins, int i, double a) const {
    if (i < 0 || i >= count_) return;
    bins[i] = sqrt(bins[i] * bins[i] + a * a);
  }

  double cycleSec_;
  double shaftHz_;
  double startHz_;
  double stepHz_;
  int count_;
  Rng* rng_;
  const CdoChannel* channels_;
};

}  // namespace sim
}  // namespace cdo
