/*
 * On-chip parity self-test, compiled in only with -DCDO_SELFTEST=1
 * (node scripts/fw.mjs selftest does that for you).
 *
 * It runs the two machine models over the fixed plan in catalog.json (seed,
 * ramps, times) and prints every result with 12 significant digits. The host
 * builds the same vectors from the JavaScript models and compares them
 * (server/scripts/lib/selftest.mjs). If they agree, the C++ port computes what
 * the JavaScript simulator computes, on this chip, in double precision.
 *
 * The walk order here must match expectedVectors() in selftest.mjs:
 *   machine (robot, press) > scenario > ramp (NORMAL: r = 0 only) > a FRESH
 *   model seeded with CDO_SELFTEST_SEED > each time in the machine's list.
 *
 * Output, one block, repeated every 10 s so a late-attached monitor still gets one:
 *
 *   CDO-SELFTEST-BEGIN
 *   H {"fw":"1.0.0","catalog":"bfde0aca5c","seed":4242}
 *   S {"m":"robot","sc":"NORMAL","r":0.00,"t":4.000,"v":[a,b,c]}
 *   S {"m":"press","sc":"CLOGGED_FILTER","r":0.25,"t":10.000,"v":[a,b,c],"bins":[...]}
 *   CDO-SELFTEST-END
 */

#pragma once

#include <Arduino.h>
#include <esp_task_wdt.h>

#include "catalog.h"
#include "config.h"
#include "simulation.h"

#if CDO_SELFTEST

static void selftestPrintValues(const double* values, int count) {
  for (int i = 0; i < count; ++i) Serial.printf("%s%.12g", i == 0 ? "" : ",", values[i]);
}

static void selftestRobot() {
  for (int s = 0; s < CDO_ROBOT_SCENARIO_COUNT; ++s) {
    const char* name = CDO_ROBOT_SCENARIOS[s];
    const cdo::sim::Scenario scenario = cdo::sim::scenarioFromName(name);
    const int ramps = scenario == cdo::sim::SC_NORMAL ? 1 : CDO_SELFTEST_RAMP_COUNT;

    for (int ri = 0; ri < ramps; ++ri) {
      const double r = scenario == cdo::sim::SC_NORMAL ? 0.0 : CDO_SELFTEST_RAMPS[ri];
      cdo::sim::Rng rng(CDO_SELFTEST_SEED);
      cdo::sim::RobotModel model(CDO_ROBOT_CYCLE_SEC, &rng, CDO_ROBOT_CHANNELS);

      for (int k = 0; k < CDO_ROBOT_SELFTEST_TIME_COUNT; ++k) {
        const double t = CDO_ROBOT_SELFTEST_TIMES[k];
        double values[3];
        model.sample(t, scenario, r, values);
        Serial.printf("S {\"m\":\"robot\",\"sc\":\"%s\",\"r\":%g,\"t\":%g,\"v\":[", name, r, t);
        selftestPrintValues(values, 3);
        Serial.print("]}\n");
        esp_task_wdt_reset();
      }
    }
  }
}

static void selftestPress() {
  for (int s = 0; s < CDO_PRESS_SCENARIO_COUNT; ++s) {
    const char* name = CDO_PRESS_SCENARIOS[s];
    const cdo::sim::Scenario scenario = cdo::sim::scenarioFromName(name);
    const int ramps = scenario == cdo::sim::SC_NORMAL ? 1 : CDO_SELFTEST_RAMP_COUNT;

    for (int ri = 0; ri < ramps; ++ri) {
      const double r = scenario == cdo::sim::SC_NORMAL ? 0.0 : CDO_SELFTEST_RAMPS[ri];
      cdo::sim::Rng rng(CDO_SELFTEST_SEED);
      cdo::sim::PressModel model(CDO_PRESS_CYCLE_SEC, CDO_PRESS_SHAFT_HZ, CDO_PRESS_SPECTRUM_START_HZ,
                                 CDO_PRESS_SPECTRUM_STEP_HZ, CDO_PRESS_SPECTRUM_COUNT, &rng,
                                 CDO_PRESS_CHANNELS);

      for (int k = 0; k < CDO_PRESS_SELFTEST_TIME_COUNT; ++k) {
        const double t = CDO_PRESS_SELFTEST_TIMES[k];
        double values[3];
        double bins[cdo::sim::PressModel::kMaxBins];
        model.sample(t, scenario, r, values, bins);
        Serial.printf("S {\"m\":\"press\",\"sc\":\"%s\",\"r\":%g,\"t\":%g,\"v\":[", name, r, t);
        selftestPrintValues(values, 3);
        Serial.print("],\"bins\":[");
        selftestPrintValues(bins, model.binCount());
        Serial.print("]}\n");
        esp_task_wdt_reset();
      }
    }
  }
}

static void selftestRunOnce() {
  Serial.print("CDO-SELFTEST-BEGIN\n");
  Serial.printf("H {\"fw\":\"%s\",\"catalog\":\"%s\",\"seed\":%u}\n", FW_VERSION, CDO_CATALOG_ID,
                static_cast<unsigned>(CDO_SELFTEST_SEED));
  selftestRobot();
  selftestPress();
  Serial.print("CDO-SELFTEST-END\n");
}

#endif  // CDO_SELFTEST
