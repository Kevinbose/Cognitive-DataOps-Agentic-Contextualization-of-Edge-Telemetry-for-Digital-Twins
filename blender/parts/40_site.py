# =============================================================================
#  Site: layout, building structure, walls, floor
#
#  Plan (Blender coordinates, metres; +X east, +Y north, +Z up):
#
#     y=+36 +-----------------------------+------------------------------+
#           |  PAINT SHOP          (NW)   |  FINAL ASSEMBLY        (NE)  |
#           |  pretreat, e-coat, sealer,  |  trim, marriage, chassis,    | --> dispatch
#           |  booths, ovens              |  final line, end-of-line     |     yard (east)
#     y=  0 +------- main aisle ----------+------------------------------+
#           |  BODY SHOP           (SW)   |  PRESS SHOP            (SE)  | <-- coil dock
#           |  ROBOT-WELD-01 cell, sub-   |  PRESS-STAMP-01 transfer     |
#           |  assembly, framing line     |  line, tandem line, coils    |
#     y=-36 +-----------------------------+------------------------------+
#          x=-56                         x=0                           x=+56
#
#  Material flows anticlockwise from the coil dock: press, body, paint,
#  assembly, dispatch. The twin viewer's default camera looks from the
#  south-east, so the two instrumented machines sit in the front row, in clear
#  view, with the south and east walls cut away like an architectural model.
# =============================================================================

SITE = dict(
    x0=-56.0, x1=56.0, y0=-36.0, y1=36.0,
    eave=13.0,                 # underside of roof trusses
    truss_depth=2.4,
    slab=0.25,                 # floor slab thickness, its edge shows at the cut-away
    x_lines=[-56.0, -49.0, -35.0, -21.0, -7.0, 7.0, 21.0, 35.0, 49.0, 56.0],
    y_lines=[-36.0, -12.0, 12.0, 36.0],
)

ZONES = {
    "press":    dict(x0=0.0, x1=56.0, y0=-36.0, y1=0.0, title="PRESS SHOP"),
    "body":     dict(x0=-56.0, x1=0.0, y0=-36.0, y1=0.0, title="BODY SHOP"),
    "paint":    dict(x0=-56.0, x1=0.0, y0=0.0, y1=36.0, title="PAINT SHOP"),
    "assembly": dict(x0=0.0, x1=56.0, y0=0.0, y1=36.0, title="FINAL ASSEMBLY"),
}

# The two instrumented machines. Everything else is placed relative to these.
LAYOUT = {
    # Heavy stamping press, 2,500 t servo transfer press: a line of its own at
    # the west end of the press shop, so its panels go straight across the
    # aisle into the body shop. Its front (die area, operator side) faces east,
    # upstream, towards its destacker.
    "press": dict(x=11.5, y=-24.0, rot=90.0),
    # Six-axis spot-welding robot in a fenced respot cell at the press-shop end
    # of the body shop, reaching west into a body-in-white on its fixture.
    "robot": dict(x=-10.6, y=-25.5, rot=180.0),
    "robot_cell": dict(x0=-19.5, x1=-7.0, y0=-30.5, y1=-20.0),
    "biw_fixture": dict(x=-15.4, y=-25.3, rot=0.0),
    # second line: three-press tandem line further east, flowing west
    "press_line_x": [47.5, 37.0, 26.5],
    "press_line_y": -24.0,
}

FOOTPRINTS = []     # soft contact shadows painted into the floor
MARKINGS = []       # floor paint, rasterised into the floor textures


CAPTURE = []        # while a template is built, floor events are recorded here


def footprint(cx, cy, sx, sy, rot=0.0, strength=0.55, soft=0.7):
    ev = ("rect", cx, cy, sx, sy, rot, strength, soft)
    if CAPTURE:
        CAPTURE[-1].append(("fp", ev))
    else:
        FOOTPRINTS.append(ev)


