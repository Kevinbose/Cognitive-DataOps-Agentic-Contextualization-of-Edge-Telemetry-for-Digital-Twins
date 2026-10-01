/*
 * Constants, build flags and the mapping from MACHINE_TYPE to the generated
 * catalog. Nothing in here has behaviour; it only names things.
 */

#pragma once

#include <Arduino.h>

#include "machine_select.h"

#define FW_VERSION "1.0.0"

/* ---- Build flags ------------------------------------------------------------
 * Set them in secrets.h, or with -D on the compiler command line. The self-test
 * build (scripts/fw.mjs selftest) needs no Wi-Fi, so it skips secrets.h.
 */
#ifndef CDO_SELFTEST
#define CDO_SELFTEST 0
#endif

#if !CDO_SELFTEST
#include "secrets.h"
#endif

/* TLS to the broker. On by default: HiveMQ Cloud requires it. */
#ifndef CDO_TLS
#define CDO_TLS 1
#endif

/* Over-the-air updates. Experimental; off until both boards are stable. */
#ifndef CDO_OTA
#define CDO_OTA 0
#endif

/* Accept an unverified TLS connection when the clock cannot be set. Off. */
#ifndef CDO_ALLOW_INSECURE_FALLBACK
#define CDO_ALLOW_INSECURE_FALLBACK 0
#endif

#ifndef SITE_ID
#define SITE_ID CDO_DEFAULT_SITE_ID
#endif

#include "catalog.h"

/* ---- The active machine -----------------------------------------------------
 * Both machines' tables exist in catalog.h; these macros pick one.
 */
#if MACHINE_TYPE == 1
#define MACHINE_ID CDO_ROBOT_MACHINE_ID
#define MACHINE_INTERVAL_MS CDO_ROBOT_INTERVAL_MS
#define MACHINE_CHANNELS CDO_ROBOT_CHANNELS
#define MACHINE_CHANNEL_COUNT CDO_ROBOT_CHANNEL_COUNT
#define MACHINE_SCENARIOS CDO_ROBOT_SCENARIOS
#define MACHINE_SCENARIO_COUNT CDO_ROBOT_SCENARIO_COUNT
#define MACHINE_BIRTH_FMT CDO_ROBOT_BIRTH_FMT
#define MACHINE_BIRTH_MAX CDO_ROBOT_BIRTH_MAX
#define MACHINE_HAS_SPECTRUM CDO_ROBOT_HAS_SPECTRUM
#define MACHINE_SPECTRUM_KEY CDO_ROBOT_SPECTRUM_KEY
#define MACHINE_SPECTRUM_COUNT CDO_ROBOT_SPECTRUM_COUNT
#define MACHINE_SPECTRUM_INTERVAL_MS CDO_ROBOT_SPECTRUM_INTERVAL_MS
#define MACHINE_NAME "welding robot"
#if !CDO_SELFTEST
#define MQTT_USER MQTT_USER_ROBOT
#define MQTT_PASS MQTT_PASS_ROBOT
#endif
#elif MACHINE_TYPE == 2
#define MACHINE_ID CDO_PRESS_MACHINE_ID
#define MACHINE_INTERVAL_MS CDO_PRESS_INTERVAL_MS
#define MACHINE_CHANNELS CDO_PRESS_CHANNELS
#define MACHINE_CHANNEL_COUNT CDO_PRESS_CHANNEL_COUNT
#define MACHINE_SCENARIOS CDO_PRESS_SCENARIOS
#define MACHINE_SCENARIO_COUNT CDO_PRESS_SCENARIO_COUNT
#define MACHINE_BIRTH_FMT CDO_PRESS_BIRTH_FMT
#define MACHINE_BIRTH_MAX CDO_PRESS_BIRTH_MAX
#define MACHINE_HAS_SPECTRUM CDO_PRESS_HAS_SPECTRUM
#define MACHINE_SPECTRUM_KEY CDO_PRESS_SPECTRUM_KEY
#define MACHINE_SPECTRUM_COUNT CDO_PRESS_SPECTRUM_COUNT
#define MACHINE_SPECTRUM_INTERVAL_MS CDO_PRESS_SPECTRUM_INTERVAL_MS
#define MACHINE_NAME "stamping press"
#if !CDO_SELFTEST
#define MQTT_USER MQTT_USER_PRESS
#define MQTT_PASS MQTT_PASS_PRESS
#endif
#else
#error "MACHINE_TYPE must be 1 (welding robot) or 2 (stamping press). See machine_select.h."
#endif

