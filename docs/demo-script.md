# Demo script

About ten minutes. It works the same with the two ESP32 boards or with the software simulator, and the differences are called out. Rehearse it once end to end before the panel: the timings below come from the simulator's physics, and the boards are meant to match it.

## Before anyone arrives

| Check | How | You should see |
|---|---|---|
| API up, broker connected | `curl http://127.0.0.1:5000/api/v1/health` | `ingestion.mqtt.state` is `connected` |
| Commands enabled | `ENABLE_DEVICE_COMMANDS=true` in `server/.env`, API restarted | A **Faults** tab in the viewer's left panel |
| Both machines online | `node server/scripts/mqtt-tail.mjs --seconds 10 --only status,birth` | `online` for `robot-weld-01` and `press-stamp-01` |
| Twin ready | Registry, open **Car Factory, Assembly Hall**, **Open twin** | The model loads, the connection chip says **Live data** |
| Bindings in place | `npm run seed:demo --workspace server -- --apply --bindings`, or leave them for the live step | Six bound components, or none |
| Machines in NORMAL | Faults tab | **Device reports: Normal** for both |

**Boards or simulator, never both at once.** The same machine id announcing from two devices is flagged as an identity conflict. Pick one source. For the simulator, run `npm run simulate --workspace server` against a local broker and point the API at it.

**One backend only.** Only one backend should subscribe to the cloud broker, and only one per database should persist telemetry.

Reload the twin once after any reseed: a running API refreshes its binding index within 30 seconds, and a fresh page makes it immediate.

## The run

### 1. The story (30 s)

*Say:* a plant's machines already compute their own state. A gateway publishes it to a broker, and everything else subscribes. The two boards here are those gateways, one for a welding robot and one for a stamping press. This platform turns that stream into a twin an operator can query.

### 2. The asset (45 s)

*Do:* Registry, open the asset record. *Point out:* the raw CAD is stored for provenance and never rendered, the web mesh is what the browser loads, and the status ratchet (awaiting mesh, renderable, instrumented).

### 3. Live data (1 min)

*Do:* open the twin. It opens on **Machines**, where both gateways are listed as available. Choose **Add to this twin** for each, as a client would when connecting equipment to a new twin. The device strip then shows both machines online with their signal strength. Open the **Telemetry** tab: six channels update twice a second, each with a trend line and a status marker.

*Point out:* the press has a vibration spectrum below its channels, with ticks at the motor shaft's harmonics. Say what it is: the same vibration as the number above it, seen by frequency.

### 4. Binding (1 min 30 s)

If the bindings were not seeded:

*Do:* on **Lube oil pressure**, choose **Bind**. Click a mesh in the viewport. Set the label to "Lubrication unit" and choose **Bind sensor**.

*Expect:* the mesh flashes green for about a second and a half, and a status message confirms it. Reload the page: the binding persists.

*Optional:* try to bind the same channel to a second mesh. The form refuses with a plain explanation and offers **Reassign**. That is the one-sensor-per-mesh rule, enforced by the database.

*Say:* the binding table is the bridge between a raw signal and a physical part. The telemetry layer does not know mesh names, which is why a different model needs only six new bindings.

### 5. A fault with no cable (2 min)

*Do:* **Faults** tab, press, **Clogged filter**, ramp **1 minute**. Within a moment the panel reports **Acknowledged in** and the round trip in milliseconds.

*Expect*, in order:

| About | What you see |
|---|---|
| 20 s | Vibration peaks start crossing the warning level; the spectrum grows a broadband floor above 300 Hz with no discrete peaks |
| 27 s | Lube oil pressure drops under 3.6 bar: its marker becomes a triangle, the bound mesh tints amber |
| 45 s | Pressure under 3.0 bar and vibration over 4.0 mm/s: markers become squares, the meshes pulse red, a status message is announced |

