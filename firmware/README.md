# Edge gateway firmware

Two ESP32 boards act as edge telemetry gateways for a car plant. One plays a **welding robot** (`robot-weld-01`), the other a **stamping press** (`press-stamp-01`). Each simulates its machine's controller, announces the channels it has, publishes their values as JSON over MQTT, and tells the platform when it drops off the network. The platform side is the Node service in `server/`.

Both boards run the same code. One number in `machine_select.h` is the only difference between them.

The wire format is in [`docs/mqtt-contract.md`](../docs/mqtt-contract.md). The channel catalog (keys, units, ranges, alarm limits) is [`catalog.json`](catalog.json), the single source of truth for the firmware, the software simulator and the backend.

## Files

| File | Purpose |
|---|---|
| `catalog.json` | Channels, limits, spectrum layout and the self-test plan. Edit this, never `catalog.h`. |
| `cdo-edge-gateway/cdo-edge-gateway.ino` | The sketch: connection state machine, publishers, command handler. |
| `cdo-edge-gateway/config.h` | Constants, timeouts, build flags, the mapping from machine to catalog. |
| `cdo-edge-gateway/machine_select.h` | `MACHINE_TYPE`: 1 is the robot, 2 is the press. |
| `cdo-edge-gateway/simulation.h` | The two machine models, a C++ port of `server/scripts/lib/sim-models.mjs`. |
| `cdo-edge-gateway/payloads.h` | Telemetry, spectrum, diag and ack builders. |
| `cdo-edge-gateway/catalog.h` | Generated from `catalog.json` by `scripts/gen-catalog.mjs`. Committed. |
| `cdo-edge-gateway/secrets.example.h` | Template. Copy it to `secrets.h`. |
| `cdo-edge-gateway/secrets.h` | Your Wi-Fi and broker credentials. **Gitignored. Never commit it.** |
| `cdo-edge-gateway/root_ca.h` | Generated from `firmware/certs/root_ca.pem`. Gitignored. |
| `certs/root_ca.pem` | The CA certificate(s) that anchor the broker's TLS chain. You supply it. |
| `.logs/` | Serial monitor logs. Gitignored. |

The tool that drives all of this is [`scripts/fw.mjs`](../scripts/fw.mjs). It wraps the `arduino-cli` bundled with the Arduino IDE 2.x, so nothing needs installing beyond what the IDE already has: the ESP32 core (3.3.10 here), `PubSubClient` and `ArduinoJson`.

```bash
node scripts/fw.mjs doctor     # check the toolchain, catalog, secrets and certificate
node scripts/fw.mjs ports      # list ports and flag ESP32 bridges by USB id
```

## What you need

- Two ESP32 boards, one USB **data** cable (many cables only charge) and one charger.
- A **2.4 GHz** Wi-Fi network. An ESP32 cannot join a 5 GHz-only network or an enterprise network that asks for a username and certificate or a login page. A phone hotspot is the reliable fallback away from home, and you can list up to three networks in `secrets.h`.
- A broker. Plan A is HiveMQ Cloud. Plan B is a Mosquitto on your own network (see below).
- On Windows, a USB driver for the board's bridge chip: CP210x boards need the Silicon Labs driver, CH340 and CH9102 boards need the WCH driver. `fw ports` lists USB devices that Windows knows about and flags one whose driver is missing.

## One-time setup

### 1. Broker, Plan A: HiveMQ Cloud

Creating the account and cluster is yours to do. The free Serverless plan allows 100 connections and 10 GB a month, over TLS on port 8883.

1. Create a cluster and note its hostname, which looks like `<cluster-id>.s1.eu.hivemq.cloud`.
2. Create three credentials, each with publish and subscribe permission on one topic filter:

   | Credential | Topic filter |
   |---|---|
   | backend | `cdo/v1/vit-lab/#` |
   | robot | `cdo/v1/vit-lab/robot-weld-01/#` |
   | press | `cdo/v1/vit-lab/press-stamp-01/#` |

