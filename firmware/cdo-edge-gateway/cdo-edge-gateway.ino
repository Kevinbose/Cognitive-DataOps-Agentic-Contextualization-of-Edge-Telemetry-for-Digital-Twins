/*
 * Cognitive DataOps edge gateway.
 *
 * One ESP32 plays one machine of a car plant, a welding robot or a stamping
 * press (machine_select.h). It does what a real plant gateway does with a
 * machine controller's data: announce the channels it has, publish their values
 * as JSON over MQTT, and tell the platform when it drops off the network.
 *
 *   cdo/v1/<site>/<machine>/birth      retained   channel catalog, every connect
 *   cdo/v1/<site>/<machine>/status     retained   online / offline (Last Will)
 *   cdo/v1/<site>/<machine>/telemetry             all scalar channels, 2 Hz
 *   cdo/v1/<site>/<machine>/spectrum              vibration spectrum, press only
 *   cdo/v1/<site>/<machine>/diag                  link and heap health, every 15 s
 *   cdo/v1/<site>/<machine>/log                   remote debug lines
 *   cdo/v1/<site>/<machine>/cmd/#      in         scenario, interval, reboot, ping
 *   cdo/v1/<site>/<machine>/ack                   answer to each command
 *
 * The wire contract is docs/mqtt-contract.md. The numbers come from the models
 * in simulation.h, the C++ twin of the software simulator.
 *
 * ## Why the loop is built the way it is
 *
 * The board is meant to run headless for days. It must never wedge, so:
 *   - A state machine (Wi-Fi, clock, MQTT, running, backoff) in which every wait
 *     on the network has an upper bound (config.h).
 *   - The clock is set BEFORE the TLS connection. A certificate is valid for a
 *     period, so a board that still thinks it is 1970 fails the handshake with an
 *     error that looks like a network fault.
 *   - A 60 s task watchdog on the loop, and a restart if the board has not been
 *     RUNNING for 10 minutes.
 *   - PubSubClient's callback shares one buffer with outgoing packets, so the
 *     callback only queues the command. The loop does the work and publishes.
 *   - PubSubClient publishes at QoS 0 only, and publish() silently fails when the
 *     buffer is too small. So the buffer is raised, the compiler checks the
 *     largest message fits, and every publish result is counted.
 */

#include "config.h"

#if CDO_SELFTEST

/* ---- Parity self-test build: no Wi-Fi, prints the model vectors. -------------- */

#include "selftest.h"

void setup() {
  Serial.begin(CDO_SERIAL_BAUD);
  delay(1500);
  Serial.printf("\nCDO self-test, firmware %s, catalog %s\n", FW_VERSION, CDO_CATALOG_ID);
}

void loop() {
  selftestRunOnce();
  delay(10000);
}

#else

/* ---- The gateway ------------------------------------------------------------- */

#include <ArduinoJson.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <esp_sntp.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <inttypes.h>
#include <stdarg.h>
#include <sys/time.h>
#include <time.h>

#if CDO_TLS
#include <NetworkClientSecure.h>
#if __has_include("root_ca.h")
#include "root_ca.h"
#else
#error "TLS needs root_ca.h. Put the broker's CA bundle in firmware/certs/root_ca.pem and run: node scripts/gen-catalog.mjs (see firmware/README.md). For a broker without TLS, set CDO_TLS to 0 in secrets.h."
#endif
#endif

#if CDO_OTA
#include <ArduinoOTA.h>
#ifndef OTA_PASSWORD
#error "CDO_OTA needs OTA_PASSWORD in secrets.h"
#endif
#endif

#include "payloads.h"
#include "simulation.h"
#include "types.h"

using cdo::DiagInfo;
using cdo::sim::Scenario;
using cdo::sim::ScenarioState;

/* ---- Compile-time checks ------------------------------------------------------
 * These turn a silent runtime failure into a build error.
 */

constexpr bool streq(const char* a, const char* b) {
  while (*a != '\0' && *a == *b) {
    ++a;
    ++b;
  }
  return *a == *b;
}

constexpr bool validSiteId(const char* s) {
  size_t n = 0;
  for (; s[n] != '\0'; ++n) {
    const char c = s[n];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
  }
  return n >= 1 && n <= CDO_SITE_ID_MAX;
}

static_assert(validSiteId(SITE_ID), "SITE_ID must be 1 to 32 characters from a-z, 0-9 and hyphen (server: ^[a-z0-9-]{1,32}$)");

/* Each publish needs 5 + 2 + topic + payload bytes of PubSubClient buffer. */
constexpr size_t kPublishOverhead = 7 + CDO_TOPIC_MAX;
static_assert(MACHINE_BIRTH_MAX + kPublishOverhead <= CDO_MQTT_BUFFER_BYTES, "birth message does not fit the MQTT buffer");
static_assert(CDO_SPECTRUM_BYTES + kPublishOverhead <= CDO_MQTT_BUFFER_BYTES, "spectrum message does not fit the MQTT buffer");
static_assert(CDO_DIAG_BYTES + kPublishOverhead <= CDO_MQTT_BUFFER_BYTES, "diag message does not fit the MQTT buffer");
static_assert(CDO_TELEMETRY_BYTES + kPublishOverhead <= CDO_MQTT_BUFFER_BYTES, "telemetry message does not fit the MQTT buffer");
static_assert(MACHINE_SPECTRUM_COUNT <= cdo::sim::PressModel::kMaxBins, "spectrum has more bins than the model buffer holds");
static_assert(MACHINE_CHANNEL_COUNT == 3, "the models produce exactly three channels");

