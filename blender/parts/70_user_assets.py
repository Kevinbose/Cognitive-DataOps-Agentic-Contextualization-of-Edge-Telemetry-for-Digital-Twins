# =============================================================================
#  Your own high-resolution models (optional)
#
#  Set USER_ASSETS at the top of the script, or pass --robot / --press /
#  --fence on the command line. Each model is imported, every part's origin is
#  reset to its own geometry, the whole model is scaled to the real-world size
#  below, stood on the floor at its planned position and heading, flattened
#  (transforms applied, no parent nodes), and every mesh renamed to upper case
#  so the viewer can bind sensors to it. Without a model the procedural
#  machine, already named, is built instead.
# =============================================================================

# Real-world target sizes (metres). "fit" says which dimension is matched.
ASSET_TARGETS = {
    "press": dict(fit="height", size=6.4, prefix="PRESS_", zone="press", machine="press-stamp-01",
                  label="Heavy stamping press (imported model)"),
    "robot": dict(fit="height", size=2.6, prefix="ROBOT_", zone="body", machine="robot-weld-01",
                  label="Six-axis welding robot (imported model)"),
    "fence": dict(fit="height", size=FENCE_H, prefix="CELL_FENCE_", zone="body", machine="robot-weld-01",
                  label="Safety fence panel (imported model)"),
}

# Part-name rules: the first regular expression that matches an imported
# object's name (case-insensitive) gives its new name. Edit these to suit the
# naming in your files; anything unmatched becomes PREFIX_PART_001 and so on.
ASSET_RENAME_RULES = {
    "press": [(r"main.?motor|motor", "MAIN_MOTOR"), (r"lube|lubric|oil", "LUBE_UNIT"), (r"filter", "LUBE_FILTER"),
              (r"bearing", "MAIN_BEARING"), (r"fly.?wheel", "FLYWHEEL"), (r"crown|top", "CROWN"),
              (r"slide|ram", "SLIDE"), (r"bolster", "BOLSTER"), (r"bed|base", "BED"), (r"upright|column|frame", "FRAME"),
              (r"die", "DIE"), (r"cabinet|control", "CONTROL_CABINET")],
    "robot": [(r"a1|axis.?1|base|foot", "BASE"), (r"a2|axis.?2|lower.?arm|shoulder", "A2_LOWER_ARM"),
              (r"a3|axis.?3|upper.?arm|elbow", "A3_ARM"), (r"a4|axis.?4|forearm", "A4_SERVO_MOTOR"),
              (r"a5|axis.?5|wrist", "A5_WRIST"), (r"a6|axis.?6|flange", "A6_FLANGE"),
              (r"gun|weld|torch|tool", "WELD_GUN"), (r"tip|electrode|tcp", "WELD_GUN_TIP"), (r"cable|hose|dress", "DRESS_PACK")],
    "fence": [(r".*", "PANEL")],
}


def _asset_args():
    import argparse
    p = argparse.ArgumentParser(add_help=False)
    for k in ("robot", "press", "fence"):
        p.add_argument(f"--{k}", default=None)
    a, _ = p.parse_known_args(_script_argv())
    for k in ("robot", "press", "fence"):
        if getattr(a, k):
            USER_ASSETS[k] = getattr(a, k)


_asset_args()


def user_asset(kind):
    path = USER_ASSETS.get(kind)
    if not path:
        return None
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        log(f"user asset for {kind} not found at {path}: using the procedural model")
        return None
    return path


def import_any(path):
    """Import a model by extension; return the objects it created."""
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext in (".usd", ".usdz", ".usdc", ".usda"):
        bpy.ops.wm.usd_import(filepath=path)
    else:
        raise ValueError(f"unsupported model format {ext}")
    return [o for o in bpy.data.objects if o not in before]


def _world_bbox(objs):
    lo = np.full(3, np.inf); hi = np.full(3, -np.inf)
    for o in objs:
        if o.type != "MESH" or not o.data.vertices:
            continue
        M = np.array(o.matrix_world)
        n = len(o.data.vertices)
        co = np.empty(n * 3, np.float32)
        o.data.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
        lo = np.minimum(lo, co.min(0)); hi = np.maximum(hi, co.max(0))
    return lo, hi


def reset_origin_to_geometry(o):
    """Move a mesh object's origin to the centre of its own bounding box,
    without moving the geometry in the world."""
    if o.type != "MESH" or not o.data.vertices:
        return
    n = len(o.data.vertices)
    co = np.empty(n * 3, np.float32)
    o.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    c = (co.min(0) + co.max(0)) / 2
    if o.data.users > 1:
        o.data = o.data.copy()               # do not shift a mesh other objects share
    o.data.transform(Matrix.Translation(Vector((-c[0], -c[1], -c[2]))))
    o.matrix_world = o.matrix_world @ Matrix.Translation(Vector(c))