3. Put the backend credential in `server/.env`:

   ```
   MQTT_URL=mqtts://<cluster-id>.s1.eu.hivemq.cloud:8883
   MQTT_USERNAME=...
   MQTT_PASSWORD=...
   ```

   The URL must not contain the credentials. `server/.env` is gitignored.

Only **one backend at a time** should subscribe to the cloud broker, and only one per database should persist. See the notes in `server/.env.example`.

### 2. The certificate

TLS needs the CA certificate that anchors the broker's chain. Do not guess it: ask the broker which chain it serves.

```bash
openssl s_client -connect <cluster-id>.s1.eu.hivemq.cloud:8883 -servername <cluster-id>.s1.eu.hivemq.cloud -showcerts </dev/null
```

Each certificate prints with an `s:` (subject) and `i:` (issuer) line. The servers normally send the leaf and the intermediates but not the root, so look at the **issuer of the last certificate**. That is the root you need. Download it from the certificate authority's own website, in PEM format, and save it as `firmware/certs/root_ca.pem`. Put several certificates in the one file if you want a spare.

Check the file against the live broker before you flash anything:

```bash
openssl s_client -connect <cluster-id>.s1.eu.hivemq.cloud:8883 -servername <cluster-id>.s1.eu.hivemq.cloud -CAfile firmware/certs/root_ca.pem </dev/null 2>&1 | grep "Verify return code"
```

It must say `Verify return code: 0 (ok)`. Then generate the header:

```bash
node scripts/fw.mjs gen
```

This parses every certificate in the PEM, refuses an expired one and prints each subject with its expiry date. Re-run the `openssl` check from time to time: a CA that changes its chain would otherwise show up as a handshake failure on a headless board.

### 3. Secrets

```bash
cp firmware/cdo-edge-gateway/secrets.example.h firmware/cdo-edge-gateway/secrets.h
```

Edit `secrets.h`: your Wi-Fi networks, the broker hostname and the robot and press credentials. Every value that starts with `CHANGE_ME` must be replaced. The tool refuses to upload while one is left.

## Bring-up: two boards, one data cable

Only one board can be on the data cable at a time. Flash and debug the first board, move it to the charger, then do the second.

1. **Nothing attached.** Run `node scripts/fw.mjs ports` and confirm no ESP32 is listed. Close the Arduino IDE's serial monitor if it is open: it holds the port.
2. **Attach board 1 by the data cable.** Run `fw ports` again. A new line appears with a USB id such as `10C4:EA60`. The tool identifies boards by that id, never by COM number, because COM numbers move around and Bluetooth serial ports look like boards.
3. **Select, compile, upload, watch.**

   ```bash
   node scripts/fw.mjs select robot
   node scripts/fw.mjs compile
   node scripts/fw.mjs upload --port COM7 --confirm-machine robot
   node scripts/fw.mjs monitor --port COM7 --seconds 40
   ```

   The monitor shows a banner with the machine, MAC address, firmware version and boot id, then the state machine going Wi-Fi, clock, MQTT, running. Confirm on the broker side:

   ```bash
   node server/scripts/mqtt-tail.mjs        # formatted, or:
   mosquitto_sub -h <broker> -p 8883 --capath <ca dir> -u <user> -P <pass> -t "cdo/v1/vit-lab/#" -v
   ```

   Board 1 is now provably alive.
4. **Parity check (recommended once).** `node scripts/fw.mjs selftest --port COM7 --confirm-overwrite` replaces the firmware with a self-test, compares what the C++ models print with the JavaScript models, and reports PASS or FAIL. It needs no Wi-Fi. Afterwards compile and upload the real firmware again.
5. **Move board 1 to the charger.** It boots without a computer. From here its `log` and `diag` topics replace the serial monitor.
6. **Attach board 2** by the data cable, then `select press`, `compile`, `upload --confirm-machine press`, `monitor`. Leave it tethered for serial debugging.
7. **Later updates.** Repeat 2 and 3 one board at a time, or enable OTA (below).