def footprint_disc(cx, cy, r, strength=0.5, soft=0.5):
    ev = ("disc", cx, cy, r, r, 0.0, strength, soft)
    if CAPTURE:
        CAPTURE[-1].append(("fp", ev))
    else:
        FOOTPRINTS.append(ev)


def mark(kind, **kw):
    if CAPTURE:
        CAPTURE[-1].append(("mk", (kind, kw)))
    else:
        MARKINGS.append((kind, kw))


def replay_floor_events(events, F):
    """Re-issue a template's footprints and floor paint at an instance's frame."""
    heading = math.degrees(math.atan2(F[1, 0], F[0, 0]))

    def P(x, y):
        q = apply_point(F, (x, y, 0.0))
        return float(q[0]), float(q[1])
    for tag, ev in events:
        if tag == "fp":
            kind, cx, cy, sx, sy, rot, st, so = ev
            nx, ny = P(cx, cy)
            FOOTPRINTS.append((kind, nx, ny, sx, sy, rot + heading, st, so))
            continue
        kind, kw = ev
        kw = dict(kw)
        if kind in ("rect", "frame", "hatch"):
            (ax, ay), (bx, by) = P(kw["xa"], kw["ya"]), P(kw["xb"], kw["yb"])
            kw.update(xa=min(ax, bx), ya=min(ay, by), xb=max(ax, bx), yb=max(ay, by))
            if "rot" in kw:
                kw["rot"] = kw["rot"] + heading
        elif kind == "line":
            kw["p0"], kw["p1"] = P(*kw["p0"]), P(*kw["p1"])
        elif kind in ("ring", "disc", "stain"):
            kw["cx"], kw["cy"] = P(kw["cx"], kw["cy"])
        elif kind == "arrow":
            kw["x"], kw["y"] = P(kw["x"], kw["y"])
            kw["ang"] = kw.get("ang", 0.0) + heading
        MARKINGS.append((kind, kw))


class Template:
    """Build a machine once (in its own frame) and place shared instances.

    build_fn(frame) builds into a Machine with template=True and returns it.
    The glTF stores the geometry once; each placement is one node.
    """

    def __init__(self, name, build_fn, detail=0.5):
        CAPTURE.append([])
        try:
            with low_detail(detail):
                m = build_fn(np.eye(4))
        finally:
            self.events = CAPTURE.pop()
        log(f"  template {name}: {sum(len(p[2]) for p in m.mb.parts):,} triangles")
        self.meshes = mb_meshes("TPL_" + name, m.mb)
        self.triangles = sum(len(me.polygons) for me in self.meshes.values())

    def place(self, name, F, coll, label=None, zone=None, role=None, tags=()):
        objs = place_meshes(self.meshes, name, F, coll, label, zone, role, tags)
        replay_floor_events(self.events, np.asarray(F, float))
        return objs


# ----------------------------------------------------------------------------- columns
def build_columns():
    coll = "SITE_STRUCTURE"
    H = SITE["eave"]
    xs, ys = SITE["x_lines"], SITE["y_lines"]
    spots = set()
    for x in xs:
        for y in ys:
            on_edge = x in (SITE["x0"], SITE["x1"]) or y in (SITE["y0"], SITE["y1"])
            interior_x = x not in (SITE["x0"], SITE["x1"])
            if on_edge or interior_x:
                spots.add((x, y))
    col_prof = ibeam(0.60, 0.30, 0.016, 0.03)
    for (x, y) in sorted(spots):
        mb = env("STRUCT", x, y, coll)
        perimeter = x in (SITE["x0"], SITE["x1"]) or y in (SITE["y0"], SITE["y1"])
        # web along X for walls parallel to X, along Y otherwise
        rot = 0.0 if y in (SITE["y0"], SITE["y1"]) else 90.0
        mb.add(col_prof, T(x, y, 0.35) @ Rz(rot) @ S(1, 1, H - 0.35), "struct_white")
        mb.add(box(), T(x, y, 0.02) @ S(0.75, 0.75, 0.04), "steel_dark")             # base plate
        mb.add(box(), T(x, y, 0.2) @ S(0.62, 0.62, 0.32), "foundation")              # grout plinth
        for sx in (-0.28, 0.28):
            for sy in (-0.28, 0.28):
                mb.add(cyl(0.022, 0.12, 8), T(x + sx, y + sy, 0.09), "steel_dark")
        mb.add(box(), T(x, y, H - 0.2) @ S(0.7, 0.7, 0.4), "struct_white")          # cap
        if not perimeter:
            # column guard, 1.2 m, hazard striped
            mbh = env("STRUCTHZ", x, y, coll)
            for dx, dy, sx_, sy_ in ((0, -0.42, 0.9, 0.08), (0, 0.42, 0.9, 0.08), (-0.42, 0, 0.08, 0.9), (0.42, 0, 0.08, 0.9)):
                mbh.add(box(), T(x + dx, y + dy, 0.6) @ S(sx_, sy_, 1.2), "hazard", uv="box", tile=0.4)
        footprint(x, y, 0.9, 0.9, 0, 0.35, 0.35)


