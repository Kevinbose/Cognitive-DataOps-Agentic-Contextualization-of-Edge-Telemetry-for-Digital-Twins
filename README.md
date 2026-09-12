# Cognitive DataOps

**Agentic Contextualization of Edge Telemetry for Digital Twins**

A web-native digital twin platform for heavy industry. Operators upload industrial 3D assets, click a part inside a browser-rendered model, and bind it to a logical sensor — turning an inert mesh into a queryable, instrumented twin.

> **Capstone project** · B.Tech CSE, VIT Chennai
> Kevin Bose J (23BCE5105) · Joseph Shalom A (23BCE1078) · Shubham Chattopadhyay (23BCE1671)

---

## Current status

| Phase | Scope | State |
|---|---|---|
| **1 — Asset pipeline** | CAD/GLB ingestion, provenance tracking, conversion state machine | ✅ Backend complete |
| **2 — Spatial mapping** | Mesh-node registry, sensor bindings, twin-scene API | ✅ Backend complete |
| **2 — Frontend** | React + Vite + React Three Fiber viewer, Redux/RTK Query | ⏳ Next iteration |
| **3 — Live telemetry** | ESP32 → MQTT ingestion, time-series storage | 🔜 Planned |
| **4 — Agentic layer** | LangGraph multi-agent diagnostics, RAG over manuals | 🔜 Planned |

The `client/` workspace is currently a placeholder stub so the monorepo resolves; the frontend is scaffolded next.

---

## Quick start

