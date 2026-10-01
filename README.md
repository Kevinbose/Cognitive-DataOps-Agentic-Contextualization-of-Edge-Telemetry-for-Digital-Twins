# Cognitive DataOps

**Agentic Contextualization of Edge Telemetry for Digital Twins**

A web-native digital twin for a car plant. You upload a 3D model of the plant, connect machines to it, bind their live telemetry channels to parts of the model, and watch a welding robot and a stamping press stream into the twin in real time. Two ESP32 boards play those machines and publish over MQTT. A planned agentic layer will correlate the channels, retrieve the maintenance manual and point at the failing component in 3D.

> **Capstone project**, B.Tech CSE, VIT Chennai
> Kevin Bose J (23BCE5105), Joseph Shalom A (23BCE1078), Shubham Chattopadhyay (23BCE1671)

---

## Contents

1. [What it does](#what-it-does)
2. [Current status](#current-status)
3. [How the pieces fit](#how-the-pieces-fit)
4. [The client journey, step by step](#the-client-journey-step-by-step)
5. [Quick start](#quick-start)
6. [The ESP32 gateways](#the-esp32-gateways)
7. [What is general and what is specific to the two machines](#what-is-general-and-what-is-specific-to-the-two-machines)
8. [Repository layout](#repository-layout)
9. [Data model](#data-model) · [API reference](#api-reference) · [Worked example](#worked-example)
10. [Design decisions worth knowing](#design-decisions-worth-knowing)
11. [Safety rails](#safety-rails)
12. [Verification](#verification) · [Environment reference](#environment-reference) · [Troubleshooting](#troubleshooting)
13. [Documentation index](#documentation-index)

---

## What it does

| Area | What you get |
|---|---|
| **Asset pipeline** | Upload raw CAD (stored for provenance, never rendered) and a Blender-exported `.glb`. A status ratchet (awaiting mesh, renderable, instrumented) tracks each asset. |
| **Spatial mapping** | Click any part in the 3D viewer, or pick it from a filterable list of every named mesh (about 800 to 1,200 per model), and bind a sensor to it. One sensor drives one mesh and one mesh has one sensor, enforced by the database. Retired bindings stay as history. |
| **Machines** | A gateway announces itself and appears as *available*. Adding it to a twin is a deliberate step; removing it retires the bindings of its channels. A machine belongs to one twin at a time. |
| **Live telemetry** | Values at 2 Hz with trend lines and normal, warning and alarm states derived from limits the machine declares. A 64-bin vibration spectrum for the press, with its shaft harmonics marked. |
| **3D feedback** | A bound mesh flashes green when bound, tints amber on a warning and pulses red on an alarm. Selecting a bound channel focuses the camera on its mesh. |
| **Fault injection** | Scenario buttons (clogged lube filter, bearing wear, gearbox wear) command the machine over MQTT with no cable, with the acknowledgement round trip shown. |
| **Edge firmware** | One Arduino sketch for both boards. Connection state machine, TLS or plain MQTT, Last Will, remote logging, command handling, watchdog, and a self-test that proves the C++ models equal the JavaScript ones. |
| **Software simulator** | Impersonates both boards with the same wire contract, for development without hardware and as demo insurance. |
| **Tooling** | `fw.mjs` for ports, compile, upload, monitor and self-test with safety checks; a catalog generator; a demo seed; UI and contrast audits. |
| **Documentation** | Wire contract, agent blueprint, runbooks, demo script, thesis narrative, data-model diagram. |

---

## Current status

| Phase | Scope | State |
|---|---|---|
| 1. Asset pipeline | CAD and GLB ingestion, provenance, conversion state machine | Done |
| 2. Spatial mapping | Mesh-node registry, sensor bindings, twin-scene API, R3F viewer with click to bind | Done |
| 3. Edge telemetry | MQTT contract, ingestion service, MongoDB time series, Socket.io, simulator, ESP32 firmware | Done. **Both boards are flashed and publishing to a local Mosquitto broker**, checked on the wire (birth, status, 2 Hz telemetry, spectrum, diagnostics, no reconnects). |
| 4. Live twin | Machines tab, live values and spectrum, channel-aware binding form, bind flash, alarm tints, fault injection | Done |
| 5. Agentic layer | LangGraph diagnosis agent with spatial grounding | Blueprint only: [`docs/phase5-agent-blueprint.md`](docs/phase5-agent-blueprint.md) |
| UI | A full redesign ("UI v3") of every screen, plus terms and privacy pages | Done: [`DESIGN.md`](DESIGN.md) |

Still to do by hand: a rehearsal of [`docs/demo-script.md`](docs/demo-script.md) on the real boards, the on-chip self-test (`node scripts/fw.mjs selftest`), and filling in the institution name and contact on the legal pages.

---

## How the pieces fit

```
ESP32 gateway (robot)  \                                         +--> React twin (R3F, Redux)
                        >--> MQTT broker --> Node service -------+      machines, live values, spectrum,
ESP32 gateway (press)  /   (Mosquitto or     validate, store,           binding, 3D highlights
                            HiveMQ Cloud)    broadcast
                                                |
                                                +--> MongoDB: assets, mesh nodes, bindings,
                                                     devices, time-series readings and spectra
```

Plants rarely bolt sensors onto a machine. A welding robot or a stamping press already computes its own torque, path deviation, motor current and lubrication pressure, and a gateway publishes that state onto an MQTT backbone organised as a Unified Namespace (`cdo/v1/{site}/{machine}/{topic}`). The two ESP32 boards play that gateway role, each simulating one machine's controller. The browser never talks to the broker: every sample goes through the Node service, which validates it and resolves which mesh it drives.

Details: [`docs/mqtt-contract.md`](docs/mqtt-contract.md) (the wire format), [`firmware/README.md`](firmware/README.md) (the boards), [`docs/phase5-agent-blueprint.md`](docs/phase5-agent-blueprint.md) (the agent).

---

## The client journey, step by step

This is the path a new client follows from a fresh model to a live, bound twin.

1. **Create the twin.** Registry, **Ingest asset**: give it a name and upload the CAD file, then upload the converted `.glb` from the asset record. The asset becomes *Renderable*.
2. **Open the twin.** **Open twin** loads the 3D model. A twin with no machine opens on the **Machines** tab.
3. **Connect the machines.** Power the ESP32 gateways (or start the simulator). Each one announces itself and appears under **Available to add**. Choose **Add to this twin**. It moves under **On this twin**, and the machine strip above the viewport lists it with its state, signal strength and last-seen time.
4. **See what it publishes.** The **Telemetry** tab lists the channels of each added machine: a live value in the channel's own decimals, a status marker, a trend line, and the sensor id. The press also shows a vibration spectrum.
5. **Bind a channel to a component.** On a channel row choose **Bind**, click a part in the 3D view (or pick it from the **Components** list), check the sensor type, type a display label and choose **Bind sensor**. The mesh flashes green and a status message confirms it. Reload the page: the binding persists.
6. **Watch it react.** Bound channels tint their mesh by state. With device commands enabled, the **Faults** tab injects a clogged filter or bearing wear: pressure falls, vibration rises, markers change shape, meshes tint amber then pulse red.
7. **Take a machine off.** **Remove** on the Machines tab asks first, then retires the bindings of that machine's channels. Nothing is deleted: the rows stay as history.

Suggested meshes for the six channels of the demo, and how to record and replay them after a database reset, are in [`docs/demo-binding-cheatsheet.md`](docs/demo-binding-cheatsheet.md). `car_factory.glb` contains a six-axis welding robot, a spot weld gun and a stamping press, so the strongest bindings use those parts.

---

## Quick start

**Prerequisites:** Node.js 22 or later, a MongoDB instance (see [Database](#database)), and an MQTT broker if you want live telemetry (Mosquitto is enough).

```bash
git clone https://github.com/Kevinbose/Cognitive-DataOps-Agentic-Contextualization-of-Edge-Telemetry-for-Digital-Twins.git
cd Cognitive-DataOps-Agentic-Contextualization-of-Edge-Telemetry-for-Digital-Twins
npm install
```

Create the server's settings from the template. On macOS or Linux `cp server/.env.example server/.env`; in Windows PowerShell `Copy-Item server\.env.example server\.env`. The file is gitignored; the template is the committed contract. Set at least:

```
MONGODB_URI=mongodb://127.0.0.1:27017/cognitive_dataops
MQTT_URL=mqtt://127.0.0.1:1883
ENABLE_DEVICE_COMMANDS=true        # optional: turns on the Faults tab
```

Start everything:

```bash
npm run dev
```

This starts the API on <http://127.0.0.1:5000> and the client on <http://localhost:5173>. Check the API:

```bash
curl http://127.0.0.1:5000/api/v1/health
```

You want `"database":"connected"` and, with `MQTT_URL` set, an `ingestion.mqtt.state` of `connected`. Without `MQTT_URL`, telemetry ingestion is off and the app is the asset and mapping tool of Phases 1 and 2. Restart `npm run dev` after any change to the settings file: it is read once at startup.

### Live telemetry without any hardware

Run any MQTT broker on your machine (Mosquitto on its default loopback listener is enough), then in another terminal:

```bash
npm run simulate --workspace server       # both machines, scenario NORMAL
```

The simulator speaks the exact wire contract the boards do, so the service cannot tell the difference. Variations:

```bash
node server/scripts/simulate-devices.mjs --machines press-stamp-01 --scenario CLOGGED_FILTER --ramp 90
node server/scripts/simulate-devices.mjs --speed 10      # faults develop ten times faster
node server/scripts/mqtt-tail.mjs --seconds 30           # watch the broker traffic, formatted
```

Never run the simulator and the real boards at the same time: the same machine id announcing from two devices is flagged as an identity conflict.

### The demo database

```bash
npm run seed:demo --workspace server                      # dry run: shows what it would change
npm run seed:demo --workspace server -- --capture         # record the current bindings into docs/demo-bindings.json
npm run seed:demo --workspace server -- --apply --bindings  # replay them, and put the machines back on the twin
```

The seed renames the car factory asset to drop an em dash, refuses to run against any database except `cognitive_dataops` or `cdo_test_*`, and never touches the machine shop asset.

### Database

A **MongoDB Atlas free-tier (M0)** cluster is the recommended shared setup: nothing to install, and Atlas is a replica set, so multi-document **transactions work**. A local standalone `mongod` also works but cannot run transactions. The binding flow detects this at boot and falls back to sequential writes with a loud warning. The difference is only what happens if the process dies halfway through a rebind.

Telemetry lives in MongoDB time-series collections (`telemetry_readings`, `telemetry_spectra`) with a TTL of 48 hours by default. If a deployment cannot create a time-series collection, the service falls back to a plain collection with a TTL index and reports the mode in `/health`.

---

## The ESP32 gateways

Two ESP32 boards run one sketch, `firmware/cdo-edge-gateway/`. One number in `machine_select.h` (`1` robot, `2` press) is the only difference. Each board:

- joins Wi-Fi (up to three networks, strongest first), sets its clock over SNTP **before** any TLS connection, then connects to the broker with a Last Will so the platform learns within about 15 seconds if it drops off;
- publishes a retained **birth** (its channels, units, ranges and alarm limits), a retained **status**, **telemetry** every 500 ms, a 64-bin **spectrum** every 2 s (press only), **diagnostics** every 15 s and remote **log** lines;
- accepts commands (`scenario`, `interval`, `reboot`, `ping`) and answers each with an `ack`;
- recovers on its own: bounded timeouts everywhere, backoff of 1, 2, 4, 8, 16, 30 and then 60 s with jitter, a 60 s task watchdog, and a restart if it has not been running for ten minutes.

The values come from simulated machine models, C++ ports of the JavaScript ones. `node scripts/fw.mjs selftest` runs both on the chip and compares them to 12 significant digits.

**Setup in short** (the full guide, with the certificate steps for HiveMQ Cloud and the local broker option, is [`firmware/README.md`](firmware/README.md)):

1. Copy `firmware/cdo-edge-gateway/secrets.example.h` to `secrets.h` (gitignored) and fill in your Wi-Fi, the broker host and port, and `CDO_TLS` (`1` for a TLS broker such as HiveMQ Cloud, `0` for a plain local Mosquitto).
2. For a local Mosquitto, let the boards reach it: add `listener 1883 0.0.0.0` and `allow_anonymous true` (or a password file) to `mosquitto.conf`, restart it, and open TCP 1883 in Windows Firewall. The laptop and the boards must be on the same 2.4 GHz network.
3. `node scripts/fw.mjs doctor`, `select robot|press`, `compile`, `upload --port COMx --confirm-machine …`, `monitor --port COMx`. Or open `firmware/cdo-edge-gateway` in the Arduino IDE.
4. Check the wire with `node server/scripts/mqtt-tail.mjs`.

Compile-checked on the ESP32, ESP32-S3 and ESP32-C3, with and without TLS (80 to 87 percent of flash).

---

## What is general and what is specific to the two machines

**General (nothing is hardcoded to the two machines):**

- *Discovery.* The backend subscribes to `cdo/v1/{site}/+/…`. Any gateway that publishes a valid birth shows up under **Available to add**. The machine id, label, type, channels, units, decimals, ranges, limits, scenarios and spectrum layout all come from that birth message.
- *The Telemetry tab.* Rows, units, decimals, status markers and trend scaling are drawn from the declared channels; the spectrum plot appears only when a spectrum layout is declared, with ticks at the declared fundamental frequency.
- *Binding.* Any channel of an added machine can be bound to any mesh of the model.

**Specific to these two machines:** only the ESP32 side. `firmware/catalog.json` and the simulation models define the welding robot and the stamping press and generate their fake values. A third machine needs a valid birth message (a lowercase kebab-case id, a sensor type from the allowed list: temperature, vibration, rpm, pressure, current, torque, displacement, generic) and nothing else.

---

## Repository layout

```
/
|-- server/                  Express + Mongoose API (strict MVC) and the telemetry pipeline
|   |-- src/
|   |   |-- config/          env, database, storage layout
|   |   |-- models/          Asset, MeshNode, SensorBinding, Device, telemetry time series
|   |   |-- services/        ALL business logic: assets, bindings, devices, mqtt, telemetry, websocket
|   |   |-- controllers/     thin: extract, delegate, respond
|   |   |-- routes/          mounted under /api/v1
|   |   |-- middleware/      upload, validate, origin check, error handling
|   |   |-- validators/      Zod schemas, including every MQTT payload
|   |   `-- utils/           ApiResponse, ApiError, transaction, lifecycle, domain events
|   |-- scripts/             simulator, mqtt-tail, seed-demo
|   `-- test/                server tests (node:test)
|-- client/                  React + Vite + React Three Fiber
|   |-- src/features/        assets, mapping, twin-viewer, telemetry, legal
|   `-- test/                client tests
|-- firmware/                ESP32 sketch, catalog.json, firmware README
|-- scripts/                 fw.mjs, gen-catalog.mjs, audit-ui.mjs, check-contrast.mjs, hooks/
|-- docs/                    MQTT contract, demo cheat sheet and script, thesis narrative,
|                            agent blueprint, runbooks, data model diagram
|-- .claude/                 project settings (permissions, secrets guard hook) and the ESP32 skill
|-- CLAUDE.md                guide for AI coding assistants working in this repo
|-- DESIGN.md                the design system
|-- storage/assets/          local "S3-mimic" bucket (gitignored)
|-- Joe_Samples/             sample CAD and GLB assets
`-- Shu_Research/            early R&D spike, reference only
```

### Layering rule

```
Route -> Validator -> Controller -> Service -> Model
                                       |
                                storage.service  (the only module doing file I/O)
```

A controller that contains an `if` statement, a query or a `try/catch` has business logic in the wrong file. Services never touch `req` or `res`; controllers never touch Mongoose. The MQTT transport (`mqtt.service.js`) only moves bytes: parsing, validation, status and storage live in `telemetry.service.js`.

---

## Safety rails

- **Secrets.** `secrets.h` and `server/.env` are gitignored. A project hook (`scripts/hooks/guard-secrets.mjs`) and deny rules stop AI coding assistants from reading or editing them.
- **Uploads.** `fw.mjs` identifies boards by USB vendor and product id, never by COM number, and refuses an upload without `--confirm-machine`, with a stale or compile-check-only build, or with a `secrets.h` that still has placeholders.
- **Databases.** Tests and the seed script refuse any database except `cognitive_dataops` or `cdo_test_*`.
- **Commands.** Device commands are off unless `ENABLE_DEVICE_COMMANDS=true`, rate-limited, and refused from a foreign browser origin.
- **Ground truth.** The simulator's active fault never reaches a general stream or a future agent endpoint.
- **Network.** The API binds to loopback by default; there is no user authentication yet.

---

## Data model

![Data model and data flow: the six collections, how they join, and where telemetry enters](docs/er-diagram.svg)

A PNG of the same diagram, for slides, is in [`docs/er-diagram.png`](docs/er-diagram.png).

### `Asset`: one industrial asset and its two file artefacts

| Field | Purpose |
|---|---|
| `originalFile` | Raw CAD (`.stp`, `.step`, `.iges`). **Provenance and audit only**: never parsed, never sent to a browser. |
| `convertedFile` | Web-ready `.glb`, exported manually from Blender. The only artefact React Three Fiber loads. |
| `status` | `pending_conversion`, `converted`, `mapped` (and `failed`) |
| `version` | Bumped when the `.glb` is replaced; drives the `?v=` cache-buster |

**Status is a one-directional ratchet.** Unbinding the last sensor does not demote `mapped` to `converted`, because `mapped` records that the asset has been through the mapping workflow.

### `MeshNode`: an instrumentable sub-part

Created **on demand**, never bulk-imported. The sample assets declare 811 to 1,203 glTF nodes each, with machine-generated names such as `000-tool-hire-depot-and-plant-yard-yard-ground-tile/0`. The browser discovers names by traversing the loaded scene graph, and a row is written only when a sensor is bound.

`meshName` is stored **verbatim**: trimmed, never lowercased or slugified. It is the join key for `scene.getObjectByName()`, so any normalisation would silently break the 3D highlight.

### `SensorBinding`: the sensor to mesh link

A **separate collection**, for two reasons:

1. **Ingestion queries from the sensor side.** "A reading arrived for `PRESS-STAMP-01.LUBE_OIL_PRESSURE`: which mesh does it drive?" The service keeps an in-memory index built from this collection and refreshed on every binding change.
2. **Rebind history is free.** Moving a sensor closes the old row (`isActive: false`, `unboundAt` stamped) and inserts a new one.

Two **partial unique indexes** enforce the invariants in the database, where application code would race:

```js
{ sensorId:   1 }  unique, where { isActive: true }   // a sensor drives at most one mesh
{ meshNodeId: 1 }  unique, where { isActive: true }   // a mesh has at most one sensor
```

A sensor id is `MACHINE-ID.CHANNEL_KEY` in upper case, for example `PRESS-STAMP-01.LUBE_OIL_PRESSURE`.

### Devices and telemetry

`Device` is the registry of gateways, rebuilt from the retained `birth` and `status` messages and persisted. Its `assetId` is the twin the machine was added to (`null` while it is only discovered); deleting a twin sets it back to `null`. `TelemetryReading` and `TelemetrySpectrum` are time-series collections, one reading per channel per second. The simulator's ground truth (`diag.sim`) is kept server-side and never reaches a general stream or an agent-facing endpoint.

---

## API reference

All routes are under `/api/v1`. Every response uses one envelope:

```jsonc
// success
{ "success": true,  "data": { }, "message": "...", "meta": { } }
// failure
{ "success": false, "data": null, "message": "...", "errors": [ { "field": "...", "message": "..." } ] }
```

### Assets

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/assets` | Create an asset; optionally upload the CAD file in the same multipart request |
| `GET` | `/assets` | List, with `?status=&search=&page=&limit=` |
| `GET` | `/assets/:assetId` | Metadata |
| `PATCH` | `/assets/:assetId` | Edit `name`, `notes`, `units`, `partCount` |
| `DELETE` | `/assets/:assetId` | Soft delete, cascading to mesh nodes and bindings |
| `POST` | `/assets/:assetId/original-file` | Attach or replace the CAD file (field `originalFile`) |
| `POST` | `/assets/:assetId/converted-file` | Attach or replace the `.glb` (field `convertedFile`); promotes to `converted` |
| `GET` | `/assets/:assetId/original-file` | Download the CAD file |
| `GET` | `/assets/:assetId/converted-file` | Download the `.glb` |
| `GET` | **`/assets/:assetId/scene`** | **Aggregated twin scene**: asset, `modelUrl`, and every mesh node with its active binding joined |

### Mesh nodes and bindings

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/assets/:assetId/mesh-nodes` | List registered nodes; `?mappedOnly=true` |
| `POST` | `/assets/:assetId/mesh-nodes` | Register a node without binding |
| `PUT` | **`/assets/:assetId/mesh-nodes/by-name/:meshName/sensor-binding`** | **Save a mapping** (idempotent) |
| `PATCH` | `/mesh-nodes/:meshNodeId` | Edit `displayName`, `nodePath` |
| `DELETE` | `/mesh-nodes/:meshNodeId` | Soft delete and unbind |
| `GET` | `/assets/:assetId/sensor-bindings` | List bindings; `?includeInactive=true` for history |
| `DELETE` | `/sensor-bindings/:bindingId` | Retire a binding |

### Devices and telemetry

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/devices` | Registry: state, catalog, latest diagnostics (never the simulator truth) |
| `GET` | `/assets/:assetId/machines` | The machines added to this twin |
| `POST` | `/assets/:assetId/machines` | `{machineId}`: add a machine that has announced itself. 201 when added, 200 if already there, 404 if it never announced, 409 if it belongs to another twin |
| `DELETE` | `/assets/:assetId/machines/:machineId` | Take it off the twin and retire the bindings of its channels |
| `POST` | `/devices/:machineId/commands` | `{name, args}`: `scenario`, `interval`, `reboot`, `ping`. Returns 202 with a `cmdId`. Off unless `ENABLE_DEVICE_COMMANDS=true` |
| `GET` | `/devices/:machineId/sim` | Simulator ground truth, for the fault-injection panel and the evaluation harness only |
| `GET` | `/telemetry/latest` | Newest value per channel |
| `GET` | `/telemetry/history` | `?sensorId=&from=&to=&bucketSec=&maxPoints=`: bucketed min, average and max |
| `GET` | `/telemetry/spectrum/latest` | `?machineId=`: the most recent spectrum frame |
| `GET` | `/meta` | Sensor types and object types, so the client does not duplicate the enums |
| `GET` | `/health` | Liveness, database, MQTT state, ingestion counters, time-series mode |

The command endpoint answers 403 when disabled, 404 for an unknown device, 409 when the device is not online, 422 for a scenario it does not support, 429 when called more than once every 2 s per device, and 503 when the broker is down. A foreign browser `Origin` is refused.

### Realtime (Socket.io)

| Event | Direction | Payload |
|---|---|---|
| `snapshot` | server to client, on connect | Latest value per channel and every device's state |
| `telemetry:batch` | server to client | Samples with value, unit, status and the bound mesh |
| `spectrum:frame` | server to client | `{machineId, key, ts, amp[]}` |
| `device:update` | server to client | Device state and diagnostics (no ground truth) |
| `device:ack` | server to client | The device's answer to a command |
| `twin:invalidate` | server to client | `{assetId}`, after any binding change |
| `subscribe:asset`, `unsubscribe:asset` | client to server | Join or leave an asset's room |

The server rejects a browser `Origin` that is not in `CORS_ORIGINS`, and high-rate events are volatile so a slow tab never builds a backlog.

### Serving meshes

`.glb` files are served by `express.static` at `/static/assets/<assetId>/converted.glb`, not through a controller, so range requests, ETags and conditional GETs work. The `scene` endpoint returns the URL with a cache-buster (`?v=1`); without it, drei's `useGLTF` would keep rendering stale geometry after a re-upload.

---

## Worked example

```bash
API=http://127.0.0.1:5000/api/v1

# 1. Create an asset with its source CAD file
curl -s -X POST $API/assets \
  -F "name=Car Factory, Assembly Hall" \
  -F "uploader=Kevin Bose J" \
  -F "sourceType=stp" \
  -F "originalFile=@Joe_Samples/MWP001-roller conveyors.stp"
# 201, status: "pending_conversion"

# 2. Upload the Blender-converted mesh
ASSET_ID=<id from step 1>
curl -s -X POST $API/assets/$ASSET_ID/converted-file \
  -F "convertedFile=@Joe_Samples/car_factory.glb"
# 200, status: "converted", isRenderable: true

# 3. Bind a telemetry channel to a mesh (the name must be percent-encoded)
MESH=$(python -c "import urllib.parse;print(urllib.parse.quote('000-floor-tile-plain0', safe=''))")
curl -s -X PUT $API/assets/$ASSET_ID/mesh-nodes/by-name/$MESH/sensor-binding \
  -H "Content-Type: application/json" \
  -d '{"sensorId":"press-stamp-01.lube_oil_pressure","sensorType":"pressure","displayName":"Lubrication unit"}'
# 200, status promoted to "mapped", sensorId stored as PRESS-STAMP-01.LUBE_OIL_PRESSURE

# 4. Read the scene back
curl -s $API/assets/$ASSET_ID/scene
```

> **Percent-encode `:meshName`.** Real glTF names contain slashes. Use `encodeURIComponent(meshName)` from the browser.

---

## Design decisions worth knowing

**`.stp` is never rendered.** WebGL cannot draw parametric CAD geometry. Raw CAD is stored so the twin has an auditable source; only the Blender-exported `.glb` reaches a browser.

**GLB uploads are verified by magic bytes.** Extension and MIME checks are trivially spoofed. The storage service reads the first four bytes and requires ASCII `glTF`.

**Uploads are staged before they are accepted.** Multer writes to `storage/.tmp-uploads` under a random filename, never the client's. Only after validation is the file moved into the bucket.

**Reusing a live sensor is refused by default.** Binding a sensor to a second mesh returns `409` with an actionable message, instead of silently relocating it. Pass `"reassign": true` to move it.

**Telemetry never enters the RTK Query cache.** Live values live in their own slice, batched at 4 Hz. Putting them inside the mesh-node objects would change those objects on every tick and wipe what an operator is typing into the binding form.

**You choose the mesh for each channel.** `car_factory.glb` does contain a six-axis welding robot, a spot weld gun and a stamping press (see `docs/demo-binding-cheatsheet.md` for their node names), but it has no lubrication unit, motor or bearing housing, so some bindings stand for a part by convention and a label. The twin never searches the model: you pick the mesh and label it. A different model can replace this one later, and re-making six bindings takes minutes because nothing in the telemetry layer depends on mesh names.

**The firmware and the simulator cannot drift.** `firmware/catalog.json` is the single source for channels and limits. A script generates the firmware header from it, a test checks the birth message the firmware would send equals the simulator's, and a self-test compares the C++ models with the JavaScript ones on the chip.

**Storage keys, not paths.** Every layer above `storage.service.js` deals in bucket-relative keys. Swapping the filesystem for S3 is a one-file change.

---

## Verification

```bash
npm test                      # server and client
node scripts/audit-ui.mjs     # design rules over the client sources
node scripts/check-contrast.mjs   # WCAG contrast of every design token pair
npm run build --workspace client
```

| Suite | Tests | What it covers |
|---|---|---|
| Server | 270 | Topic parsing, payload validation, device status, buffers and shutdown, ingestion end to end against an in-process broker and a disposable `cdo_test_*` database, adding and removing machines (including retiring their bindings and surviving a restart), bindings and the domain events that keep caches honest, the simulator's physics, the firmware catalog and birth messages, the firmware wire formats, the self-test and the upload safety rails, the secrets guard hook, the demo seed |
| Client | 50 | The highlight compositor, the telemetry slice, number formatting |

Integration tests refuse to touch any database whose name does not start with `cdo_test_`.

Manual smoke sequence for the asset pipeline:

1. `npm run dev`, then `/api/v1/health` reports `connected`.
2. `POST /assets` with a `.stp` gives `pending_conversion`, and the file lands in `storage/assets/<id>/`.
3. `POST /assets/:id/converted-file` with a `.glb` gives `converted`, `isRenderable: true`.
4. `PUT .../sensor-binding` gives `200` and the asset becomes `mapped`.
5. `GET /assets/:id/scene` shows the binding, read back from MongoDB.
6. Repeating step 4 unchanged returns `"unchanged": true`.
7. Binding the same sensor to a different mesh returns `409` naming the conflict.

### Known gaps

- The **transactional** rebind path has only run against a standalone MongoDB, which takes the documented non-transactional fallback. Re-run the sequence against Atlas or a local replica set to cover the transaction branch: the boot log should not print the standalone warning.
- Atlas time-series creation, `collMod` and the duplicate index declarations on `SensorBinding` have been checked on a local MongoDB 8 only.
- The two boards run and publish correctly (checked on the broker), but the on-chip parity self-test (`node scripts/fw.mjs selftest`) has not been run yet, and the Last Will has been rehearsed against the simulator and in tests, not by pulling a board's power. No host C++ compiler exists on the development machine, so the C++ models are only verified on a board.
- The boards have been run against a local Mosquitto over plain MQTT. The TLS path (HiveMQ Cloud, certificate bundle) is written and compile-checked but has not been exercised.

---

## Environment reference

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Runtime mode |
| `PORT` | `5000` | API port |
| `HOST` | `127.0.0.1` | Bind address. There is no authentication yet, so keep it on loopback unless the network is trusted |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/cognitive_dataops` | Connection string |
| `STORAGE_ROOT` | `storage` | Bucket root (relative paths resolve from the repo root) |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Allow-listed browser origins, for REST and Socket.io |
| `MAX_CAD_UPLOAD_MB` | `25` | CAD ceiling (largest sample: 19.85 MB) |
| `MAX_GLB_UPLOAD_MB` | `50` | GLB ceiling (largest sample: 7.92 MB) |
| `MQTT_URL` | unset | Broker URL, without credentials. Ingestion starts only when set |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | unset | Broker credentials |
| `MQTT_SITE_ID` | `vit-lab` | Site segment of every topic |
| `TELEMETRY_PERSIST` | `true` | Write samples to MongoDB |
| `TELEMETRY_PERSIST_HZ` | `1` | Stored samples per channel per second |
| `TELEMETRY_RETENTION_HOURS` | `48` | TTL of stored telemetry |
| `TELEMETRY_EMIT_HZ_MAX` | `10` | Most websocket batches per second to browsers |
| `TELEMETRY_BUFFER_MAX` | `20000` | Documents held in memory while MongoDB is slow; the oldest are dropped first |
| `ENABLE_DEVICE_COMMANDS` | `false` | Allow fault injection and reboot commands |
| `COMMAND_MIN_INTERVAL_MS` | `2000` | Gap between commands to one device |

Two single-writer rules: only one backend per database may run with `TELEMETRY_PERSIST=true` (a time-series collection cannot reject duplicates), and only one backend at a time should subscribe to a cloud broker (several would use up the free plan's monthly quota). Teammates use a local Mosquitto and the simulator.

## Sample assets

| File | Size | glTF nodes | Note |
|---|---|---|---|
| `car_factory.glb` | 2.64 MB | 1,031 | **The demo twin.** Contains two six-axis welding robots, a spot weld gun and a stamping press |
| `tool_and_plant_hire_depot.glb` | 2.78 MB | 811 | Fewest nodes, smallest payload |
| `machine_shop.glb` | 7.92 MB | 1,203 | A stress test, not used in the demo |
| `mwp001-layout.stp` | 19.85 MB | | Largest CAD file; sets the 25 MB upload ceiling |
| `MWP001-roller conveyors.stp` | 6.20 MB | | Smaller CAD sample |

None of these use clean `Motor_M001` naming; they are asset packs with machine-generated names. Use `MeshNode.displayName` to give mapped parts readable labels while leaving `meshName` untouched.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `npm run dev` fails on the database | MongoDB is not running, or `MONGODB_URI` is wrong |
| `/health` shows MQTT not connected | Mosquitto is not running, or `MQTT_URL` is missing or wrong. Restart `npm run dev` after editing the settings file |
| The Machines tab is empty | No gateway has announced itself: power a board, or start the simulator. Check with `node server/scripts/mqtt-tail.mjs` |
| A board joins Wi-Fi but never reaches MQTT | The broker only listens on loopback, or the firewall blocks TCP 1883. See [The ESP32 gateways](#the-esp32-gateways) |
| Telemetry tab says "No machines on this twin" | Add the machine on the Machines tab first |
| No Faults tab | Set `ENABLE_DEVICE_COMMANDS=true` and restart the API |
| Bind refused with a conflict | The channel is already bound to another mesh. Unbind it, or use **Reassign** |
| Two boards flagged as sharing one machine id | The simulator and a real board are both running, or two boards have the same `MACHINE_TYPE` |
| Upload refused by `fw.mjs` | Read the reasons it prints: wrong machine, stale build, placeholder secrets, or a port that is not an ESP32 |

---

## Documentation index

| Document | Contents |
|---|---|
| [`docs/mqtt-contract.md`](docs/mqtt-contract.md) | Topics, payloads, QoS, commands, fault physics and thresholds |
| [`firmware/README.md`](firmware/README.md) | Boards, bring-up with one data cable, certificates, local broker, troubleshooting |
| [`docs/demo-binding-cheatsheet.md`](docs/demo-binding-cheatsheet.md) | Adding machines, the six bindings, suggested meshes, record and replay |
| [`docs/demo-script.md`](docs/demo-script.md) | A ten-minute demo and likely panel questions |
| [`docs/thesis-narrative.md`](docs/thesis-narrative.md) | The 300-word narrative for the review panel |
| [`docs/phase5-agent-blueprint.md`](docs/phase5-agent-blueprint.md) | The planned diagnosis agent, sequence diagram, evaluation protocol |
| [`docs/runbooks/`](docs/runbooks/) | Original maintenance runbook stubs the agent will cite |
| [`docs/er-diagram.svg`](docs/er-diagram.svg) | Data model and data flow |
| [`DESIGN.md`](DESIGN.md) | The design system and the rules the UI audit enforces |
| [`CLAUDE.md`](CLAUDE.md) | Conventions and rules for AI coding assistants |

---

## Tech stack

**Backend** Node.js 22 · Express 5 · MongoDB and Mongoose 8 (time series) · MQTT.js · Socket.io · Multer 2 · Zod · Helmet
**Frontend** React 19 · Vite · React Three Fiber and drei · Redux Toolkit and RTK Query · Tailwind CSS · Phosphor icons · Archivo and IBM Plex, self-hosted
**Edge** ESP32 · Arduino core 3.3 · PubSubClient · MQTT over TLS (HiveMQ Cloud) or a local Mosquitto
**Planned** LangGraph · retrieval over maintenance runbooks

## Legal

The client serves `/terms` and `/privacy`. They state facts about this academic prototype and invent no legal entity. The institution name and a contact address are left for the team to fill in.
