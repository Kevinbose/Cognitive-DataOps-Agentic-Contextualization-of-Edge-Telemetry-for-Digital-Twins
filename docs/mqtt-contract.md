# MQTT contract v1

This is the wire contract between the edge gateways (ESP32 boards or the software simulator) and the Node ingestion service. It is frozen for Phase 3. Changing a field name, a topic or a unit means bumping `v` and updating all three consumers: `firmware/`, `server/scripts/simulate-devices.mjs` and `server/src/validators/telemetry.validator.js`.

The channel catalog (keys, units, ranges, limits) lives in one file, [`firmware/catalog.json`](../firmware/catalog.json). `scripts/gen-catalog.mjs` turns it into the firmware header, the simulator reads it directly, and a backend test asserts that the simulator's `birth` message equals it.

## Namespace

```
cdo/v1/{siteId}/{machineId}/{suffix}

siteId    vit-lab                       MQTT_SITE_ID on the server, SITE_ID in secrets.h
machineId robot-weld-01 | press-stamp-01   lowercase kebab, ^[a-z0-9-]{1,48}$
```

The layout follows the ISA-95 Unified Namespace idea (site, area, machine, data product), with JSON payloads instead of Sparkplug protobuf so the wire traffic can be read in a terminal.

## Topics

| Suffix | Direction | QoS and retain | Cadence | Payload |
|---|---|---|---|---|
| `birth` | device to backend | retained | every connect | JSON, channel catalog and identity |
| `status` | device to backend | retained, Last Will QoS 1 | connect, and broker on drop | plain text `online` or `offline` |
| `telemetry` | device to backend | QoS 0, not retained | 500 ms (250 to 5000 ms) | JSON, all scalar channels of one tick |
| `spectrum` | device to backend | QoS 0 | 2 s, press only | JSON, 64 amplitude bins |
| `diag` | device to backend | QoS 0 | 15 s | JSON, link and heap health, simulator ground truth |
| `log` | device to backend | QoS 0, at most 5 lines per second | event driven | plain text line, at most 160 characters |
| `cmd/scenario` | backend to device | QoS 1 | on demand | JSON command |
| `cmd/interval` | backend to device | QoS 1 | on demand | JSON command |
| `cmd/reboot` | backend to device | QoS 1 | on demand | JSON command |
| `cmd/ping` | backend to device | QoS 1 | on demand | JSON command |
| `ack` | device to backend | QoS 0 | per command | JSON |

PubSubClient 2.8 (the ESP32 MQTT library) publishes at QoS 0 only. That is acceptable for periodic telemetry, and the retained `birth` and `status` are re-published on every reconnect. The Last Will is sent in the connect packet, so its QoS 1 and retain flags work.

## Payloads

### `birth`

```json
{
  "v": 1,
  "machineId": "press-stamp-01",
  "machineType": "press",
  "label": "Stamping press 01",
  "fw": "1.0.0",
  "mac": "AA:BB:CC:DD:EE:FF",
  "bootId": "7f3a9c21",
  "intervalMs": 500,
  "scenarios": ["NORMAL", "CLOGGED_FILTER", "BEARING_WEAR"],
  "channels": [
    {
      "key": "LUBE_OIL_PRESSURE",
      "label": "Lube oil pressure",
      "unit": "bar",
      "sensorType": "pressure",
      "min": 0,
      "max": 8,
      "decimals": 2,
      "limits": { "warnLow": 3.6, "alarmLow": 3.0 }
    }
  ],
  "spectrum": {
    "key": "BEARING_SPECTRUM",
    "label": "Bearing vibration spectrum",
    "unit": "mm/s",
    "startHz": 0,
    "stepHz": 12.5,
    "count": 64,
    "intervalMs": 2000,
    "fundamentalHz": 24.7
  }
}
```

`spectrum` is `null` on machines that have none. `fundamentalHz` (optional) is the machine's fundamental frequency, such as motor shaft speed, so a viewer can mark its harmonics without hard-coding any machine. `limits` may carry any of `warnLow`, `warnHigh`, `alarmLow`, `alarmHigh`. `bootId` changes on every boot, which lets the backend tell a reboot (sequence restarts at 0) from packet loss. The firmware keeps birth under 1400 bytes.

### `telemetry`

```json
{"v":1,"seq":18234,"ts":1767225600123,"synced":true,
 "m":{"MAIN_MOTOR_CURRENT":96.4,"LUBE_OIL_PRESSURE":4.51,"BEARING_VIBRATION_RMS":1.21}}
```

- `ts` is epoch milliseconds from SNTP. TLS builds do not connect until time is synced, so `synced:false` only occurs in plain MQTT builds. The backend then stamps its own receive time and ignores `ts`. A `ts` more than two minutes away from the server clock is treated the same way.
- `seq` counts telemetry messages since boot. The backend counts gaps as packet loss.
- Values are formatted with the channel's `decimals` (`%.2f` style), never with raw float printing.
- Keys are UPPER_SNAKE and match `^[A-Z][A-Z0-9_]{0,63}$`. Unknown keys before `birth` are accepted with empty metadata.

### `spectrum`

```json
{"v":1,"seq":421,"ts":1767225600123,"key":"BEARING_SPECTRUM","amp":[0.031,0.044,...]}
```

`amp.length` must equal `spectrum.count` from `birth`. Bin `i` covers `startHz + i * stepHz`. A spectrum is an array, so it is a separate data product and cannot be bound to a mesh; the scalar `BEARING_VIBRATION_RMS` is computed from the same bins and is bindable.

