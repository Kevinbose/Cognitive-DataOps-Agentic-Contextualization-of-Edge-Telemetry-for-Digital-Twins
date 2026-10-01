# Cognitive DataOps: guide for Claude Code

A digital twin for a car plant. Operators bind telemetry channels to parts of a 3D model. Two ESP32 boards (or the software simulator) stream a welding robot and a stamping press over MQTT into a Node service, MongoDB and a React Three Fiber twin. Phase 5, a diagnosis agent, is a blueprint only. Read `README.md` first, then the doc you need:

| Topic | Read |
|---|---|
| Wire format, topics, payloads, fault physics | `docs/mqtt-contract.md` |
| The boards, bring-up, troubleshooting | `firmware/README.md`, and the `cdo-esp32-workflow` skill |
| Design system and the visual rules | `DESIGN.md` |
| Demo bindings, replay after a database reset | `docs/demo-binding-cheatsheet.md` |
| The planned agent | `docs/phase5-agent-blueprint.md` |

## Commands

```bash
npm run dev                                   # API on :5000, client on :5173
npm test                                      # server and client tests
node scripts/audit-ui.mjs                     # design rules over client sources: must stay at 0 violations
node scripts/check-contrast.mjs               # every token pair: must stay all passing
npm run build --workspace client              # also catches bundle growth
npm run simulate --workspace server           # both machines against a local broker
npm run seed:demo --workspace server          # dry run; add -- --apply --bindings to write
node scripts/fw.mjs doctor                    # firmware toolchain and secrets check
```

After any UI change, run the two audits and the client build. After any change to the catalog, the models or a payload, run the server tests.

## Rules that matter

**Secrets.** Never read, print, copy or edit `firmware/**/secrets.h` or any `server/.env*` file. They hold the user's credentials, and a hook and deny rules enforce it. Use `secrets.example.h` and `server/.env.example`. Never create accounts or credentials: the HiveMQ cluster, `secrets.h` and `server/.env` are the user's to fill in.

**Hardware.** Never pick a COM port; boards are identified by USB VID:PID (`node scripts/fw.mjs ports`). Before every upload, stop and ask the user to confirm the port and the cable swap. Name the machine on every upload. Do not work around a refusal from `fw.mjs`.

**Databases.** The local MongoDB also holds unrelated projects. Only touch `cognitive_dataops` and `cdo_test_*`. Tests use a disposable `cdo_test_*` database and refuse any other. The machine shop asset is unused: leave it alone.

**Ground truth.** The simulator's active scenario (`diag.sim`) must never reach a general stream, a client event, or any future `/agent/*` endpoint. It is served only by `GET /devices/:machineId/sim`.

**Git.** Nothing is committed unless the user asks. Work is on `feat/phase-3-5-edge-ingestion`.

## Architecture rules

- Layering: Route, Validator, Controller, Service, Model. A controller with an `if`, a query or a `try/catch` has logic in the wrong file. Services never see `req` or `res`. The MQTT transport only moves bytes.
- Binding is 1 mesh to 1 sensor, enforced by partial unique indexes, not application code. Emit `binding:changed` after a binding changes, after the transaction resolves.
- Live telemetry never enters the RTK Query cache. It has its own slice, batched at 4 Hz. Anything keyed on mesh-node objects would re-seed the binding form on every tick.
- `firmware/catalog.json` is the one source of truth for channels. Edit it, then `node scripts/gen-catalog.mjs`. The C++ and JavaScript models in `simulation.h` and `sim-models.mjs` must change together.
- A gateway only announces itself. A person adds it to a twin (Machines tab, `POST /assets/:id/machines`), and only an added machine's data and channels appear on that twin. Removing it retires its bindings.
- Any mesh can stand for any machine part. Do not search the GLB for components.

## UI rules

`DESIGN.md` is authoritative and `scripts/audit-ui.mjs` encodes it. In short: 0 px corners, no shadows, no gradients, no blur, no pure white, state carried by shape plus text, sentence case, no em dashes in UI strings, Phosphor icons only through `client/src/components/ui/icons.js`, Archivo for titles and Plex for everything else, Plex Mono for every number that changes, skeletons for loading, `prefers-reduced-motion` honoured. Do not add a chart library: the plots are inline SVG.

## Working in this environment

- Windows. The ESP32 build overruns the 260 character path limit inside the repo, so `fw.mjs` builds under the system temp directory.
- The in-process test broker (aedes) drops a retained QoS 0 message when a client publishes again in the same tick. The simulator staggers its connect-time publishes for that reason.
- In the Bash tool, doubled backslashes inside a heredoc were halved, which silently broke regular expressions. Write code with the Write and Edit tools, not through a heredoc.
- The built-in browser's screenshots vary in crop and scale. Use `resize_window` (1280x800) and reset it with the desktop preset afterwards.
- Stop background servers (API, simulator, preview) when finished.
