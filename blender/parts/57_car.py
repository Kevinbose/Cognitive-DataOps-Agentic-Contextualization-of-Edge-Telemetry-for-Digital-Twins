# =============================================================================
#  Car bodies, every production stage
#
#  A crossover EV, 4.60 m x 1.86 m x 1.62 m, wheelbase 2.82 m, lofted from a
#  station table (x along the car, front = +X). Wheel arches are cut by raising
#  the section floor over each wheel, door apertures and windows by dropping
#  faces, so one generator gives:
#    biw        bare steel body-in-white, no doors, open windows
#    ecoat      the same after the e-coat dip
#    primer     primer grey
#    paint      painted body, doors removed (trim line), open windows
#    trim       painted, cockpit and seats in, glass in, doors still off
#    chassis    + wheels and suspension, doors off
#    final      complete car, doors on
#  Each (stage, colour) mesh is built once and shared by every car using it.
# =============================================================================

CAR = dict(L=4.6, W=1.86, wb=2.82, xf=1.41, xr=-1.41, wz=0.36, wr=0.36, arch=0.43, track=0.80)

# x, z_bottom, z_belt, z_top, half-width low, half-width belt, half-width top
CAR_STATIONS = [
    (-2.30, 0.46, 0.74, 0.86, 0.66, 0.66, 0.50),
    (-2.24, 0.36, 0.90, 1.00, 0.84, 0.85, 0.66),
    (-2.12, 0.32, 0.97, 1.24, 0.90, 0.90, 0.60),
    (-1.95, 0.30, 0.99, 1.47, 0.92, 0.91, 0.63),
    (-1.60, 0.29, 1.00, 1.58, 0.93, 0.92, 0.66),
    (-1.00, 0.28, 1.00, 1.62, 0.93, 0.93, 0.67),
    (-0.20, 0.27, 0.99, 1.62, 0.93, 0.93, 0.67),
    (0.45, 0.27, 0.98, 1.58, 0.93, 0.93, 0.66),
    (0.80, 0.28, 0.97, 1.38, 0.93, 0.92, 0.61),
    (1.08, 0.29, 0.95, 1.10, 0.92, 0.91, 0.62),
    (1.30, 0.30, 0.92, 1.00, 0.91, 0.89, 0.70),
    (1.80, 0.32, 0.86, 0.92, 0.89, 0.86, 0.70),
    (2.15, 0.34, 0.78, 0.83, 0.85, 0.81, 0.63),
    (2.26, 0.38, 0.70, 0.74, 0.76, 0.72, 0.54),
    (2.30, 0.44, 0.62, 0.66, 0.64, 0.60, 0.46),
]

CAR_COLOURS = {"white": "#e8e9e6", "silver": "#a9aeb3", "black": "#1e2023", "red": "#a3161c",
               "blue": "#1f4b8f", "grey": "#5c6268", "green": "#2e5b49", "sand": "#b9a58a"}

# x ranges (car frame)
FRONT_DOOR = (0.06, 0.98)
REAR_DOOR = (-0.97, -0.02)
GAPS = (0.98, 0.06, -0.02, -0.97)


def _catmull(xs, ys, xq):
    """Catmull-Rom through (xs, ys), sampled at xq (xs increasing)."""
    xs = np.asarray(xs, float); ys = np.asarray(ys, float)
    out = np.empty_like(xq, dtype=float)
    for n, x in enumerate(xq):
        i = int(np.clip(np.searchsorted(xs, x) - 1, 0, len(xs) - 2))
        p0, p1 = ys[max(i - 1, 0)], ys[i]
        p2, p3 = ys[i + 1], ys[min(i + 2, len(xs) - 1)]
        t = (x - xs[i]) / (xs[i + 1] - xs[i])
        out[n] = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)
    return out


def _car_x_samples():
    xs = list(np.arange(-2.30, 2.30001, 0.075))
    for xw in (CAR["xf"], CAR["xr"]):
        xs += list(np.arange(xw - CAR["arch"] - 0.02, xw + CAR["arch"] + 0.03, 0.035))
    for g in GAPS:
        xs += [g - 0.006, g + 0.006]
    for edge in (0.70, 1.15, -1.85, -2.12, -1.75, -1.08, 0.5, -1.4, 2.12, -2.15, 1.9):
        xs.append(edge)
    xs = np.unique(np.round(np.clip(xs, -2.30, 2.30), 4))
    return xs