/* The models write their three values by position, so the catalog order matters. */
#if MACHINE_TYPE == 1
static_assert(streq(MACHINE_CHANNELS[0].key, "AXIS_4_SERVO_TORQUE") && streq(MACHINE_CHANNELS[1].key, "TOOL_CENTER_POINT_DEVIATION") &&
                  streq(MACHINE_CHANNELS[2].key, "WELD_GUN_TEMP"),
              "catalog channel order no longer matches the robot model in simulation.h");
#else
static_assert(streq(MACHINE_CHANNELS[0].key, "MAIN_MOTOR_CURRENT") && streq(MACHINE_CHANNELS[1].key, "LUBE_OIL_PRESSURE") &&
                  streq(MACHINE_CHANNELS[2].key, "BEARING_VIBRATION_RMS"),
              "catalog channel order no longer matches the press model in simulation.h");
#endif

/* ---- State --------------------------------------------------------------------- */

static const char* stateName(State s) {
  switch (s) {
    case State::WifiConnect: return "WIFI_CONNECT";
    case State::TimeSync: return "TIME_SYNC";
    case State::MqttConnect: return "MQTT_CONNECT";
    case State::Running: return "RUNNING";
    case State::Backoff: return "BACKOFF";
  }
  return "?";
}

static State state = State::WifiConnect;
static uint32_t notRunningSince = 0;
static uint32_t runningSince = 0;
static uint32_t backoffUntil = 0;
static uint8_t failures = 0;

/* Identity, fixed for one boot. */
static char macText[18];
static char bootId[9];
static char clientId[64];
static const char* resetReason = "UNKNOWN";
RTC_DATA_ATTR static uint32_t rtcRestarts = 0;

/* Topics, built once. */
static char baseTopic[CDO_TOPIC_MAX];
static char statusTopic[CDO_TOPIC_MAX + 8];
static char cmdFilter[CDO_TOPIC_MAX + 8];
static char cmdPrefix[CDO_TOPIC_MAX + 8];

/* Network. */
static WiFiMulti wifiMulti;
#if CDO_TLS
static NetworkClientSecure net;
#else
static WiFiClient net;
#endif
static PubSubClient mqtt(net);

/* Counters reported in diag. */
static volatile uint32_t gotIpEvents = 0;
static volatile uint8_t lastDisconnectReason = 0;
static volatile uint32_t disconnectEvents = 0;
static uint32_t reportedDisconnects = 0;
static uint32_t mqttConnects = 0;
static uint32_t publishFailuresTotal = 0;
static uint8_t publishFailuresInARow = 0;
static bool insecureInUse = false;

/* Time sync. */
static bool sntpStarted = false;
static uint32_t sntpRoundStartedAt = 0;
static uint8_t sntpRounds = 0;

/* The simulated machine. Both models exist; only the active one runs. */
static cdo::sim::Rng rng(1);
[[maybe_unused]] static cdo::sim::RobotModel robotModel(CDO_ROBOT_CYCLE_SEC, &rng, CDO_ROBOT_CHANNELS);
[[maybe_unused]] static cdo::sim::PressModel pressModel(CDO_PRESS_CYCLE_SEC, CDO_PRESS_SHAFT_HZ, CDO_PRESS_SPECTRUM_START_HZ,
                                       CDO_PRESS_SPECTRUM_STEP_HZ, CDO_PRESS_SPECTRUM_COUNT, &rng,
                                       CDO_PRESS_CHANNELS);
static ScenarioState scenarioState;
[[maybe_unused]] static double spectrumBins[cdo::sim::PressModel::kMaxBins];

/* Publish schedule. */
static uint32_t intervalMs = MACHINE_INTERVAL_MS;
static uint32_t nextTelemetryAt = 0;
static uint32_t nextDiagAt = 0;
[[maybe_unused]] static uint32_t nextSpectrumAt = 0;
static uint32_t telemetrySeq = 0;
[[maybe_unused]] static uint32_t spectrumSeq = 0;

/* Buffers. File scope, so the loop allocates nothing. */
static char birthBuffer[MACHINE_BIRTH_MAX];
static char telemetryBuffer[CDO_TELEMETRY_BYTES];
[[maybe_unused]] static char spectrumBuffer[CDO_SPECTRUM_BYTES];
static char diagBuffer[CDO_DIAG_BYTES];
static char ackBuffer[CDO_ACK_BYTES];

/* ---- Logging ------------------------------------------------------------------
 * A line goes to the serial port at once, and into a small queue that the loop
 * publishes to the `log` topic, at most five a second. Named cdoLog because
 * logf() is already a function in <math.h>.
 */