*Say:* pressure falls because the transducer sits downstream of the filter. The vibration rises because a starved bearing loses its oil film. State is carried by shape and wording as well as colour.

*Do:* choose **Normal** to reset, and wait for the values to settle.

### 6. The case an alarm misses (1 min 30 s)

*Do:* press, **Bearing wear**, ramp **2 minutes**. Skip ahead by explaining while it builds.

*Expect:* lube pressure stays normal. The spectrum grows a family of narrow peaks at fixed multiples of the shaft frequency. Vibration flickers over the warning level from about 70 seconds and settles above it, and **never reaches the alarm limit**.

*Say:* this is the fault a plain threshold alarm sees too late or never. Both faults raise vibration. What tells them apart is the pressure and the shape of the spectrum. That is the evidence the diagnosis agent will reason over.

*Do:* choose **Normal** again.

### 7. Losing a machine (1 min)

*Boards:* pull the press board's power. About 15 seconds later the platform shows it offline, because the broker publishes the board's Last Will. Plug it back in: it reconnects on its own and the strip returns to online.

*Simulator:* start it with `--crash`, then press Ctrl+C, which drops the connection without a clean disconnect, exactly like a power cut.

*Say:* the board tells the platform in its own connection packet what to announce if it dies. Nobody polls it.

### 8. What comes next (1 min)

Show the sequence diagram in [`phase5-agent-blueprint.md`](phase5-agent-blueprint.md). *Say:* a cheap detector decides when something deserves a look. A language-model agent then correlates every channel, retrieves the maintenance manual, tests hypotheses, and uses the operator's own bindings to highlight the responsible component, with cited evidence. The diagnosis is computed in code, the model never does arithmetic, and the agent cannot act on a machine. The blueprint is designed and not yet built, and the platform is the part that is.

## If something goes wrong

| Problem | Do |
|---|---|
| A board will not connect | Use the second Wi-Fi network in `secrets.h` (a phone hotspot). Otherwise switch to the simulator against a local broker and say so |
| The cloud broker is unreachable | Local Mosquitto and the simulator: set `MQTT_URL=mqtt://127.0.0.1:1883`, restart the API |
| The twin shows nothing live | Check the connection chip. Reload. Check `/api/v1/health` |
| No **Faults** tab | Commands are off: set `ENABLE_DEVICE_COMMANDS=true`, restart the API |
| A fault seems stuck | Choose **Normal** in the Faults tab, or `cmd/reboot` over MQTT |
| The model will not load | Reload once, check the API is up, and fall back to the Registry and mapping pages |

## Questions you may get

**Why an ESP32 and not a real controller?** A real robot or press exposes its state through the controller, through OPC UA or MTConnect, and a plant gateway puts it on the broker. The ESP32 plays that gateway, and its models stand in for the controller. The platform sees the same messages either way.

**Is the data real?** It is simulated, from documented models: a robot weld cycle, a press stroke, a lubrication circuit and a vibration spectrum built from a shaft frequency and a bearing defect. The limits are illustrative constants. The same equations run in the firmware and the software simulator, and a self-test checks that they agree on the chip.

**How do you know the agent will not see the answer?** The simulator's active fault is published only in a diagnostics field that the backend strips from every general stream. It is served by one endpoint, for the fault panel and the evaluation harness, and the agent's tool API will not expose it.

**Why does an operator choose the mesh?** The model has a welding robot, a spot weld gun and a stamping press, but not a lubrication unit or a bearing housing as separate parts. The binding table decouples signal from geometry, so any part can stand for a signal, and a different model needs only six new bindings.

**What about security?** It is a prototype. The server listens on loopback by default, rejects foreign browser origins, keeps device commands off unless enabled, and the broker credentials never reach the browser. There is no user authentication yet.

**What if the network drops?** Each board backs off and reconnects, keeps its clock disciplined, and restarts itself if it has not been running for ten minutes. The platform marks a device stale if telemetry stops, even when a retained "online" is left behind.