def car_section_grid():
    """Vertex grid (stations x 18 ring points) of the closed body shell."""
    tab = np.array(CAR_STATIONS)
    xs = _car_x_samples()
    cols = [_catmull(tab[:, 0], tab[:, c], xs) for c in range(1, 7)]
    zb, zbelt, ztop, wl, wb, wt = cols
    # wheel arches: raise the section floor over each wheel
    for xw in (CAR["xf"], CAR["xr"]):
        dx = xs - xw
        inside = np.abs(dx) < CAR["arch"]
        arch = CAR["wz"] + np.sqrt(np.clip(CAR["arch"] ** 2 - dx ** 2, 0, None))
        zb = np.where(inside, np.maximum(zb, arch), zb)
    rings = []
    for i in range(len(xs)):
        hp = ztop[i] - zbelt[i]
        half = [
            (0.0, zb[i] + 0.035),
            (wl[i] - 0.10, zb[i]),
            (wl[i] - 0.012, zb[i] + 0.09),
            (wl[i] + 0.012, zb[i] + 0.55 * (zbelt[i] - zb[i])),
            (wb[i], zbelt[i] - 0.03),
            (wb[i] - 0.05, zbelt[i] + 0.02),
            (wb[i] - 0.05 + 0.55 * (wt[i] - wb[i] + 0.05) - 0.025, zbelt[i] + 0.02 + 0.6 * (hp - 0.05)),
            (wt[i], ztop[i] - 0.03),
            (wt[i] * 0.55, ztop[i] + 0.004),
            (0.0, ztop[i] + 0.01),
        ]
        ring = [half[0]] + half[1:9] + [half[9]] + [(-y, z) for (y, z) in reversed(half[1:9])]
        rings.append([(xs[i], y, z) for (y, z) in ring])
    return xs, np.array(rings)        # (S, 18, 3)


def _band(j):
    return j if j <= 8 else 17 - j


def _in(x, rng):
    return rng[0] <= x <= rng[1]


def car_face_material(xm, band, stage, paint):
    """Material key for the quad centred at xm in ring band, or None to drop it."""
    # *_closed stages and paintshell carry their doors (paint shop: closures are on)
    base_stage = stage.replace("_closed", "")
    open_doors = stage in ("biw", "ecoat", "primer", "paint", "trim", "chassis")
    glass = stage in ("trim", "chassis", "final")
    bare = {"biw": "biw_steel", "ecoat": "ecoat_grey", "primer": "primer_grey"}.get(base_stage)
    body = bare or paint
    door = _in(xm, FRONT_DOOR) or _in(xm, REAR_DOOR)
    cabin = -2.12 < xm < 1.15
    side_window = (_in(xm, (0.07, 0.70)) or _in(xm, (-0.95, -0.03)) or _in(xm, (-1.75, -1.08)))
    windshield = _in(xm, (0.70, 1.15))
    rear_glass = _in(xm, (-2.12, -1.85))
    pano = _in(xm, (-1.4, 0.5))
    if open_doors and door and 2 <= band <= 6:
        return None
    if band in (5, 6) and cabin and side_window:
        return "glass_dark" if glass else None
    if band in (7, 8) and (windshield or rear_glass):
        return "glass_dark" if glass else None
    if band in (7, 8) and pano and not bare:
        return "glass_dark"
    if bare:
        return body
    if band in (0, 1):
        return "plastic_black"
    if any(abs(xm - g) < 0.007 for g in GAPS) and 2 <= band <= 4:
        return "graphite"
    if band in (3, 4) and xm > 2.12:
        return "lens_clear"
    if band == 4 and 1.9 < xm <= 2.12:
        return "led_white" if stage == "final" else "lens_clear"
    if band in (3, 4) and xm < -2.15:
        return "lens_red"
    if band == 2 and xm > 2.0:
        return "plastic_black"
    return body