static char logQueue[CDO_LOG_QUEUE][CDO_LOG_LINE_MAX];
static uint8_t logHead = 0;
static uint8_t logCount = 0;
static uint32_t lastLogPublishAt = 0;

static void cdoLog(const char* format, ...) __attribute__((format(printf, 1, 2)));
static void cdoLog(const char* format, ...) {
  char line[CDO_LOG_LINE_MAX];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof line, format, args);
  va_end(args);

  for (char* p = line; *p != '\0'; ++p) {
    if (static_cast<unsigned char>(*p) < 0x20) *p = ' ';
  }

  Serial.printf("[%9" PRIu32 "] %s\n", millis(), line);

  if (logCount == CDO_LOG_QUEUE) {
    logHead = (logHead + 1) % CDO_LOG_QUEUE;
    --logCount;
  }
  strncpy(logQueue[(logHead + logCount) % CDO_LOG_QUEUE], line, CDO_LOG_LINE_MAX - 1);
  logQueue[(logHead + logCount) % CDO_LOG_QUEUE][CDO_LOG_LINE_MAX - 1] = '\0';
  ++logCount;
}

/* ---- Time ---------------------------------------------------------------------- */

static bool timeSynced() {
  return time(nullptr) >= CDO_MIN_VALID_EPOCH;
}

static uint64_t epochMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return static_cast<uint64_t>(tv.tv_sec) * 1000ULL + static_cast<uint64_t>(tv.tv_usec) / 1000ULL;
}

/* Epoch milliseconds once the clock is set, milliseconds since boot before that.
 * The backend ignores `ts` when `synced` is false. */
static uint64_t stampMs() {
  return timeSynced() ? epochMs() : static_cast<uint64_t>(millis());
}

/* Seconds since boot, the clock the simulated machine runs on. */
static double simTimeSec() {
  return static_cast<double>(esp_timer_get_time()) * 1e-6;
}

static const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXT";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    case ESP_RST_USB: return "USB";
    case ESP_RST_JTAG: return "JTAG";
    case ESP_RST_EFUSE: return "EFUSE";
    case ESP_RST_PWR_GLITCH: return "PWR_GLITCH";
    case ESP_RST_CPU_LOCKUP: return "CPU_LOCKUP";
    default: return "UNKNOWN";
  }
}

/* ---- State machine plumbing ---------------------------------------------------- */

static void enter(State next) {
  if (state == State::Running && next != State::Running) notRunningSince = millis();
  if (next == State::Running) runningSince = millis();
  state = next;
  cdoLog("state %s", stateName(next));
}

/* Leave whatever we were doing, wait, and start again from Wi-Fi. The wait grows
 * 1, 2, 4, 8, 16, 30, then 60 s, with +/- 20 percent jitter so two boards that
 * lost the same router do not retry in lockstep. */
static void beginBackoff(const char* reason) {
  net.stop();
  sntpStarted = false;

  const size_t index = failures < CDO_BACKOFF_STEP_COUNT ? failures : CDO_BACKOFF_STEP_COUNT - 1;
  const uint32_t base = CDO_BACKOFF_STEPS_MS[index];
  const uint32_t spread = base / 5;
  const uint32_t waitMs = base - spread + (esp_random() % (2 * spread + 1));
  if (failures < 255) ++failures;

  backoffUntil = millis() + waitMs;
  cdoLog("%s; retry in %" PRIu32 " ms", reason, waitMs);
  enter(State::Backoff);
}

/* ---- Wi-Fi --------------------------------------------------------------------- */

/* Runs on the Wi-Fi event task, not the loop: it only records, and the loop reports. */
static void onWifiEvent(arduino_event_id_t event, arduino_event_info_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    gotIpEvents = gotIpEvents + 1;
  } else if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    lastDisconnectReason = info.wifi_sta_disconnected.reason;
    disconnectEvents = disconnectEvents + 1;
  }
}

static void reportWifiEvents() {
  const uint32_t seen = disconnectEvents;
  if (seen != reportedDisconnects) {
    cdoLog("wifi disconnect event, reason %u", static_cast<unsigned>(lastDisconnectReason));
    reportedDisconnects = seen;
  }
}