def bake_into_meshes(objs, W=None):
    """Apply W @ world transform to every mesh, clear parents, drop non-mesh nodes."""
    meshes = [o for o in objs if o.type == "MESH"]
    worlds = {o: o.matrix_world.copy() for o in meshes}
    for o in meshes:
        mw = worlds[o] if W is None else W @ worlds[o]
        if o.data.users > 1:
            o.data = o.data.copy()
        o.parent = None
        o.data.transform(mw)
        o.matrix_world = Matrix.Identity(4)
    for o in objs:
        if o.type != "MESH" and o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)
    return meshes


def rename_parts(objs, kind):
    t = ASSET_TARGETS[kind]
    rules = ASSET_RENAME_RULES.get(kind, [])
    counts = {}
    for o in objs:
        original = o.name
        new = None
        for pattern, name in rules:
            if re.search(pattern, original, re.IGNORECASE):
                new = t["prefix"] + name
                break
        if new is None:
            counts[kind] = counts.get(kind, 0) + 1
            new = f"{t['prefix']}PART_{counts[kind]:03d}"
        o.name = unique_name(new)
        o.data.name = o.name
        register(o, f"{t['label']}: {original}", t["zone"], machine=t["machine"], role="imported",
                 tags=("imported", kind))


def place_user_asset(kind, location, heading_deg=0.0, coll=None, keep_objects=False):
    """Import, origin-reset, scale, stand on the floor, place, flatten, rename."""
    path = user_asset(kind)
    if path is None:
        return None
    t = ASSET_TARGETS[kind]
    objs = import_any(path)
    meshes = [o for o in objs if o.type == "MESH"]
    if not meshes:
        log(f"user asset {path} has no meshes")
        return None
    for o in meshes:
        reset_origin_to_geometry(o)
    lo, hi = _world_bbox(meshes)
    size = hi - lo
    s = t["size"] / max(size[2] if t["fit"] == "height" else size.max(), 1e-6)
    pivot = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])       # bottom centre
    W = Matrix((T(*location) @ Rz(heading_deg) @ S(s) @ T(*(-pivot))).tolist())
    out = bake_into_meshes(objs, W)
    target = coll if coll is not None else collection("USER_ASSETS")
    for o in out:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        target.objects.link(o)
    if not keep_objects:
        rename_parts(out, kind)
    lo2, hi2 = _world_bbox(out)
    log(f"user {kind}: {os.path.basename(path)}, {len(out)} meshes, scaled x{s:.4f}, "
        f"now {hi2[0] - lo2[0]:.2f} x {hi2[1] - lo2[1]:.2f} x {hi2[2] - lo2[2]:.2f} m at {tuple(round(v, 2) for v in location)}")
    STATS["objects"] += len(out)
    STATS["triangles"] += sum(len(o.data.polygons) for o in out)
    return out


def fence_from_user_panel(pts, closed=True, coll=None):
    """Array an imported fence panel along a polyline (linked duplicates)."""
    panel = place_user_asset("fence", (0.0, 0.0, 0.0), 0.0, coll, keep_objects=True)
    if not panel:
        return None
    lo, hi = _world_bbox(panel)
    width = max(hi[0] - lo[0], hi[1] - lo[1])
    along_x = (hi[0] - lo[0]) >= (hi[1] - lo[1])
    P = [np.asarray(p, float) for p in pts] + ([np.asarray(pts[0], float)] if closed else [])
    target = coll if coll is not None else collection("USER_ASSETS")
    made = []
    for a, b in zip(P[:-1], P[1:]):
        L = float(np.linalg.norm(b - a))
        n = max(1, int(round(L / width)))
        d = (b - a) / L
        ang = math.degrees(math.atan2(d[1], d[0]))
        for k in range(n):
            c = a + d * L * (k + 0.5) / n
            for src in panel:
                ob = bpy.data.objects.new(unique_name(f"CELL_FENCE_PANEL_{len(made) + 1:03d}"), src.data)
                M = T(c[0], c[1], 0.0) @ Rz(ang) @ S(L / n / width, 1.0, 1.0) @ (np.eye(4) if along_x else Rz(-90))
                ob.matrix_world = Matrix(M.tolist())
                target.objects.link(ob)
                made.append(ob)
    for src in panel:
        bpy.data.objects.remove(src, do_unlink=True)
    STATS["objects"] += len(made)
    log(f"user fence: {len(made)} panels along the cell")
    return made