/* ---- Sizes ------------------------------------------------------------------
 * PubSubClient's publish() silently returns false when its buffer is smaller than
 * 5 + 2 + topic + payload, and it silently drops oversized incoming packets. So
 * the buffer is raised from its 256 byte default, and the compiler checks that
 * the largest message fits (see the static_asserts in the sketch).
 */
constexpr uint16_t CDO_MQTT_BUFFER_BYTES = 2048;
constexpr size_t CDO_SITE_ID_MAX = 32;
constexpr size_t CDO_TOPIC_MAX = 128;

constexpr size_t CDO_TELEMETRY_BYTES = 384;
constexpr size_t CDO_SPECTRUM_BYTES = 1024;
constexpr size_t CDO_DIAG_BYTES = 512;
constexpr size_t CDO_ACK_BYTES = 384;

constexpr size_t CDO_CMD_QUEUE = 4;
constexpr size_t CDO_CMD_PAYLOAD_MAX = 256;
constexpr size_t CDO_CMD_NAME_MAX = 12;
constexpr size_t CDO_SEEN_COMMANDS = 16;

constexpr size_t CDO_LOG_QUEUE = 8;
constexpr size_t CDO_LOG_LINE_MAX = 160;
constexpr uint32_t CDO_LOG_MIN_GAP_MS = 200; /* at most 5 lines per second */

/* ---- Timing -----------------------------------------------------------------
 * Every wait on the network has an upper bound, so the board cannot wedge.
 * Worst case for one connection attempt: DNS, plus TCP_TIMEOUT_MS, plus
 * TLS_HANDSHAKE_S, plus MQTT_SOCKET_TIMEOUT_S.
 */
constexpr uint32_t CDO_WIFI_ATTEMPT_MS = 8000;
constexpr uint32_t CDO_TIME_SYNC_ROUND_MS = 15000;
constexpr uint32_t CDO_SNTP_INTERVAL_MS = 60000;
constexpr uint32_t CDO_TCP_TIMEOUT_MS = 5000;
constexpr unsigned long CDO_TLS_HANDSHAKE_S = 10;
constexpr uint16_t CDO_MQTT_SOCKET_TIMEOUT_S = 5;
constexpr uint16_t CDO_MQTT_KEEPALIVE_S = 10;

/* Backoff after a failure: 1, 2, 4, 8, 16, 30, then 60 s, with +/- 20 percent jitter. */
constexpr uint32_t CDO_BACKOFF_STEPS_MS[] = {1000, 2000, 4000, 8000, 16000, 30000, 60000};
constexpr size_t CDO_BACKOFF_STEP_COUNT = sizeof(CDO_BACKOFF_STEPS_MS) / sizeof(CDO_BACKOFF_STEPS_MS[0]);
constexpr uint32_t CDO_STABLE_RESET_MS = 60000; /* this long in RUNNING clears the failure count */

constexpr uint32_t CDO_DIAG_INTERVAL_MS = 15000;
constexpr uint32_t CDO_WATCHDOG_MS = 60000;
constexpr uint32_t CDO_STUCK_RESTART_MS = 10UL * 60UL * 1000UL; /* not RUNNING this long: restart */
constexpr uint8_t CDO_PUBLISH_FAIL_LIMIT = 5;                   /* consecutive failures force a reconnect */
constexpr uint32_t CDO_ANNOUNCE_GAP_MS = 40;

/* Time counts as set once the system clock is past 1 January 2025. */
constexpr time_t CDO_MIN_VALID_EPOCH = 1735689600;
constexpr uint8_t CDO_INSECURE_AFTER_ROUNDS = 3;

constexpr uint32_t CDO_SERIAL_BAUD = 115200;