def car_body_mb(stage, paint):
    """The body shell for one stage as an MB in car-local coordinates."""
    xs, R = car_section_grid()
    S_, K = R.shape[0], R.shape[1]
    V = R.reshape(-1, 3)
    idx = np.arange(S_ * K).reshape(S_, K)
    # analytic-ish smooth normals: average of adjacent face normals over the grid
    quads = []
    for i in range(S_ - 1):
        for j in range(K):
            j2 = (j + 1) % K
            quads.append((idx[i, j], idx[i + 1, j], idx[i + 1, j2], idx[i, j2], i, j))
    Q = np.array([q[:4] for q in quads])
    fn = np.cross(V[Q[:, 1]] - V[Q[:, 0]], V[Q[:, 3]] - V[Q[:, 0]])
    # orient outward: the roof quads must point up
    roof = [k for k, q in enumerate(quads) if _band(q[5]) == 8]
    if np.mean(fn[roof, 2]) < 0:
        Q = Q[:, ::-1]
        fn = -fn
    N = np.zeros_like(V)
    for c in range(4):
        np.add.at(N, Q[:, c], fn)
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    mb = MB()
    groups = {}
    for k, q in enumerate(quads):
        i, j = q[4], q[5]
        xm = 0.5 * (xs[i] + xs[i + 1])
        mat = car_face_material(xm, _band(j), stage, paint)
        if mat is None:
            continue
        groups.setdefault(mat, []).append(Q[k])
    for mat, qs in groups.items():
        qs = np.array(qs)
        F = np.concatenate([qs[:, [0, 1, 2]], qs[:, [0, 2, 3]]])
        used = np.unique(F)
        remap = -np.ones(len(V), int); remap[used] = np.arange(len(used))
        mb.add(Prim(V[used], N[used], remap[F]), None, mat)
    # end caps (bumper tips)
    for i, sgn in ((0, -1.0), (S_ - 1, 1.0)):
        ring = R[i]
        c = ring.mean(axis=0)
        Vc = np.vstack([ring, c[None, :]])
        Fc = [(K, (j + 1) % K, j) if sgn > 0 else (K, j, (j + 1) % K) for j in range(K)]
        cap = Prim(Vc, np.tile([sgn, 0.0, 0.0], (K + 1, 1)), Fc)
        bare_cap = {"biw": "biw_steel", "ecoat": "ecoat_grey", "primer": "primer_grey"}.get(stage.replace("_closed", ""))
        mb.add(cap, None, bare_cap or (paint if stage == "paintshell" else "plastic_black"))
    return mb


def car_wheel(mb, M):
    """Tyre, alloy rim, brake disc and caliper; wheel axis along local Y."""
    tyre = [(0.245, -0.118), (0.31, -0.122), (0.35, -0.11), (0.362, -0.06), (0.362, 0.06), (0.35, 0.11),
            (0.31, 0.122), (0.245, 0.118)]
    mb.add(lathe(tyre, 36, smooth_deg=50), M @ Rx(-90), "tire")
    rim = [(0.0, 0.07), (0.07, 0.075), (0.2, 0.06), (0.245, 0.09), (0.25, 0.1)]
    mb.add(lathe(rim, 36, smooth_deg=40), M @ Rx(-90), "rim")
    for k in range(5):
        mb.add(rbox(0.05, 0.19, 0.025, 0.01), M @ Rx(-90) @ Rz(72 * k) @ T(0, 0.135, 0.065), "rim")
    mb.add(cyl(0.18, 0.025, 28), M @ Rx(-90) @ T(0, 0, -0.02), "steel_dark")
    mb.add(rbox(0.1, 0.08, 0.14, 0.02), M @ T(0.12, 0.0, 0.12) @ Rx(-90), "safety_red")


def car_interior(mb, stage, paint):
    base_stage = stage.replace("_closed", "")
    bare = base_stage in ("biw", "ecoat", "primer") or stage == "paintshell"
    floor_mat = {"biw": "biw_steel", "ecoat": "ecoat_grey", "primer": "primer_grey"}.get(base_stage, "ecoat_grey" if stage == "paintshell" else "interior")
    mb.add(box(), T(-0.2, 0, 0.42) @ S(3.4, 1.7, 0.03), floor_mat)                 # floor pan
    mb.add(box(), T(1.2, 0, 0.72) @ S(0.03, 1.72, 0.6), floor_mat)                 # firewall
    mb.add(box(), T(-1.2, 0, 0.62) @ S(0.12, 1.72, 0.4), floor_mat)                # rear seat cross member
    if bare:
        for sy in (-0.45, 0.45):
            mb.add(box(), T(-0.1, sy, 0.47) @ S(2.6, 0.08, 0.08), floor_mat)           # tunnel rails
        return
    if stage in ("trim", "chassis", "final"):
        mb.add(rbox(0.5, 1.7, 0.35, 0.08), T(0.85, 0, 0.98), "interior")           # dashboard
        mb.add(rbox(0.32, 1.2, 0.05, 0.01), T(0.7, 0.0, 1.16) @ Ry(-60), "screen")  # display
        mb.add(torus(0.17, 0.018, 24, 6), T(0.55, 0.38, 1.0) @ Ry(-70), "plastic_black")
        for sy in (-0.4, 0.4):                                                     # front seats
            mb.add(rbox(0.52, 0.5, 0.14, 0.06), T(0.05, sy, 0.62), "fabric")
            mb.add(rbox(0.12, 0.48, 0.62, 0.05), T(-0.22, sy, 0.95) @ Ry(-12), "fabric")
        mb.add(rbox(0.5, 1.35, 0.14, 0.06), T(-0.95, 0, 0.62), "fabric")           # rear bench
        mb.add(rbox(0.12, 1.35, 0.6, 0.05), T(-1.22, 0, 0.93) @ Ry(-12), "fabric")
    elif stage == "paint":
        mb.add(box(), T(-0.2, 0, 0.445) @ S(3.0, 1.5, 0.02), "plastic_black")      # protective floor mat


