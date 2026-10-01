---
name: cdo-esp32-workflow
description: Use when working on this project's ESP32 edge gateways: compiling, flashing, monitoring or debugging a board, bringing one up on a new network, or changing the MQTT contract, the channel catalog or the simulation models. Covers the human checkpoints, the safe commands, and how to read a board you cannot tether.
---

# ESP32 workflow for the Cognitive DataOps gateways

Two ESP32 boards play a welding robot (`robot-weld-01`) and a stamping press (`press-stamp-01`). They run the same sketch, `firmware/cdo-edge-gateway/`, and differ by one number in `machine_select.h`. The full guide is `firmware/README.md`. This file is the short version for an assistant.

## Hard rules

1. **Never read, print, copy or edit `firmware/**/secrets.h` or any `server/.env*` file.** They hold the user's Wi-Fi and broker credentials. Work from `secrets.example.h` and `server/.env.example`. `node scripts/fw.mjs doctor` reports which settings still hold a placeholder without printing a value. A hook (`scripts/hooks/guard-secrets.mjs`) enforces this for shell commands and file tools.
2. **Never create accounts or credentials.** The HiveMQ cluster and its users, and the filling of `secrets.h` and `server/.env`, are the user's manual step.
3. **Never pick a serial port.** Boards are identified by USB VID:PID, not COM number. Run `node scripts/fw.mjs ports`, show the user the port and its id, and **stop and ask them to confirm the port and the cable swap before every upload.**
4. **Never upload without naming the machine**: `--confirm-machine robot` or `press`. The tool refuses a mismatch, a stale build, a compile-check-only build and a `secrets.h` with `CHANGE_ME` values. Do not work around a refusal; fix the cause.
5. **Nothing is committed unless the user asks.** `machine_select.h` is tracked, so `select` shows up in `git status`.

## Commands

```bash
node scripts/fw.mjs doctor                        # toolchain, catalog, secrets placeholders, certificate
node scripts/fw.mjs ports                         # ports and USB devices, ESP32 bridges flagged
node scripts/fw.mjs select robot|press
node scripts/fw.mjs compile                       # no secrets.h needed; without one it is a compile check
node scripts/fw.mjs upload --port COM7 --confirm-machine press     # asks for permission
node scripts/fw.mjs monitor --port COM7 --seconds 40               # saves to firmware/.logs/
node scripts/fw.mjs log --lines 80                # read the newest monitor log
node scripts/fw.mjs selftest --port COM7 --confirm-overwrite       # parity check, asks for permission
node server/scripts/mqtt-tail.mjs --seconds 20 --only status,diag,ack,birth
mosquitto_sub -h 127.0.0.1 -t "cdo/v1/vit-lab/#" -v -W 10         # bounded: always exits
```

Run the monitor with a `--seconds` bound and read the log file back. Stop it before an upload: it holds the port. Use `mosquitto_sub` and `mqtt-tail` with a bound (`-W`, `--seconds`) so they exit.

## Bring-up order (one data cable, one charger)

1. `ports` with nothing attached: no ESP32 listed.
2. Attach board 1 by the data cable. `ports` again: a new line with a USB id. Confirm with the user.
3. `select robot`, `compile`, `upload`, `monitor`. Check the banner (machine, MAC, boot id), then the state going Wi-Fi, clock, MQTT, running. Confirm `online` on the broker.
4. `selftest` once. Then compile and upload the real firmware again.
5. Move board 1 to the charger. From here read `log` and `diag` over MQTT.
6. Board 2: `select press`, and repeat.

## Reading a board you cannot tether

- `cdo/v1/vit-lab/<machine>/log`: plain-text lines, state changes, Wi-Fi disconnect reasons, commands.
- `cdo/v1/vit-lab/<machine>/diag`: every 15 s, RSSI, heap, uptime, reset reason, reconnect counts, publish failures. A falling `heapMin` over 30 minutes is a leak.
- Commands over MQTT or the web UI: `ping` (answered on `ack`), `scenario`, `interval`, `reboot`.
- A retained `online` can be stale. `mqtt-tail` marks retained messages; a board is alive only if telemetry is arriving.

## Debugging playbook

| Symptom | Likely cause |
|---|---|
| No ESP32 in `ports` | Charge-only cable, missing driver (`ports` prints USB devices with an error status), board held in reset |
| Upload: port busy or access denied | A serial monitor is open |
| Upload cannot connect | Hold BOOT while "Connecting" shows, or retry at `UploadSpeed=115200` |
| `wifi disconnect event, reason 201` | Network not found: wrong name or 5 GHz only |
| reason `202` or `15` | Wrong password or unsupported security |
| `mqtt connect failed (state 4)` | Bad broker credentials. State 5: the credential lacks topic permission |
| `tls error -9984` | The clock is wrong, or `root_ca.pem` does not anchor the broker's chain |
| `clock not set after 15 s` repeating | UDP 123 blocked. Use a hotspot |
| Telemetry arrives, twin shows nothing | The channel is not bound to a mesh yet |
| Telemetry arrives but values look wrong | Run `selftest`; the C++ models may have drifted from the JavaScript ones |

## Changing the contract, the catalog or a model

The catalog `firmware/catalog.json` is the single source of truth. After editing it:

1. `node scripts/gen-catalog.mjs` regenerates `catalog.h` (compile does this too).
2. `npm test --workspace server`: the tests assert `catalog.h` is current, that the firmware's birth message equals the simulator's, and that the simulator's physics still meet the demo's thresholds.
3. If a channel's order or key changed, update the models in **both** `firmware/cdo-edge-gateway/simulation.h` and `server/scripts/lib/sim-models.mjs`. The sketch has `static_assert`s on channel order that fail the build if they disagree.
4. If a wire field changed, bump `v` and update `docs/mqtt-contract.md`, `server/src/validators/telemetry.validator.js`, the simulator and the firmware together.
5. Re-run `selftest` on a board to confirm the C++ and JavaScript models agree.

## Facts worth remembering

- PubSubClient publishes at QoS 0 only, and `publish()` silently fails when its buffer is too small. The buffer is 2048 bytes and the compiler checks every message fits.
- The command callback only queues; the loop handles and acknowledges. Never publish from inside the callback.
- A `cmdId` must match `[A-Za-z0-9-]{1,32}` or the backend rejects the ack.
- A commanded `reboot` publishes a retained `offline` first. A power cut relies on the Last Will, about 15 s later.
- Build output is under the system temp directory (short path) because the ESP32 toolchain overruns Windows' 260 character limit inside a deep repository path.
- The press build uses about 82 percent of the default app partition. Over 90 percent, switch to a larger partition scheme such as `min_spiffs`.
- Simulator ground truth (`diag.sim`) must never reach a general stream or any agent-facing endpoint.
