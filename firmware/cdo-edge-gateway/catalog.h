/*
 * GENERATED FILE. Do not edit.
 *
 * Source:    firmware/catalog.json
 * Generator: node scripts/gen-catalog.mjs
 * Catalog:   bfde0aca5c
 *
 * A backend test checks that this file is what the generator produces, and
 * that each birth template expands to the message the software simulator
 * publishes, so the firmware and the simulator cannot disagree about a channel.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#define CDO_CONTRACT_VERSION 1
#define CDO_DEFAULT_SITE_ID "vit-lab"
#define CDO_CATALOG_ID "bfde0aca5c"

/* Fixed-seed parity plan for the on-chip self-test (catalog.json, "selftest"). */
#define CDO_SELFTEST_SEED 4242u
#define CDO_SELFTEST_RAMP_COUNT 5
static constexpr double CDO_SELFTEST_RAMPS[CDO_SELFTEST_RAMP_COUNT] = {0.0, 0.25, 0.5, 0.75, 1.0};

/* One scalar channel. lo and hi are the clamp range; decimals is the print precision. */
struct CdoChannel {
  const char* key;
  double lo;
  double hi;
  uint8_t decimals;
};

/* --- robot-weld-01 (MACHINE_TYPE 1) ----------------------------------------------- */

#define CDO_ROBOT_TYPE_CODE 1
#define CDO_ROBOT_MACHINE_ID "robot-weld-01"
#define CDO_ROBOT_INTERVAL_MS 500
#define CDO_ROBOT_CYCLE_SEC 8.0

#define CDO_ROBOT_CHANNEL_COUNT 3
static constexpr CdoChannel CDO_ROBOT_CHANNELS[CDO_ROBOT_CHANNEL_COUNT] = {
  {"AXIS_4_SERVO_TORQUE", 0.0, 45.0, 1},
  {"TOOL_CENTER_POINT_DEVIATION", 0.0, 2.0, 3},
  {"WELD_GUN_TEMP", 20.0, 140.0, 1},
};

#define CDO_ROBOT_SCENARIO_COUNT 2
static constexpr const char* CDO_ROBOT_SCENARIOS[CDO_ROBOT_SCENARIO_COUNT] = {
  "NORMAL",
  "GEARBOX_WEAR",
};

#define CDO_ROBOT_HAS_SPECTRUM 0
#define CDO_ROBOT_SPECTRUM_KEY ""
#define CDO_ROBOT_SPECTRUM_START_HZ 0.0
#define CDO_ROBOT_SPECTRUM_STEP_HZ 1.0
#define CDO_ROBOT_SPECTRUM_COUNT 0
#define CDO_ROBOT_SPECTRUM_INTERVAL_MS 0
#define CDO_ROBOT_SHAFT_HZ 0.0

#define CDO_ROBOT_SELFTEST_TIME_COUNT 6
static constexpr double CDO_ROBOT_SELFTEST_TIMES[6] = {4.0, 4.5, 5.0, 5.5, 6.0, 6.5};

/* Birth message as a printf template: firmware version, MAC, boot id (all %s). */
static const char CDO_ROBOT_BIRTH_FMT[] =
    "{\"v\":1,\"machineId\":\"robot-weld-01\",\"machineType\":\"robot\",\"label\":\"Welding robot 01\","
    "\"fw\":\"%s\",\"mac\":\"%s\",\"bootId\":\"%s\",\"intervalMs\":500,\"scenarios\":[\"NORMAL\","
    "\"GEARBOX_WEAR\"],\"channels\":[{\"key\":\"AXIS_4_SERVO_TORQUE\",\"label\":\"Axis 4 servo torque\","
    "\"unit\":\"Nm\",\"sensorType\":\"torque\",\"min\":0,\"max\":45,\"decimals\":1,\"limits\":{\"warnHigh\":26,"
    "\"alarmHigh\":30}},{\"key\":\"TOOL_CENTER_POINT_DEVIATION\","
    "\"label\":\"Tool centre point deviation\",\"unit\":\"mm\",\"sensorType\":\"displacement\",\"min\":0,"
    "\"max\":2,\"decimals\":3,\"limits\":{\"warnHigh\":0.25,\"alarmHigh\":0.5}},{\"key\":\"WELD_GUN_TEMP\","
    "\"label\":\"Weld gun temperature\",\"unit\":\"degC\",\"sensorType\":\"temperature\",\"min\":20,"
    "\"max\":140,\"decimals\":1,\"limits\":{\"warnHigh\":85,\"alarmHigh\":105}}],\"spectrum\":null}";