### `diag`

```json
{"v":1,"ts":1767225600123,"fw":"1.0.0","bootId":"7f3a9c21","uptimeS":1234,"rssi":-58,
 "heapFree":212340,"heapMin":198000,"reset":"POWERON","wifiReconnects":1,"mqttReconnects":2,
 "restarts":0,"publishFailures":0,"tls":true,"insecure":false,
 "sim":{"scenario":"CLOGGED_FILTER","ramp":0.42,"rampSec":120}}
```

`sim` is the simulator's ground truth. The backend strips it from every general stream and every agent-facing endpoint (see "Ground truth" below).

### Commands

```json
{"cmdId":"c-8f2a","issuedAt":1767225600123,"ttlMs":10000,"scenario":"CLOGGED_FILTER","rampSec":120}
```

| Topic | Arguments |
|---|---|
| `cmd/scenario` | `scenario` (must be in the device's `scenarios`), optional `rampSec` (5 to 600, default 120) |
| `cmd/interval` | `intervalMs` (250 to 5000) |
| `cmd/reboot` | none |
| `cmd/ping` | none |

The device discards an expired command (`now - issuedAt > ttlMs`, only when its clock is synced), deduplicates by `cmdId` (QoS 1 can deliver twice) and acknowledges from its main loop, never from inside the MQTT callback. The device uses a clean session, so a queued `reboot` can never replay hours later. The backend marks a command failed after 5 s without an `ack`.

A `cmdId` is 1 to 32 characters from `A-Z`, `a-z`, `0-9` and `-`. The backend rejects an `ack` carrying any other id, so a device echoes only ids of that form and ignores a command with a different one. A `reboot` makes the board publish a retained `offline`, disconnect cleanly and restart, so the platform shows it offline at once instead of waiting for the Last Will.

### `ack`

```json
{"cmdId":"c-8f2a","name":"scenario","ok":true,"detail":"CLOGGED_FILTER ramp 120s","ts":1767225600456}
```

## Broker access

HiveMQ Cloud Serverless (free plan) ties one topic-filter permission to each credential.

- Each device credential: publish and subscribe on `cdo/v1/vit-lab/<machineId>/#`.
- The backend credential: publish and subscribe on `cdo/v1/vit-lab/#`.
- The backend subscribes to each suffix explicitly (`cdo/v1/vit-lab/+/telemetry`, and so on). A `+/+` filter would not match `cmd/scenario`.

Only one backend at a time may subscribe to a cloud broker. Both machines publish about 77 MB per day, so three subscribers would consume the 10 GB monthly quota. Teammates use local Mosquitto and the simulator.

## Backend behaviour that consumers can rely on

- Every message is parsed against a strict regex for the topic and a strict zod schema for the payload. Invalid messages are dropped and counted, never thrown.
- A device is `stale` when no telemetry arrived for `max(5 s, 4 x intervalMs)`, whatever the retained `status` says.
- Persistence keeps the last sample per channel per second. Readings and spectra are MongoDB time-series collections with a 48 h TTL.
- `sensorId` for a binding is `MACHINE_ID.CHANNEL_KEY` in upper case, for example `PRESS-STAMP-01.LUBE_OIL_PRESSURE`.

## Simulated machines and faults

Both the ESP32 firmware (`firmware/cdo-edge-gateway/simulation.h`) and the software simulator (`server/scripts/lib/sim-models.mjs`) implement the same models, and `fw selftest` checks on the chip that they agree to 12 significant digits. The limits below are illustrative constants chosen for the demo, not vendor values.

| Machine | Scenario | What changes | Crosses warn | Crosses alarm |
|---|---|---|---|---|
| Welding robot | `GEARBOX_WEAR` | Axis 4 torque mean rises, a sixth-harmonic ripple appears, noise grows; TCP deviation rises | Torque at about 48% of the ramp | Torque at about 82% |
| Stamping press | `CLOGGED_FILTER` | Lube pressure falls (the transducer is downstream of the filter); a **broadband** noise floor appears above 300 Hz; vibration RMS rises; motor current rises 3% | Pressure at about 44%, RMS peaks from about 30% | Pressure at about 74%, RMS mean at about 74% |
| Stamping press | `BEARING_WEAR` | Lube pressure stays normal; a **discrete harmonic family** appears at 3.55, 7.1, 10.65, 14.2 and 17.75 times the shaft frequency with sidebands; motor current rises 8% | RMS flickers over the limit at stroke peaks from about 60% of the ramp, and is over it most of the time from about 80% | Never: RMS peaks at 3.2 mm/s against an alarm limit of 4.0 |

`BEARING_WEAR` is the case a plain threshold alarm misses, which is the argument for detecting drift and for diagnosing from the spectrum's shape. The two press faults share a symptom (high bearing vibration) and differ in evidence: the lube pressure, and broadband versus harmonic energy.

The ramp `r` runs from 0 to 1 over `rampSec` (default 120 s) after a `cmd/scenario`. The press builds its spectrum first and computes the vibration RMS from its bins, so the scalar and the plot always agree.

## Ground truth

The simulator publishes its active fault scenario only inside `diag.sim`. The backend stores it on the device record (excluded from queries by default) and serves it only through `GET /api/v1/devices/:machineId/sim` for the fault-injection panel and the evaluation harness. It never appears in `device:update` events, and Phase 5's `/agent/*` tool API must not expose it either, otherwise the diagnosis agent could read the answer.