static void stepWifi() {
  if (WiFi.status() != WL_CONNECTED) {
    wifiMulti.run(CDO_WIFI_ATTEMPT_MS);
  }

  if (WiFi.status() == WL_CONNECTED) {
    /* The network name goes to the serial port only: cdoLog also publishes to the
     * broker, and a home network's name is not the broker's business. */
    Serial.printf("[%9" PRIu32 "] wifi network %s\n", millis(), WiFi.SSID().c_str());
    cdoLog("wifi up: ip %s, rssi %d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
#if CDO_OTA
    static bool otaStarted = false;
    if (!otaStarted) {
      otaStarted = true;
      ArduinoOTA.setHostname(clientId);
      ArduinoOTA.setPassword(OTA_PASSWORD);
      ArduinoOTA.onStart([]() { cdoLog("ota start"); });
      ArduinoOTA.onProgress([](unsigned int, unsigned int) { esp_task_wdt_reset(); });
      ArduinoOTA.onError([](ota_error_t error) { cdoLog("ota error %u", static_cast<unsigned>(error)); });
      ArduinoOTA.begin();
    }
#endif
    enter(State::TimeSync);
    return;
  }

  beginBackoff("wifi not connected");
}

/* ---- Time sync ------------------------------------------------------------------ */

static void startSntp() {
  static const char* const servers[3] = {"pool.ntp.org", "time.cloudflare.com", "time.google.com"};
  /* A different server first on every round, so one that is blocked does not stall us. */
  const uint8_t first = sntpRounds % 3;
  sntp_set_sync_interval(CDO_SNTP_INTERVAL_MS);
  configTime(0, 0, servers[first], servers[(first + 1) % 3], servers[(first + 2) % 3]);
  sntpRoundStartedAt = millis();
  cdoLog("sntp round %u, first server %s", static_cast<unsigned>(sntpRounds + 1), servers[first]);
}

static void stepTime() {
  if (timeSynced()) {
    cdoLog("clock set, epoch %" PRIu32, static_cast<uint32_t>(time(nullptr)));
    enter(State::MqttConnect);
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    beginBackoff("wifi lost while waiting for the clock");
    return;
  }
  if (!sntpStarted) {
    sntpStarted = true;
    sntpRounds = 0;
    startSntp();
  }

  if (millis() - sntpRoundStartedAt < CDO_TIME_SYNC_ROUND_MS) {
    delay(50);
    return;
  }

#if CDO_TLS
  /* A certificate is only valid during a period, so TLS needs the real time. */
  ++sntpRounds;
#if CDO_ALLOW_INSECURE_FALLBACK
  if (sntpRounds >= CDO_INSECURE_AFTER_ROUNDS) {
    cdoLog("clock still not set: continuing WITHOUT certificate checking (CDO_ALLOW_INSECURE_FALLBACK)");
    net.setInsecure();
    insecureInUse = true;
    enter(State::MqttConnect);
    return;
  }
#endif
  cdoLog("clock not set after %" PRIu32 " s, trying the next server", CDO_TIME_SYNC_ROUND_MS / 1000);
  startSntp();
#else
  cdoLog("clock not set, continuing without it (telemetry will say synced:false)");
  enter(State::MqttConnect);
#endif
}

/* ---- Publishing ----------------------------------------------------------------- */

static void noteResult(bool ok) {
  if (ok) {
    publishFailuresInARow = 0;
    return;
  }
  ++publishFailuresTotal;
  if (publishFailuresInARow < 255) ++publishFailuresInARow;
}

static bool publishTo(const char* suffix, const char* payload, bool retain) {
  char topic[CDO_TOPIC_MAX + 16];
  snprintf(topic, sizeof topic, "%s/%s", baseTopic, suffix);
  const bool ok = mqtt.publish(topic, payload, retain);
  noteResult(ok);
  return ok;
}

/* Keep the MQTT client serviced for a short while, without blocking the watchdog. */
static void pump(uint32_t ms) {
  const uint32_t started = millis();
  while (millis() - started < ms) {
    mqtt.loop();
    esp_task_wdt_reset();
    delay(2);
  }
}

static bool publishDiag() {
  DiagInfo d{};
  d.tsMs = stampMs();
  d.fw = FW_VERSION;
  d.bootId = bootId;
  d.uptimeS = static_cast<uint32_t>(esp_timer_get_time() / 1000000LL);
  const int rssi = WiFi.RSSI();
  d.rssi = rssi > 0 ? 0 : (rssi < -127 ? -127 : rssi);
  d.heapFree = ESP.getFreeHeap();
  d.heapMin = ESP.getMinFreeHeap();
  d.reset = resetReason;
  d.wifiReconnects = gotIpEvents > 0 ? gotIpEvents - 1 : 0;
  d.mqttReconnects = mqttConnects > 0 ? mqttConnects - 1 : 0;
  d.restarts = rtcRestarts;
  d.publishFailures = publishFailuresTotal;
  d.tls = CDO_TLS != 0;
  d.insecure = insecureInUse;
  d.scenario = cdo::sim::scenarioName(scenarioState.scenario);
  d.ramp = cdo::sim::rampOf(scenarioState, simTimeSec());
  d.rampSec = scenarioState.rampSec;

  if (cdo::formatDiag(diagBuffer, sizeof diagBuffer, d) < 0) {
    cdoLog("diag did not fit its buffer");
    return false;
  }
  return publishTo("diag", diagBuffer, false);
}

/* Identity first, then state, then diagnostics, with a short pause between them:
 * PubSubClient needs loop time between packets, and some brokers drop a retained
 * message when the same client publishes again in the same instant. */
static bool announce() {
  const int n = snprintf(birthBuffer, sizeof birthBuffer, MACHINE_BIRTH_FMT, FW_VERSION, macText, bootId);
  if (n <= 0 || static_cast<size_t>(n) >= sizeof birthBuffer) {
    cdoLog("birth did not fit its buffer");
    return false;
  }
  bool ok = publishTo("birth", birthBuffer, true);
  pump(CDO_ANNOUNCE_GAP_MS);
  ok = publishTo("status", "online", true) && ok;
  pump(CDO_ANNOUNCE_GAP_MS);
  ok = publishDiag() && ok;
  return ok;
}

static void sendAck(const char* cmdId, const char* name, bool ok, const char* detail) {
  if (cdo::formatAck(ackBuffer, sizeof ackBuffer, cmdId, name, ok, detail, stampMs()) < 0) {
    cdoLog("ack did not fit its buffer");
    return;
  }
  publishTo("ack", ackBuffer, false);
}

/* One tick of the simulated machine: sample the model, publish telemetry, and on
 * the press also the spectrum every spectrum interval. */
static void tick(uint32_t now) {
  const double t = simTimeSec();
  const double r = cdo::sim::rampOf(scenarioState, t);
  double values[MACHINE_CHANNEL_COUNT];

#if MACHINE_TYPE == 1
  robotModel.sample(t, scenarioState.scenario, r, values);
#else
  pressModel.sample(t, scenarioState.scenario, r, values, spectrumBins);
#endif

  const bool synced = timeSynced();
  const uint64_t ts = stampMs();

  if (cdo::formatTelemetry(telemetryBuffer, sizeof telemetryBuffer, telemetrySeq, ts, synced, MACHINE_CHANNELS,
                           MACHINE_CHANNEL_COUNT, values) < 0) {
    cdoLog("telemetry did not fit its buffer");
    noteResult(false);
  } else {
    publishTo("telemetry", telemetryBuffer, false);
  }
  /* The sequence counts every attempt, so a failed publish shows as a gap. */
  ++telemetrySeq;

#if MACHINE_HAS_SPECTRUM
  /* Drift-free, like the telemetry schedule, so the spectrum goes out on every
   * fourth tick instead of wandering between two and two and a half seconds. */
  if (static_cast<int32_t>(now - nextSpectrumAt) >= 0) {
    nextSpectrumAt += MACHINE_SPECTRUM_INTERVAL_MS;
    if (static_cast<int32_t>(now - nextSpectrumAt) > 2 * static_cast<int32_t>(MACHINE_SPECTRUM_INTERVAL_MS)) {
      nextSpectrumAt = now;
    }
    if (cdo::formatSpectrum(spectrumBuffer, sizeof spectrumBuffer, spectrumSeq, ts, MACHINE_SPECTRUM_KEY,
                            spectrumBins, pressModel.binCount()) < 0) {
      cdoLog("spectrum did not fit its buffer");
      noteResult(false);
    } else {
      publishTo("spectrum", spectrumBuffer, false);
    }
    ++spectrumSeq;
  }
#endif
}

/* ---- Commands ------------------------------------------------------------------- */

static PendingCommand commandQueue[CDO_CMD_QUEUE];
static uint8_t commandHead = 0;
static uint8_t commandCount = 0;
static uint32_t commandsDropped = 0;
static uint32_t commandsDroppedReported = 0;

static char seenCommandIds[CDO_SEEN_COMMANDS][33];
static uint8_t seenNext = 0;

static bool alreadySeen(const char* id) {
  for (size_t i = 0; i < CDO_SEEN_COMMANDS; ++i) {
    if (strcmp(seenCommandIds[i], id) == 0) return true;
  }
  return false;
}

static void remember(const char* id) {
  strncpy(seenCommandIds[seenNext], id, sizeof seenCommandIds[0] - 1);
  seenCommandIds[seenNext][sizeof seenCommandIds[0] - 1] = '\0';
  seenNext = (seenNext + 1) % CDO_SEEN_COMMANDS;
}

/* PubSubClient calls this from inside mqtt.loop(), on a buffer it also uses for
 * outgoing packets, so nothing is published from here: the command is copied into
 * the queue and the loop handles it. */
static void onMqttMessage(char* topic, uint8_t* payload, unsigned int length) {
  const size_t prefixLength = strlen(cmdPrefix);
  if (strncmp(topic, cmdPrefix, prefixLength) != 0) return;

  const char* name = topic + prefixLength;
  const size_t nameLength = strlen(name);
  if (nameLength == 0 || nameLength >= CDO_CMD_NAME_MAX || length >= CDO_CMD_PAYLOAD_MAX ||
      commandCount >= CDO_CMD_QUEUE) {
    ++commandsDropped;
    return;
  }

  PendingCommand& slot = commandQueue[(commandHead + commandCount) % CDO_CMD_QUEUE];
  memcpy(slot.name, name, nameLength + 1);
  memcpy(slot.payload, payload, length);
  slot.payload[length] = '\0';
  slot.length = static_cast<uint16_t>(length);
  ++commandCount;
}

/* Announce a clean shutdown, then restart. The broker keeps the retained
 * `offline`, and the next boot's birth and `online` replace it. */
static void rebootNow() {
  cdoLog("rebooting on command");
  publishTo("status", "offline", true);
  pump(100);
  mqtt.disconnect();
  delay(100);
  ESP.restart();
}

static void handleCommand(const PendingCommand& command) {
  static JsonDocument doc;
  doc.clear();

  if (deserializeJson(doc, command.payload, command.length)) {
    cdoLog("cmd %s: not valid JSON", command.name);
    return;
  }

  char cmdId[33];
  cdo::sanitizeInto(cmdId, sizeof cmdId, doc["cmdId"] | "");
  if (!cdo::isValidCommandId(cmdId)) {
    cdoLog("cmd %s: missing or invalid cmdId", command.name);
    return;
  }

  const bool isScenario = strcmp(command.name, "scenario") == 0;
  const bool isInterval = strcmp(command.name, "interval") == 0;
  const bool isReboot = strcmp(command.name, "reboot") == 0;
  const bool isPing = strcmp(command.name, "ping") == 0;
  if (!(isScenario || isInterval || isReboot || isPing)) {
    cdoLog("cmd %s: unknown command", command.name);
    return;
  }

  /* QoS 1 can deliver twice. Acknowledge the repeat, do not act on it again. */
  if (alreadySeen(cmdId)) {
    sendAck(cmdId, command.name, true, "duplicate ignored");
    return;
  }
  remember(cmdId);

  /* Discard a command that waited too long. Only meaningful with a real clock. */
  if (timeSynced() && doc["issuedAt"].is<double>() && doc["ttlMs"].is<double>()) {
    const double age = static_cast<double>(epochMs()) - doc["issuedAt"].as<double>();
    if (age > doc["ttlMs"].as<double>()) {
      sendAck(cmdId, command.name, false, "expired");
      return;
    }
  }

  char detail[CDO_LOG_LINE_MAX];

  if (isScenario) {
    const char* wanted = doc["scenario"] | "";
    const Scenario scenario = cdo::sim::scenarioFromName(wanted);
    bool supported = false;
    for (size_t i = 0; i < MACHINE_SCENARIO_COUNT; ++i) {
      if (strcmp(MACHINE_SCENARIOS[i], wanted) == 0) supported = true;
    }
    if (scenario == Scenario::SC_UNKNOWN || !supported) {
      char safe[48];
      cdo::sanitizeInto(safe, sizeof safe, wanted);
      snprintf(detail, sizeof detail, "unknown scenario %s", safe);
      sendAck(cmdId, command.name, false, detail);
      return;
    }

    double rampSec = 120.0;
    if (doc["rampSec"].is<double>()) {
      const double asked = doc["rampSec"].as<double>();
      if (isfinite(asked) && asked > 0.0) rampSec = cdo::sim::clampd(asked, 1.0, 3600.0);
    }
    scenarioState.scenario = scenario;
    scenarioState.startedAtSec = simTimeSec();
    scenarioState.rampSec = rampSec;

    snprintf(detail, sizeof detail, "%s ramp %gs", wanted, rampSec);
    sendAck(cmdId, command.name, true, detail);
    cdoLog("scenario %s", detail);
    publishDiag(); /* so the ground truth is current at once */
    return;
  }

  if (isInterval) {
    const double asked = doc["intervalMs"].is<double>() ? doc["intervalMs"].as<double>() : -1.0;
    if (!(asked >= 250.0 && asked <= 5000.0) || asked != floor(asked)) {
      sendAck(cmdId, command.name, false, "intervalMs out of range");
      return;
    }
    intervalMs = static_cast<uint32_t>(asked);
    nextTelemetryAt = millis();
    snprintf(detail, sizeof detail, "interval %" PRIu32 "ms", intervalMs);
    sendAck(cmdId, command.name, true, detail);
    cdoLog("%s", detail);
    return;
  }

  if (isPing) {
    sendAck(cmdId, command.name, true, "pong");
    return;
  }

  /* reboot */
  sendAck(cmdId, command.name, true, "rebooting");
  rebootNow();
}

static void processCommands() {
  if (commandsDropped != commandsDroppedReported) {
    cdoLog("dropped %" PRIu32 " command(s): queue full or message too large", commandsDropped - commandsDroppedReported);
    commandsDroppedReported = commandsDropped;
  }
  while (commandCount > 0) {
    const PendingCommand command = commandQueue[commandHead];
    commandHead = (commandHead + 1) % CDO_CMD_QUEUE;
    --commandCount;
    handleCommand(command);
  }
}

/* ---- MQTT ------------------------------------------------------------------------ */

static void stepMqtt() {
  if (WiFi.status() != WL_CONNECTED) {
    beginBackoff("wifi lost before mqtt");
    return;
  }

  cdoLog("mqtt connecting to %s:%d%s", MQTT_HOST, MQTT_PORT, CDO_TLS ? " (tls)" : "");

  const char* user = MQTT_USER[0] != '\0' ? MQTT_USER : nullptr;
  const char* pass = MQTT_PASS[0] != '\0' ? MQTT_PASS : nullptr;
  /* clean session, so a command queued while we were away can never replay hours
   * later; Last Will QoS 1 and retained, so the broker tells everyone we are gone. */
  const bool connected = mqtt.connect(clientId, user, pass, statusTopic, 1, true, "offline", true);

  if (!connected) {
    char reason[96];
    snprintf(reason, sizeof reason, "mqtt connect failed (state %d)", mqtt.state());
#if CDO_TLS
    char tlsError[80];
    const int code = net.lastError(tlsError, sizeof tlsError);
    if (code != 0) cdoLog("tls error %d: %s", code, tlsError);
#endif
    beginBackoff(reason);
    return;
  }

  ++mqttConnects;
  mqtt.subscribe(cmdFilter, 1);
  announce();

  const uint32_t now = millis();
  nextTelemetryAt = now;
  nextSpectrumAt = now;
  nextDiagAt = now + CDO_DIAG_INTERVAL_MS;
  publishFailuresInARow = 0;
  cdoLog("mqtt connected, client %s", clientId);
  enter(State::Running);
}

static void flushRemoteLog(uint32_t now) {
  if (logCount == 0 || now - lastLogPublishAt < CDO_LOG_MIN_GAP_MS) return;
  lastLogPublishAt = now;
  publishTo("log", logQueue[logHead], false);
  logHead = (logHead + 1) % CDO_LOG_QUEUE;
  --logCount;
}

static void stepRunning(uint32_t now) {
  if (WiFi.status() != WL_CONNECTED) {
    beginBackoff("wifi lost");
    return;
  }
  if (!mqtt.loop()) {
    char reason[64];
    snprintf(reason, sizeof reason, "mqtt connection lost (state %d)", mqtt.state());
    beginBackoff(reason);
    return;
  }
  if (publishFailuresInARow >= CDO_PUBLISH_FAIL_LIMIT) {
    mqtt.disconnect();
    beginBackoff("publish keeps failing");
    return;
  }

  processCommands();

  /* Drift-free schedule: add the interval to the planned time, not to "now". If we
   * are still more than two intervals behind (a reconnect took seconds), skip
   * ahead instead of publishing a burst to catch up. */
  if (static_cast<int32_t>(now - nextTelemetryAt) >= 0) {
    nextTelemetryAt += intervalMs;
    if (static_cast<int32_t>(now - nextTelemetryAt) > 2 * static_cast<int32_t>(intervalMs)) nextTelemetryAt = now;
    tick(now);
  }

  if (static_cast<int32_t>(now - nextDiagAt) >= 0) {
    nextDiagAt += CDO_DIAG_INTERVAL_MS;
    if (static_cast<int32_t>(now - nextDiagAt) > 2 * static_cast<int32_t>(CDO_DIAG_INTERVAL_MS)) nextDiagAt = now;
    publishDiag();
  }

  flushRemoteLog(now);

  if (failures > 0 && now - runningSince >= CDO_STABLE_RESET_MS) {
    cdoLog("stable for %" PRIu32 " s, failure count cleared", CDO_STABLE_RESET_MS / 1000);
    failures = 0;
  }
}

/* ---- Arduino entry points ---------------------------------------------------------- */

static void configureWatchdog() {
  /* Core 3.x has already set up the task watchdog (5 s, panic on, core-0 idle task
   * only) and does not watch the loop task. Widen the timeout to 60 s, which covers
   * a full worst-case connection attempt, and put the loop task under it. */
  esp_task_wdt_config_t config = {CDO_WATCHDOG_MS, 1, true};
  if (esp_task_wdt_reconfigure(&config) != ESP_OK) esp_task_wdt_init(&config);
  enableLoopWDT();
}

static void buildIdentity() {
  const uint64_t mac = ESP.getEfuseMac();
  snprintf(macText, sizeof macText, "%02X:%02X:%02X:%02X:%02X:%02X", static_cast<unsigned>(mac & 0xFF),
           static_cast<unsigned>((mac >> 8) & 0xFF), static_cast<unsigned>((mac >> 16) & 0xFF),
           static_cast<unsigned>((mac >> 24) & 0xFF), static_cast<unsigned>((mac >> 32) & 0xFF),
           static_cast<unsigned>((mac >> 40) & 0xFF));
  snprintf(bootId, sizeof bootId, "%08" PRIx32, esp_random());
  snprintf(clientId, sizeof clientId, "cdo-%s-%02X%02X%02X", MACHINE_ID, static_cast<unsigned>((mac >> 24) & 0xFF),
           static_cast<unsigned>((mac >> 32) & 0xFF), static_cast<unsigned>((mac >> 40) & 0xFF));

  snprintf(baseTopic, sizeof baseTopic, "cdo/v%d/%s/%s", CDO_CONTRACT_VERSION, SITE_ID, MACHINE_ID);
  snprintf(statusTopic, sizeof statusTopic, "%s/status", baseTopic);
  snprintf(cmdFilter, sizeof cmdFilter, "%s/cmd/#", baseTopic);
  snprintf(cmdPrefix, sizeof cmdPrefix, "%s/cmd/", baseTopic);
}

static void printBanner() {
  Serial.println();
  Serial.println("==================================================");
  Serial.printf("CDO edge gateway %s\n", FW_VERSION);
  Serial.printf("  machine   %s (%s, MACHINE_TYPE %d)\n", MACHINE_ID, MACHINE_NAME, MACHINE_TYPE);
  Serial.printf("  site      %s\n", SITE_ID);
  Serial.printf("  mac       %s\n", macText);
  Serial.printf("  boot id   %s\n", bootId);
  Serial.printf("  catalog   %s\n", CDO_CATALOG_ID);
  Serial.printf("  chip      %s rev %d, %d MHz, %lu KB flash\n", ESP.getChipModel(), static_cast<int>(ESP.getChipRevision()),
                static_cast<int>(ESP.getCpuFreqMHz()), static_cast<unsigned long>(ESP.getFlashChipSize() / 1024));
  Serial.printf("  sdk       %s\n", ESP.getSdkVersion());
  Serial.printf("  reset     %s (restarts since power-on: %" PRIu32 ")\n", resetReason, rtcRestarts);
  Serial.printf("  broker    %s:%d %s\n", MQTT_HOST, MQTT_PORT, CDO_TLS ? "tls" : "PLAIN, no encryption");
  Serial.println("==================================================");
}

void setup() {
  Serial.begin(CDO_SERIAL_BAUD);
#if ARDUINO_USB_CDC_ON_BOOT
  /* Without a host attached, a blocking USB write would stall the loop. */
  Serial.setTxTimeoutMs(0);
  const uint32_t waitUntil = millis() + 1500;
  while (!Serial && millis() < waitUntil) delay(10);
#endif
  delay(200);

  const esp_reset_reason_t reason = esp_reset_reason();
  resetReason = resetReasonName(reason);
  /* RTC memory survives a software reset, a panic and a watchdog reset, and is
   * garbage only after power-on. */
  rtcRestarts = reason == ESP_RST_POWERON ? 0 : rtcRestarts + 1;

  buildIdentity();
  printBanner();
  configureWatchdog();

#ifdef LED_BUILTIN
  pinMode(LED_BUILTIN, OUTPUT);
#endif

  /* Wi-Fi. No modem sleep: it is a common cause of MQTT stalls. */
  WiFi.persistent(false);
  WiFi.setHostname(clientId);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.onEvent(onWifiEvent);
  if (WIFI_SSID_1[0] != '\0') wifiMulti.addAP(WIFI_SSID_1, WIFI_PASS_1);
  if (WIFI_SSID_2[0] != '\0') wifiMulti.addAP(WIFI_SSID_2, WIFI_PASS_2);
  if (WIFI_SSID_3[0] != '\0') wifiMulti.addAP(WIFI_SSID_3, WIFI_PASS_3);

  /* TLS and MQTT. Every wait is bounded (see config.h). */
#if CDO_TLS
  net.setCACert(CDO_ROOT_CA_PEM);
  net.setHandshakeTimeout(CDO_TLS_HANDSHAKE_S);
#endif
  net.setConnectionTimeout(CDO_TCP_TIMEOUT_MS);

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(CDO_MQTT_KEEPALIVE_S);
  mqtt.setSocketTimeout(CDO_MQTT_SOCKET_TIMEOUT_S);
  mqtt.setCallback(onMqttMessage);
  if (!mqtt.setBufferSize(CDO_MQTT_BUFFER_BYTES)) {
    /* Out of memory this early means something is badly wrong; a restart is the only fix. */
    Serial.println("FATAL: cannot allocate the MQTT buffer, restarting");
    delay(1000);
    ESP.restart();
  }

  rng.seed(esp_random());
  notRunningSince = millis();
  cdoLog("starting");
  enter(State::WifiConnect);
}

#ifdef LED_BUILTIN
/* A short blink every two seconds while running, a steady flicker while connecting. */
static void updateLed(uint32_t now) {
  const bool on = state == State::Running ? (now % 2000) < 80 : (now % 400) < 200;
  digitalWrite(LED_BUILTIN, on ? HIGH : LOW);
}
#endif

void loop() {
  esp_task_wdt_reset();
  const uint32_t now = millis();

  reportWifiEvents();

  switch (state) {
    case State::WifiConnect: stepWifi(); break;
    case State::TimeSync: stepTime(); break;
    case State::MqttConnect: stepMqtt(); break;
    case State::Running: stepRunning(now); break;
    case State::Backoff:
      if (static_cast<int32_t>(now - backoffUntil) >= 0) enter(State::WifiConnect);
      break;
  }

#if CDO_OTA
  if (WiFi.status() == WL_CONNECTED) ArduinoOTA.handle();
#endif

  /* Last resort: a board that has not been RUNNING for ten minutes restarts. */
  if (state != State::Running && now - notRunningSince > CDO_STUCK_RESTART_MS) {
    Serial.println("not running for 10 minutes, restarting");
    delay(200);
    ESP.restart();
  }

#ifdef LED_BUILTIN
  updateLed(now);
#endif

  delay(2);
}

#endif  // CDO_SELFTEST