# ----------------------------------------------------------------------------- roof frames
def build_trusses():
    """Steel portal frames: pitched I-section rafters on every column line.

    The cladding is left off, as in an architectural cut-away, and so are
    purlins: a raised camera (the viewer's) then sees down into the hall
    between slim rafters rather than through a cage of trusses.
    """
    coll = "SITE_STRUCTURE"
    H = SITE["eave"]
    y0, y1 = SITE["y0"], SITE["y1"]
    rise = 1.1                                   # about 3 degrees to the ridge
    raf = ibeam(0.9, 0.3, 0.014, 0.022)
    for x in SITE["x_lines"]:
        a, r, c = (x, y0, H + 0.45), (x, 0.0, H + 0.45 + rise), (x, y1, H + 0.45)
        for p0, p1 in ((a, r), (r, c)):
            mb = env("TRUSS", x, (p0[1] + p1[1]) / 2, coll)
            mb.add(raf, between(p0, p1), "struct_white")
        for yy in SITE["y_lines"]:                # haunch plates over the columns
            if y0 < yy < y1 or yy in (y0, y1):
                zz = H + 0.45 + rise * (1 - abs(yy) / 36.0)
                env("TRUSS", x, yy, coll).add(box(), T(x, yy, zz - 0.55) @ S(0.32, 1.4, 0.5), "struct_white")
    # ridge tie and two lines of eave-level ties keep the frames visibly braced
    xs = SITE["x_lines"]
    for i in range(len(xs) - 1):
        xa, xb = xs[i], xs[i + 1]
        for yy, zz in ((0.0, H + 0.45 + rise - 0.3), (-24.0, H + 0.45 + rise / 3 - 0.3), (24.0, H + 0.45 + rise / 3 - 0.3)):
            env("PURLIN", (xa + xb) / 2, yy, coll).add(box(), T((xa + xb) / 2, yy, zz) @ S(xb - xa, 0.16, 0.24), "galvanized")
    # cross bracing in the two end bays
    for (xa, xb) in ((xs[0], xs[1]), (xs[-2], xs[-1])):
        for (ya, yb) in ((-36.0, -12.0), (-12.0, 12.0), (12.0, 36.0)):
            mb = env("PURLIN", (xa + xb) / 2, (ya + yb) / 2, coll)
            za = H + 0.45 + 0.3
            mb.add(sweep([(xa, ya, za), (xb, yb, za)], radius=0.025, seg=6, caps=False), None, "steel_dark")
            mb.add(sweep([(xa, yb, za), (xb, ya, za)], radius=0.025, seg=6, caps=False), None, "steel_dark")