If an upload cannot connect, hold the board's BOOT button while the tool prints "Connecting", or retry at a lower upload speed (`UploadSpeed=115200` in the FQBN options).

The default board is `esp32:esp32:esp32` (ESP32 Dev Module). If yours is an ESP32-S3 or C3, pass `--fqbn`, and use `esp32:esp32:esp32s3:CDCOnBoot=cdc` when the board is attached by its native USB port (vendor id `303A`).

## Commands

| Command | What it does |
|---|---|
| `doctor` | Checks `arduino-cli`, the ESP32 core, libraries, `catalog.h`, `secrets.h` placeholders and the certificate. |
| `ports [--json]` | Lists serial ports and the USB devices Windows knows about, flagging ESP32 bridges. |
| `select robot\|press` | Writes `MACHINE_TYPE` into `machine_select.h`. This is a tracked file, so `git status` shows it. |
| `gen` | Regenerates `catalog.h` and, if `certs/root_ca.pem` exists, `root_ca.h`. `compile` does this for you. |
| `compile [--fqbn F] [--tls 0\|1]` | Compiles a staged copy. Needs no `secrets.h`; without one it is a **compile check only**. |
| `upload --port P --confirm-machine M` | Flashes the last build. Refuses unsafe uploads (below). |
| `monitor --port P [--seconds N]` | Reads the serial port and saves it under `firmware/.logs/`. |
| `selftest --port P --confirm-overwrite` | Flashes the parity self-test, reads it and judges it. |
| `log [--lines N]` | Prints the end of the newest monitor log. |

### What `upload` refuses

- A port whose USB id is not on the allow-list of ESP32 bridges (CP210x `10C4:EA60`, CH340 `1A86:7523`, CH9102 `1A86:55D4`, FTDI `0403:6001`, any Espressif `303A`). Bluetooth serial ports and unrelated devices are never touched.
- No `--confirm-machine`, or one that is not the machine that was compiled. Flashing the robot image onto the press board cannot happen by accident.
- A sketch that has changed since it was compiled, or a build made after `machine_select.h` changed.
- A build that was a compile check only, a missing `secrets.h`, or a `secrets.h` that still has `CHANGE_ME` values.

The tool never chooses a port. You name it, after reading `ports`.

Build output goes to a short path under the system temp directory, not into the repository. The ESP32 toolchain overruns Windows' 260 character path limit inside a deep project folder.

## Reading a board you cannot tether

Once running, a board publishes everything you would otherwise read from a serial monitor:

- `cdo/v1/vit-lab/<machine>/log`: plain-text lines, at most five a second: state changes, Wi-Fi disconnect reasons, commands.
- `cdo/v1/vit-lab/<machine>/diag`: every 15 s, RSSI, free and minimum heap, uptime, reset reason, reconnect counts, publish failures.
- Commands go the other way: `cmd/ping`, `cmd/scenario`, `cmd/interval`, `cmd/reboot`, answered on `ack`. The web UI's fault-injection panel uses them.

A healthy board shows a stable minimum heap in `diag` over a 30-minute soak. A falling one is a leak.

## Power-cut test

Pull the board's power. The broker publishes its Last Will, a retained `offline`, within about 15 seconds: the keepalive is 10 s and a broker waits one and a half intervals. Restore power and it comes back on its own: retained `birth`, then `online`, with no reset button.

Also try switching a phone hotspot off and on. The board should log the disconnect, back off (1, 2, 4, 8, 16, 30, then 60 s, with jitter), reconnect and carry on.

## Plan B: a broker on your own network

Use this if you would rather not use a cloud broker. Your Mosquitto currently listens only on the loopback address, so the boards cannot reach it. To let them:

1. In `mosquitto.conf`, add a listener and a password file (Mosquitto 2 accepts no anonymous clients unless you tell it to):

   ```
   listener 1883 0.0.0.0
   password_file C:\path\to\passwords
   allow_anonymous false
   ```

   Create the file with `mosquitto_passwd -c C:\path\to\passwords backend`, then add `robot` and `press` with `mosquitto_passwd -b`.