def car_extras(mb, stage, paint):
    if stage in ("chassis", "final"):
        for x in (CAR["xf"], CAR["xr"]):
            for sy in (-1, 1):
                car_wheel(mb, T(x, sy * CAR["track"], CAR["wz"]) @ (Rz(180) if sy < 0 else np.eye(4)))
        for x in (CAR["xf"], CAR["xr"]):            # arch liners
            for sy in (-1, 1):
                mb.add(lathe([(0.45, -0.13), (0.45, 0.13)], 24, a0=-10, a1=190), T(x, sy * 0.78, CAR["wz"]) @ Rx(90), "plastic_black")
        mb.add(box(), T(-0.2, 0, 0.24) @ S(2.5, 1.5, 0.12), "graphite")             # battery pack
    if stage == "final":
        for sy in (-1, 1):                                                            # mirrors
            mb.add(rbox(0.16, 0.2, 0.12, 0.04), T(0.98, sy * 1.02, 1.06), paint)
            mb.add(box(), T(0.95, sy * 1.12, 1.06) @ S(0.02, 0.02, 0.05), "plastic_black")
            for x in (0.45, -0.5):                                                    # handles
                mb.add(rbox(0.16, 0.025, 0.03, 0.01), T(x, sy * 0.935, 0.93), "plastic_black")


_CAR_MESHES = {}


def mb_mesh(name, mb):
    """One multi-material mesh data-block from an MB (for instancing)."""
    groups = mb.by_material()
    Vs, Ns, Fs, UVs, mats, mi, off = [], [], [], [], [], [], 0
    any_uv = any(g[3] is not None for g in groups.values())
    for k, (mat, (V, N, F, UV)) in enumerate(groups.items()):
        Vs.append(V); Ns.append(N); Fs.append(F + off)
        UVs.append(UV if UV is not None else np.zeros((len(V), 2)))
        mats.append(mat); mi.append(np.full(len(F), k, np.int32)); off += len(V)
    V = np.concatenate(Vs); N = np.concatenate(Ns); F = np.concatenate(Fs)
    me = mesh_data(name, V, N, F, np.concatenate(UVs) if any_uv else None, None)
    for mat in mats:
        me.materials.append(material(mat))
    me.polygons.foreach_set("material_index", np.concatenate(mi))
    me.update()
    return me


def car_meshes(stage, colour):
    key = (stage, colour)
    meshes = _CAR_MESHES.get(key)
    if meshes is None:
        paint = car_paint_key(CAR_COLOURS.get(colour, colour))
        mb = car_body_mb(stage, paint)
        car_interior(mb, stage, paint)
        car_extras(mb, stage, paint)
        meshes = mb_meshes(f"TPL_CAR_{stage}_{colour}", mb)
        _CAR_MESHES[key] = meshes
    return meshes


def place_car(name, stage, colour, x, y, z=0.0, heading=0.0, coll="ASSEMBLY", label=None, zone="assembly",
              matrix=None):
    """A car: one node per material, named NAME_PAINT, NAME_GLASS_DARK and so on.

    heading is the direction of the car's front, degrees from +X. A bare body
    (one material) keeps NAME exactly. matrix overrides the placement.
    """
    M = matrix if matrix is not None else T(x, y, z) @ Rz(heading)
    objs = place_meshes(car_meshes(stage, colour), name, M, coll, label, zone, "vehicle", ("car", stage))
    if matrix is None and z < 0.3:
        footprint(x, y, 4.3, 1.75, heading, 0.5, 0.45)
    return objs