# ----------------------------------------------------------------------------- crane
def build_crane():
    """20 t double-girder overhead travelling crane over the press line."""
    coll = "PRESS_SHOP"
    z_rail = 9.6
    ya, yb = -34.6, -13.4
    x0, x1 = 20.0, 55.0           # crane bay over the tandem line and the coil store
    for y in (ya, yb):
        mb = env("CRANERUN", (x0 + x1) / 2, y, coll)
        mb.add(ibeam(1.0, 0.4, 0.02, 0.035), between((x0, y, z_rail - 0.5), (x1, y, z_rail - 0.5)), "struct_blue")
        mb.add(box(), T((x0 + x1) / 2, y, z_rail + 0.06) @ S(x1 - x0, 0.08, 0.12), "rail_steel")
        for x in SITE["x_lines"]:
            if x0 <= x <= x1:
                cy = SITE["y0"] if y < -20 else -12.0
                mb.add(box(), T(x, (y + cy) / 2, z_rail - 1.15) @ S(0.4, abs(y - cy) + 0.3, 0.6), "struct_blue")
    # crane bridge
    xb = 51.5
    g = Group(T(0, 0, 0), collection(coll), "press", None)
    p = g.part("CRANE_BRIDGE_GIRDERS", "safety_yellow")
    for dx in (-0.9, 0.9):
        p.add(rbox(0.7, yb - ya + 0.8, 1.3, 0.03), T(xb + dx, (ya + yb) / 2, z_rail + 0.95))
    p.add(rbox(2.6, 0.9, 0.9, 0.04), T(xb, ya, z_rail + 0.55))
    p.add(rbox(2.6, 0.9, 0.9, 0.04), T(xb, yb, z_rail + 0.55))
    p.done(label="Overhead crane bridge, 20 t", role="crane")
    p = g.part("CRANE_TROLLEY_HOIST", "dark_grey")
    yt = -22.0
    p.add(rbox(2.6, 2.4, 0.9, 0.05), T(xb, yt, z_rail + 2.05))
    p.add(fcyl(0.45, 1.6, 0.04), T(xb, yt, z_rail + 1.5) @ Rx(90))
    p.done(label="Crane trolley and hoist", role="crane")
    p = g.part("CRANE_HOOK_BLOCK", "safety_yellow")
    zh = 6.6
    p.add(rbox(0.7, 0.35, 0.8, 0.05), T(xb, yt, zh + 0.4))
    p.add(torus(0.18, 0.05, 20, 8, 0, 300), T(xb, yt, zh - 0.25) @ Rx(90))
    p.done(label="Crane hook block", role="crane")
    p = g.part("CRANE_ROPES", "steel_dark")
    for dx in (-0.2, 0.2):
        p.add(cyl(0.018, z_rail + 1.5 - (zh + 0.8), 6), T(xb + dx, yt, (z_rail + 1.5 + zh + 0.8) / 2))
    p.done()


# ----------------------------------------------------------------------------- walls
def _wall_run(mb_get, a, b, z0, z1, openings, mat, thickness=0.25, uv_tile=1.0):
    """A wall from a to b (horizontal), height z0..z1, with rectangular openings.

    openings: list of (s0, s1, zlo, zhi) along the wall's length from a.
    """
    a = np.asarray(a, float); b = np.asarray(b, float)
    L = float(np.linalg.norm(b - a))
    d = (b - a) / L
    ang = math.degrees(math.atan2(d[1], d[0]))
    # split the run into vertical strips at opening edges
    cuts = sorted({0.0, L, *[o[0] for o in openings], *[o[1] for o in openings]})
    for s0, s1 in zip(cuts[:-1], cuts[1:]):
        if s1 - s0 < 1e-3:
            continue
        mid = (s0 + s1) / 2
        holes = [o for o in openings if o[0] <= mid <= o[1]]
        spans = [(z0, z1)]
        for (_, _, zlo, zhi) in holes:
            new = []
            for (p, q) in spans:
                if zhi <= p or zlo >= q:
                    new.append((p, q))
                else:
                    if zlo > p:
                        new.append((p, zlo))
                    if zhi < q:
                        new.append((zhi, q))
            spans = new
        for (p, q) in spans:
            c = a + d * mid
            M = T(c[0], c[1], (p + q) / 2) @ Rz(ang) @ S(s1 - s0, thickness, q - p)
            mb_get(c[0], c[1]).add(box(), M, mat, uv="box", tile=uv_tile)