2. Allow the port through Windows Firewall on your private network profile:

   ```
   netsh advfirewall firewall add rule name="Mosquitto 1883" dir=in action=allow protocol=TCP localport=1883 profile=private
   ```

3. In `secrets.h`:

   ```
   #define MQTT_HOST "192.168.1.50"     // your laptop's address; reserve it in the router
   #define MQTT_PORT 1883
   #define CDO_TLS   0
   ```

   and fill in the credentials. With `CDO_TLS 0` nothing is encrypted and the clock is not required, so `synced:false` can appear in telemetry until SNTP completes. Keep this on a network you trust.
4. Point the server at it: `MQTT_URL=mqtt://127.0.0.1:1883` works when the backend runs on the same laptop.

## Over-the-air updates (experimental)

Off by default, and untested on hardware until both boards are stable. To try it, add to `secrets.h`:

```
#define CDO_OTA 1
#define OTA_PASSWORD "..."
```

An upload connects back to your PC, so Windows Firewall needs an inbound rule for the uploader, the laptop and board must be on the same subnet, and Wi-Fi client isolation must be off. A DHCP reservation for the board is more reliable than its `.local` name. While an OTA upload runs the board stops publishing, so the platform will briefly show it offline.

## Hardening that is already in the firmware

- Every network wait has a bound: TCP connect 5 s, TLS handshake 10 s, MQTT acknowledgement 5 s.
- The clock is set **before** TLS. A certificate is valid for a period, so a board that thinks it is 1970 fails the handshake with an error that looks like a network fault.
- A 60 s watchdog covers the loop, and a board that has not been running for 10 minutes restarts. The restart count survives in RTC memory and is reported in `diag`.
- PubSubClient's buffer is raised to 2048 bytes and the compiler checks the largest message fits. A publish that fails is counted, and five failures in a row force a reconnect.
- Telemetry and spectrum are built with `snprintf`, so numbers have exactly the channel's decimals and nothing allocates on the 2 Hz path.
- A command is queued by the MQTT callback and handled by the loop, because the callback shares one buffer with outgoing packets. Commands are de-duplicated by id and discarded when expired.
- The wait after a failure grows 1, 2, 4, 8, 16, 30, then 60 s, with jitter, and resets after a minute of stable running.

## Size

Compile-checked on the ESP32, ESP32-S3 and ESP32-C3, with and without TLS. Flash use against the default app partition (1,310,720 bytes):

| Build | Flash |
|---|---|
| ESP32, TLS, press or robot | 82% (1,077,458 and 1,075,930 bytes) |
| ESP32, no TLS | 80% |
| ESP32-S3 | 80% |
| ESP32-C3 | 87% |
| ESP32 with OTA and the insecure fallback enabled | 86% |

RAM use is about 16%. If a future change takes flash above 90%, the tool says so, and the fix is a larger app partition such as `min_spiffs`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ports` shows no ESP32 | Charge-only cable, missing driver (see the USB list `ports` prints), or the board is held in reset. |
| Upload says the port is busy or access is denied | A serial monitor is open. Close it. |
| Upload cannot connect | Hold BOOT while "Connecting" shows, or retry at a lower speed. |
| `wifi disconnect event, reason 201` | The network was not found: wrong name, or it is 5 GHz only. |
| `reason 202` or `15` | Wrong password or a security mode the board does not support. |
| `mqtt connect failed (state 4)` | Wrong broker username or password. State 5 means the credential lacks permission. |
| `tls error -9984` (`X509 - Certificate verification failed`) | The clock is wrong, or `root_ca.pem` does not anchor the chain. Redo the `openssl` check above. |
| `clock not set after 15 s` repeatedly | The network blocks UDP port 123 (NTP). Try a hotspot. |
| Telemetry arrives but the twin shows nothing | The channel is not bound to a mesh yet. See `docs/demo-binding-cheatsheet.md`. |