#define CDO_ROBOT_BIRTH_MAX (sizeof(CDO_ROBOT_BIRTH_FMT) + 57)

/* --- press-stamp-01 (MACHINE_TYPE 2) ---------------------------------------------- */

#define CDO_PRESS_TYPE_CODE 2
#define CDO_PRESS_MACHINE_ID "press-stamp-01"
#define CDO_PRESS_INTERVAL_MS 500
#define CDO_PRESS_CYCLE_SEC 4.6

#define CDO_PRESS_CHANNEL_COUNT 3
static constexpr CdoChannel CDO_PRESS_CHANNELS[CDO_PRESS_CHANNEL_COUNT] = {
  {"MAIN_MOTOR_CURRENT", 0.0, 250.0, 1},
  {"LUBE_OIL_PRESSURE", 0.0, 8.0, 2},
  {"BEARING_VIBRATION_RMS", 0.0, 12.0, 2},
};

#define CDO_PRESS_SCENARIO_COUNT 3
static constexpr const char* CDO_PRESS_SCENARIOS[CDO_PRESS_SCENARIO_COUNT] = {
  "NORMAL",
  "CLOGGED_FILTER",
  "BEARING_WEAR",
};

#define CDO_PRESS_HAS_SPECTRUM 1
#define CDO_PRESS_SPECTRUM_KEY "BEARING_SPECTRUM"
#define CDO_PRESS_SPECTRUM_START_HZ 0.0
#define CDO_PRESS_SPECTRUM_STEP_HZ 12.5
#define CDO_PRESS_SPECTRUM_COUNT 64
#define CDO_PRESS_SPECTRUM_INTERVAL_MS 2000
#define CDO_PRESS_SHAFT_HZ 24.7

#define CDO_PRESS_SELFTEST_TIME_COUNT 2
static constexpr double CDO_PRESS_SELFTEST_TIMES[2] = {10.0, 11.6};

/* Birth message as a printf template: firmware version, MAC, boot id (all %s). */
static const char CDO_PRESS_BIRTH_FMT[] =
    "{\"v\":1,\"machineId\":\"press-stamp-01\",\"machineType\":\"press\",\"label\":\"Stamping press 01\","
    "\"fw\":\"%s\",\"mac\":\"%s\",\"bootId\":\"%s\",\"intervalMs\":500,\"scenarios\":[\"NORMAL\","
    "\"CLOGGED_FILTER\",\"BEARING_WEAR\"],\"channels\":[{\"key\":\"MAIN_MOTOR_CURRENT\","
    "\"label\":\"Main motor current\",\"unit\":\"A\",\"sensorType\":\"current\",\"min\":0,\"max\":250,"
    "\"decimals\":1,\"limits\":{\"warnHigh\":175,\"alarmHigh\":195}},{\"key\":\"LUBE_OIL_PRESSURE\","
    "\"label\":\"Lube oil pressure\",\"unit\":\"bar\",\"sensorType\":\"pressure\",\"min\":0,\"max\":8,"
    "\"decimals\":2,\"limits\":{\"warnLow\":3.6,\"alarmLow\":3}},{\"key\":\"BEARING_VIBRATION_RMS\","
    "\"label\":\"Bearing vibration RMS\",\"unit\":\"mm/s\",\"sensorType\":\"vibration\",\"min\":0,\"max\":12,"
    "\"decimals\":2,\"limits\":{\"warnHigh\":2.5,\"alarmHigh\":4}}],"
    "\"spectrum\":{\"key\":\"BEARING_SPECTRUM\",\"label\":\"Bearing vibration spectrum\",\"unit\":\"mm/s\","
    "\"startHz\":0,\"stepHz\":12.5,\"count\":64,\"intervalMs\":2000,\"fundamentalHz\":24.7}}";
#define CDO_PRESS_BIRTH_MAX (sizeof(CDO_PRESS_BIRTH_FMT) + 57)