**Prerequisites:** Node.js ≥ 20, and a MongoDB instance (see [Database](#database) below).

```bash
git clone <repo-url>
cd Cognitive-DataOps-Agentic-Contextualization-of-Edge-Telemetry-for-Digital-Twins
npm install
```

Create your environment file:

```bash
cp server/.env.example server/.env
```

<details>
<summary>Windows PowerShell</summary>

```powershell
Copy-Item server\.env.example server\.env
```
</details>

Edit `server/.env` and set `MONGODB_URI`. Then:

```bash
npm run dev
```

The API comes up on <http://localhost:5000>. Confirm it is healthy:

```bash
curl http://localhost:5000/api/v1/health
```

```json
{
  "success": true,
  "data": { "status": "healthy", "database": "connected", "uptimeSeconds": 3 },
  "message": "Health check"
}
```

### Database

A **MongoDB Atlas free-tier (M0)** cluster is the recommended setup: all three teammates share one database, there is nothing to install, and — importantly — Atlas is a replica set, so multi-document **transactions work**.

A local standalone `mongod` also works, but cannot run transactions. The sensor-binding flow detects this at boot and falls back to sequential writes with a loud warning:

```
[db] This MongoDB deployment is a STANDALONE and does not support transactions.
     Sensor-binding rebinds will run without atomicity (sequential writes).
```

Functionally identical; the difference is only what happens if the process dies mid-rebind.

---

## Architecture

```
/
├── server/                  Express + Mongoose API  (strict MVC)
│   └── src/
│       ├── config/          env, database, storage layout
│       ├── models/          Asset · MeshNode · SensorBinding
│       ├── services/        ALL business logic lives here
│       ├── controllers/     thin — extract, delegate, respond
│       ├── routes/          mounted under /api/v1
│       ├── middleware/      upload · validate · errorHandler · asyncHandler
│       ├── validators/      Zod request schemas
│       └── utils/           ApiResponse · ApiError · transaction
├── client/                  React + Vite + R3F        (next iteration)
├── storage/assets/          local "S3-mimic" bucket   (gitignored)
├── Joe_Samples/             sample CAD + GLB assets
└── Shu_Research/            early R&D spike — reference only, not production
```

### Layering rule

```
Route → Validator → Controller → Service → Model
                                    ↓
                             storage.service  (the only module doing file I/O)
```

A controller that contains an `if` statement, a query, or a `try/catch` has business logic in the wrong file. Services never touch `req`/`res`; controllers never touch Mongoose.

---

## Data model

### `Asset` — one industrial asset and its two file artefacts

Tracks a deliberately two-stage pipeline:

| Field | Purpose |
|---|---|
| `originalFile` | Raw CAD (`.stp`/`.step`/`.iges`). **Provenance and audit only** — never parsed, never sent to a browser. |
| `convertedFile` | Web-ready `.glb`, exported manually from Blender. The only artefact React Three Fiber ever loads. |
| `status` | `pending_conversion → converted → mapped` (+ `failed`) |
| `version` | Bumped when the `.glb` is replaced; drives the `?v=` cache-buster |

**Status is a one-directional ratchet.** Unbinding the last sensor does *not* demote `mapped` back to `converted`, because `mapped` records that the asset has been through the mapping workflow — which remains true.

### `MeshNode` — an instrumentable sub-part

Created **on demand**, never bulk-imported. The real sample assets declare 811–1,203 glTF nodes each with machine-generated names like `000-tool-hire-depot-and-plant-yard-yard-ground-tile/0`. Inserting a document per node would mean ~1,000 writes to support the handful anyone actually instruments, so the browser discovers names by traversing the already-loaded scene graph, and a row is written only when a sensor is bound.

`meshName` is stored **verbatim** — trimmed, never lowercased or slugified. It is the join key for `scene.getObjectByName()` in the browser, so any normalisation would silently break the 3D highlight.

### `SensorBinding` — the sensor ↔ mesh link

Kept as its **own collection** rather than a field on `MeshNode`, for two reasons:

1. **Phase 3 queries from the sensor side.** MQTT ingestion asks "a reading arrived for `MOTOR_01_TEMP` — which mesh does it drive?". A dedicated collection answers that with one indexed `findOne`, without loading an asset or its mesh graph.
2. **Rebind history is free.** Moving a sensor closes the old row (`isActive: false`, `unboundAt` stamped) and inserts a new one, leaving an append-only audit log. An overwritten embedded field would destroy that.

Two **partial unique indexes** enforce the core invariants at the database level — not in application code, which races under concurrency:

```js
{ sensorId:    1 }  unique, where { isActive: true }   // a sensor drives ≤ 1 mesh
{ meshNodeId:  1 }  unique, where { isActive: true }   // a mesh has  ≤ 1 sensor
```

Scoping them to `isActive: true` is what lets an append-only history coexist with "exactly one live binding".

---

## API reference

All routes are under `/api/v1`. Every response uses one envelope:

```jsonc
// success
{ "success": true,  "data": { }, "message": "…", "meta": { } }
// failure
{ "success": false, "data": null, "message": "…", "errors": [ { "field": "…", "message": "…" } ] }
```

### Assets

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/assets` | Create an asset; optionally upload the CAD file in the same multipart request |
| `GET` | `/assets` | List — `?status=&search=&page=&limit=` |
| `GET` | `/assets/:assetId` | Metadata |
| `PATCH` | `/assets/:assetId` | Edit `name` / `notes` / `units` / `partCount` |
| `DELETE` | `/assets/:assetId` | Soft delete, cascading to mesh nodes and bindings |
| `POST` | `/assets/:assetId/original-file` | Attach/replace the CAD file (field `originalFile`) |
| `POST` | `/assets/:assetId/converted-file` | Attach/replace the `.glb` (field `convertedFile`) → promotes to `converted` |
| `GET` | `/assets/:assetId/original-file` | Download the CAD file |
| `GET` | `/assets/:assetId/converted-file` | Download the `.glb` |
| `GET` | **`/assets/:assetId/scene`** | **Aggregated twin scene** — asset + `modelUrl` + every mesh node with its active binding joined |

### Mesh nodes & bindings

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/assets/:assetId/mesh-nodes` | List registered nodes — `?mappedOnly=true` |
| `POST` | `/assets/:assetId/mesh-nodes` | Register a node without binding |
| `PUT` | **`/assets/:assetId/mesh-nodes/by-name/:meshName/sensor-binding`** | **Save a mapping** (idempotent) |
| `PATCH` | `/mesh-nodes/:meshNodeId` | Edit `displayName` / `nodePath` |
| `DELETE` | `/mesh-nodes/:meshNodeId` | Soft delete + unbind |
| `GET` | `/assets/:assetId/sensor-bindings` | List bindings — `?includeInactive=true` for history |
| `DELETE` | `/sensor-bindings/:bindingId` | Retire a binding |
| `GET` | `/health` | Liveness + database state |

### Serving meshes

`.glb` files are served by `express.static` at `/static/assets/<assetId>/converted.glb`, **not** through a controller. The static middleware handles HTTP range requests, ETags, and conditional GETs — all of which streaming glTF loaders depend on.

The `scene` endpoint returns the URL pre-built with a cache-buster:

```
/static/assets/6aa48dbe38a57d15110de3d1/converted.glb?v=1
```

Without the `?v=`, drei's `useGLTF` would keep rendering stale geometry after a re-upload.

---

## Worked example

```bash
API=http://localhost:5000/api/v1

# 1 — Create an asset with its source CAD file
curl -s -X POST $API/assets \
  -F "name=Tool & Plant Hire Depot" \
  -F "uploader=Kevin Bose J" \
  -F "sourceType=stp" \
  -F "originalFile=@Joe_Samples/MWP001-roller conveyors.stp"
# → 201, status: "pending_conversion"

# 2 — Upload the Blender-converted mesh
ASSET_ID=<id from step 1>
curl -s -X POST $API/assets/$ASSET_ID/converted-file \
  -F "convertedFile=@Joe_Samples/tool_and_plant_hire_depot.glb"
# → 200, status: "converted", isRenderable: true

# 3 — Bind a sensor to a mesh (name must be percent-encoded)
MESH=$(python -c "import urllib.parse;print(urllib.parse.quote('000-tool-hire-depot-and-plant-yard-yard-ground-tile/0', safe=''))")
curl -s -X PUT $API/assets/$ASSET_ID/mesh-nodes/by-name/$MESH/sensor-binding \
  -H "Content-Type: application/json" \
  -d '{"sensorId":"depot_motor_01_temp","sensorType":"temperature","displayName":"Main Drive Motor"}'
# → 200, status promoted to "mapped", sensorId stored as DEPOT_MOTOR_01_TEMP

# 4 — Read the scene back
curl -s $API/assets/$ASSET_ID/scene
```

> **Percent-encode `:meshName`.** Real glTF names contain slashes. Use `encodeURIComponent(meshName)` from the browser.

---

## Design decisions worth knowing

**`.stp` is never rendered.** WebGL cannot draw parametric CAD geometry. Raw CAD is stored purely so the twin has an auditable source of truth; only the Blender-exported `.glb` reaches a browser. Automating STEP→glTF conversion is a documented stretch goal, not built.

**GLB uploads are verified by magic bytes.** Extension and MIME checks are trivially spoofed — a `.stp` renamed to `.glb` passes both, then fails confusingly inside the browser's loader. The storage service reads the first four bytes and requires ASCII `glTF` before the file is allowed into the bucket.

**Uploads are staged before they are accepted.** Multer writes to `storage/.tmp-uploads` under a random filename (never the client's, which is attacker-controlled). Only after validation does `storage.service.js` move the file into the bucket. That directory is explicitly excluded from the static mount.

**Reusing a live sensor is refused by default.** Binding `MOTOR_01_TEMP` to a second mesh returns `409` rather than silently relocating it from elsewhere in the plant. Pass `"reassign": true` to opt into the move.

**Storage keys, not paths.** Every layer above `storage.service.js` deals in bucket-relative keys (`assets/<id>/converted.glb`). Swapping the local filesystem for real S3 is a one-file change.

---

## Verification

The vertical slice is covered by an end-to-end script exercising 32 assertions against a real MongoDB — asset creation, magic-byte rejection, GLB upload, binding, persistence across a fresh read, idempotency, rebind history, the uniqueness conflict, `reassign`, unbind, and the soft-delete cascade.

Manual smoke sequence:

1. `npm run dev` — server boots, `/api/v1/health` reports `connected`.
2. `POST /assets` with a `.stp` → `pending_conversion`, file lands in `storage/assets/<id>/`.
3. `POST /assets/:id/converted-file` with a `.glb` → `converted`, `isRenderable: true`.
4. `PUT .../sensor-binding` → `200`, asset promoted to `mapped`.
5. `GET /assets/:id/scene` → binding present, read back from MongoDB.
6. Repeat step 4 unchanged → `"unchanged": true` (idempotent).
7. Bind the same sensor to a different mesh → `409` naming the conflict.

### Known gap

The **transactional** rebind path has only been exercised on a standalone MongoDB, which takes the documented non-transactional fallback. Re-run the sequence against Atlas (or a local replica set) to cover the transaction branch — the boot log should *not* print the standalone warning.

---

## Day 0 — git hygiene

This repository had no `.gitignore`, so `Shu_Research/digital-twin-demo/node_modules` (1,543 files) was committed by accident. The `.gitignore` now exists; untrack the strays once:

```bash
git rm -r --cached Shu_Research/digital-twin-demo/node_modules
git rm --cached Shu_Research/.DS_Store Shu_Research/digital-twin-demo/.DS_Store
git commit -m "chore: add .gitignore, untrack node_modules and .DS_Store"
```

Files stay on disk — only git tracking changes.

---

## Environment reference

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Runtime mode |
| `PORT` | `5000` | API port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/cognitive_dataops` | Connection string |
| `STORAGE_ROOT` | `storage` | Bucket root (relative paths resolve from the repo root) |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Allow-listed browser origins |
| `MAX_CAD_UPLOAD_MB` | `25` | CAD ceiling (largest sample: 19.85 MB) |
| `MAX_GLB_UPLOAD_MB` | `50` | GLB ceiling (largest sample: 7.92 MB) |

## Sample assets

| File | Size | glTF nodes | Note |
|---|---|---|---|
| `tool_and_plant_hire_depot.glb` | 2.78 MB | 811 | **Best first test asset** — fewest nodes, smallest payload |
| `car_factory.glb` | 2.64 MB | 1,031 | Good second test |
| `machine_shop.glb` | 7.92 MB | 1,203 | Save for last — a deliberate stress test, not a demo opener |
| `mwp001-layout.stp` | 19.85 MB | — | Largest CAD file; sets the 25 MB upload ceiling |
| `MWP001-roller conveyors.stp` | 6.20 MB | — | Smaller CAD sample |

None of these use clean `Motor_M001`-style naming — they are asset packs with machine-generated names. Use `MeshNode.displayName` to give demo-mapped parts readable labels while leaving `meshName` untouched.

---

## Tech stack

**Backend** Node.js 20+ · Express 5 · MongoDB + Mongoose 8 · Multer 2 · Zod · Helmet · CORS · Morgan
**Frontend** *(next)* React · Vite · React Three Fiber · Drei · Redux Toolkit + RTK Query · TailwindCSS
**Planned** ESP32 · MQTT · LangGraph · RAG