def build_walls():
    coll = "SITE_WALLS"
    H = SITE["eave"]
    x0, x1, y0, y1 = SITE["x0"], SITE["x1"], SITE["y0"], SITE["y1"]
    getp = lambda x, y: env("WALL", x, y, coll)

    # North wall: precast plinth, cladding, ribbon window, dock doors.
    docks_n = [(10.0, 14.0), (17.0, 21.0), (24.0, 28.0), (31.0, 35.0)]        # x ranges
    doors_n = [(-30.0, -26.0)]                                                   # paint-shop service door
    def north_openings(zlo, zhi):
        return [(x - x0 - 0.0, xx - x0, 0.0, 4.6) for (x, xx) in docks_n + doors_n] + []
    yw = y1 + 0.15
    _wall_run(getp, (x0, yw), (x1, yw), 0.0, 3.0, north_openings(0, 3), "wall_concrete", 0.3, 4.0)
    _wall_run(getp, (x0, yw), (x1, yw), 3.0, 8.4, north_openings(3, 8.4), "cladding", 0.18, 1.0)
    _wall_run(getp, (x0, yw), (x1, yw), 9.8, H + 0.6, [], "cladding", 0.18, 1.0)
    # ribbon window with mullions
    for x in np.arange(x0, x1, 2.0):
        mb = env("WINDOW", x + 1.0, yw, coll)
        mb.add(box(), T(x + 1.0, yw, 9.1) @ S(1.94, 0.04, 1.36), "glass")
        mb.add(box(), T(x, yw, 9.1) @ S(0.08, 0.16, 1.4), "aluminium")
    for z in (8.4, 9.8):
        mb = env("WINDOW", 0.0, yw, coll)
        mb.add(box(), T(0.0, yw, z) @ S(x1 - x0, 0.2, 0.1), "aluminium")
    # dock doors: sectional doors open, dock shelters and bumpers
    for (xa, xb) in docks_n:
        cx = (xa + xb) / 2
        mb = env("DOCK", cx, yw, coll)
        mb.add(box(), T(cx, yw + 0.3, 4.75) @ S(xb - xa + 0.4, 0.5, 0.35), "dark_grey")        # door coil box
        mb.add(rbox(xb - xa + 1.2, 0.6, 0.35, 0.04), T(cx, yw + 0.45, 4.95), "plastic_black")    # shelter head
        for sx in (-1, 1):
            mb.add(rbox(0.35, 0.6, 4.6, 0.04), T(cx + sx * ((xb - xa) / 2 + 0.42), yw + 0.45, 2.5), "plastic_black")
            mb.add(box(), T(cx + sx * 1.2, yw + 0.35, 1.0) @ S(0.25, 0.2, 0.35), "rubber")
        mb.add(box(), T(cx, yw - 1.2, 0.02) @ S(xb - xa - 0.2, 2.4, 0.04), "steel_dark")         # leveller
        mark("hatch", xa=xa, ya=y1 - 4.0, xb=xb, yb=y1 - 2.4)
    # paint shop service door (personnel + roller door)
    for (xa, xb) in doors_n:
        mb = env("DOCK", (xa + xb) / 2, yw, coll)
        mb.add(box(), T((xa + xb) / 2, yw, 2.3) @ S(xb - xa, 0.08, 4.6), "panel_white", uv="box", tile=1.0)

    # West wall
    xw = x0 - 0.15
    west_open = [(30.0, 34.0, 0.0, 4.6)]      # utilities door near y = -6..-2
    _wall_run(lambda x, y: env("WALL", x, y, coll), (xw, y0), (xw, y1), 0.0, 3.0, west_open, "wall_concrete", 0.3, 4.0)
    _wall_run(lambda x, y: env("WALL", x, y, coll), (xw, y0), (xw, y1), 3.0, 8.4, west_open, "cladding", 0.18, 1.0)
    _wall_run(lambda x, y: env("WALL", x, y, coll), (xw, y0), (xw, y1), 9.8, H + 0.6, [], "cladding", 0.18, 1.0)
    for y in np.arange(y0, y1, 2.0):
        mb = env("WINDOW", xw, y + 1.0, coll)
        mb.add(box(), T(xw, y + 1.0, 9.1) @ S(0.04, 1.94, 1.36), "glass")
        mb.add(box(), T(xw, y, 9.1) @ S(0.16, 0.08, 1.4), "aluminium")
    for z in (8.4, 9.8):
        mb = env("WINDOW", xw, 0.0, coll)
        mb.add(box(), T(xw, 0.0, z) @ S(0.2, y1 - y0, 0.1), "aluminium")

    # South and east: cut away. A precast upstand, an eave beam and the
    # columns remain, so the building still reads as a building.
    for (a, b) in (((x0, y0 - 0.15), (x1, y0 - 0.15)), ((x1 + 0.15, y0), (x1 + 0.15, y1))):
        _wall_run(lambda x, y: env("WALL", x, y, coll), a, b, 0.0, 0.9,
                  [(14.0, 22.0, 0.0, 0.9)] if a[0] == x1 + 0.15 else [], "precast", 0.3, 4.0)
    for (a, b) in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x0, y1), (x1, y1)), ((x0, y0), (x0, y1))):
        mb = env("STRUCT", (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, coll)
        mb.add(box(), T((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, H + 0.3) @ S(abs(b[0] - a[0]) + 0.4, abs(b[1] - a[1]) + 0.4, 0.6), "struct_white")


# ----------------------------------------------------------------------------- services
def TRAY_PRISM():
    return _cached(("tray",), lambda: prism(chan_profile(0.6, 0.1, 0.004), 1.0))


def build_services():
    """High-bay lights, ventilation ducts, sprinkler mains, cable trays."""
    coll = "SITE_SERVICES"
    H = SITE["eave"]
    x0, x1, y0, y1 = SITE["x0"], SITE["x1"], SITE["y0"], SITE["y1"]
    # continuous LED trunking rows along X, hung from the rafters
    xs = SITE["x_lines"]
    z_led = H - 0.75
    for y in np.arange(y0 + 3.0, y1 - 2.0, 6.0):
        for i in range(len(xs) - 1):
            xa, xb = xs[i] + 0.2, xs[i + 1] - 0.2
            mb = env("LIGHT", (xa + xb) / 2, y, coll)
            mb.add(box(), T((xa + xb) / 2, y, z_led) @ S(xb - xa, 0.09, 0.07), "aluminium")
            mb.add(box(), T((xa + xb) / 2, y, z_led - 0.037) @ S(xb - xa, 0.07, 0.004), "led_white")
        for x in xs:
            env("LIGHT", x, y, coll).add(cyl(0.005, 0.75, 4), T(x, y, z_led + 0.37), "steel_dark")
    # spiral ventilation ducts along X with drops
    for y in (-20.0, 20.0):
        for i in range(len(xs) - 1):
            xa, xb = xs[i] + 0.3, xs[i + 1] - 0.3
            mb = env("DUCT", (xa + xb) / 2, y, coll)
            mb.add(cyl(0.55, xb - xa, 24, caps=False), T((xa + xb) / 2, y, H - 1.8) @ Ry(90), "duct")
            for k in np.arange(xa + 1.0, xb, 2.4):
                mb.add(cyl(0.565, 0.05, 24), T(k, y, H - 1.8) @ Ry(90), "duct")
            xm = (xa + xb) / 2
            mb.add(cyl(0.3, 1.2, 16), T(xm, y, H - 2.9), "duct")
            mb.add(cyl(0.42, 0.18, 16, r_top=0.3), T(xm, y, H - 3.55), "duct")
    # cable trays along the main aisle, both sides
    for y in (-4.2, 4.2):
        for i in range(len(xs) - 1):
            xa, xb = xs[i], xs[i + 1]
            mb = env("TRAY", (xa + xb) / 2, y, coll)
            xm = (xa + xb) / 2
            # channel profile: web (local y) across the tray, flanges (local x) up
            mb.add(TRAY_PRISM(), T(xb, y, 7.6) @ Ry(-90) @ S(1, 1, xb - xa), "galvanized")
            mb.add(box(), T(xm, y, 7.66) @ S(xb - xa, 0.45, 0.08), "cable")
            for k in np.arange(xa + 1.5, xb, 3.0):
                mb.add(cyl(0.008, H - 7.6, 4), T(k, y - 0.32, (H + 7.6) / 2), "steel_dark")
                mb.add(cyl(0.008, H - 7.6, 4), T(k, y + 0.32, (H + 7.6) / 2), "steel_dark")


# ----------------------------------------------------------------------------- outside
def build_apron():
    """Asphalt yard around the hall, slab edge, kerbs, road markings."""
    coll = "SITE_GROUND"
    x0, x1, y0, y1 = SITE["x0"], SITE["x1"], SITE["y0"], SITE["y1"]
    gz = -0.15
    # four asphalt rectangles that meet the slab edge, no overlap with the floor
    rects = [
        (x0 - 12, x1 + 18, y0 - 12, y0 - 0.3),      # south
        (x0 - 12, x1 + 18, y1 + 0.3, y1 + 18),      # north (truck yard)
        (x0 - 12, x0 - 0.3, y0 - 0.3, y1 + 0.3),    # west
        (x1 + 0.3, x1 + 18, y0 - 0.3, y1 + 0.3),    # east (dispatch yard)
    ]
    for i, (a, b, c, d) in enumerate(rects):
        mb = ENV.mb(f"GROUND_ASPHALT_{i}")
        ENV.set_collection(f"GROUND_ASPHALT_{i}", collection(coll))
        mb.add(plane(b - a, d - c), T((a + b) / 2, (c + d) / 2, gz), "asphalt", uv="xy", tile=3.0)
    # slab edge band and kerb
    mb = ENV.mb("GROUND_SLAB")
    ENV.set_collection("GROUND_SLAB", collection(coll))
    W, Hh = x1 - x0, y1 - y0
    mb.add(box(), T(0, 0, -SITE["slab"] / 2 - 0.001) @ S(W + 0.6, Hh + 0.6, SITE["slab"]), "floor_edge")
    for (cx, cy, sx, sy) in (((x0 + x1) / 2 + 3, y0 - 12, W + 30, 0.25), ((x0 + x1) / 2 + 3, y1 + 18, W + 30, 0.25),
                              (x0 - 12, 3, 0.25, Hh + 30), (x1 + 18, 3, 0.25, Hh + 30)):
        mb.add(box(), T(cx, cy, gz + 0.06) @ S(sx, sy, 0.18), "precast")
    # road markings: dashed centre lines and parking bays (thin boxes, 25 mm proud)
    mbm = ENV.mb("GROUND_MARKING")
    ENV.set_collection("GROUND_MARKING", collection(coll))
    for x in np.arange(x0 - 8, x1 + 14, 4.0):
        mbm.add(box(), T(x, y0 - 6.0, gz + 0.012) @ S(2.0, 0.15, 0.025), "white_paint")
        mbm.add(box(), T(x, y1 + 9.0, gz + 0.012) @ S(2.0, 0.15, 0.025), "white_paint")
    for y in np.arange(y0 + 2, y1 - 1, 3.0):
        mbm.add(box(), T(x1 + 9.0, y, gz + 0.012) @ S(5.0, 0.12, 0.025), "white_paint")
    mbm.add(box(), T(x1 + 6.5, 0.0, gz + 0.012) @ S(0.12, y1 - y0 - 2, 0.025), "white_paint")


def build_site():
    build_columns()
    build_trusses()
    build_walls()
    build_services()
    build_crane()
    build_apron()
