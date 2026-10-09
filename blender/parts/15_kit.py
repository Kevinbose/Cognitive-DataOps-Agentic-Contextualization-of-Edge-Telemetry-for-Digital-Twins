# =============================================================================
#  Kit: reusable industrial details (text, hulls, bolts, rails, ladders, stairs)
# =============================================================================

def text_prim(text, size=0.3, depth=0.01):
    """Extruded text in the XY plane, facing +Z, centred. Flat-shaded."""
    key = ("text", text, round(size, 4), round(depth, 4))
    if key in _CACHE:
        return _CACHE[key]
    cu = bpy.data.curves.new("_tmp_text", "FONT")
    cu.body = text
    cu.size = size
    cu.extrude = depth / 2.0
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.resolution_u = 3
    ob = bpy.data.objects.new("_tmp_text", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    V, N, F = [], [], []
    for f in bm.faces:
        n = f.normal
        b = len(V)
        for v in f.verts:
            V.append((v.co.x, v.co.y, v.co.z + depth / 2.0))
            N.append((n.x, n.y, n.z))
        F.append((b, b + 1, b + 2))
    bm.free()
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.curves.remove(cu)
    bpy.data.meshes.remove(me)
    p = Prim(V, N, F) if V else Prim(np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 3), int))
    _CACHE[key] = p
    return p


def hull2d(points):
    """Convex hull (Andrew's monotone chain), counter-clockwise."""
    pts = sorted(set((round(float(x), 6), round(float(y), 6)) for x, y in points))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def circles_hull(circles, seg=28):
    seg = _seg(seg, 8)
    pts = []
    for (cx, cy, r) in circles:
        for i in range(seg):
            a = 2 * math.pi * i / seg
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return hull2d(pts)


def bolt_ring(part, M, radius, n, r_bolt=0.02, h=0.025, seg=6, a0=0.0):
    """Hex-ish bolt heads on a circle in the XY plane of M, standing on z=0."""
    for i in range(n):
        a = math.radians(a0 + 360.0 * i / n)
        part.add(cyl(r_bolt, h, seg), M @ T(radius * math.cos(a), radius * math.sin(a), h / 2))


def handrail(part, pts, height=1.1, post_step=1.6, r=0.021, closed=False, toe=None):
    """Guard rail along a polyline: posts, top rail, knee rail, optional toe board."""
    pts = [np.asarray(p, float) for p in pts]
    if closed:
        pts = pts + [pts[0]]
    for a, b in zip(pts[:-1], pts[1:]):
        L = float(np.linalg.norm(b - a))
        n = max(1, int(math.ceil(L / post_step)))
        for k in range(n + 1):
            p = a + (b - a) * k / n
            part.add(cyl(r, height, 8), T(p[0], p[1], p[2] + height / 2))
        for zz in (height, height * 0.5):
            part.add(sweep([a + (0, 0, zz), b + (0, 0, zz)], radius=r, seg=8, caps=True))
        if toe is not None:
            d = (b - a) / max(L, 1e-9)
            mid = (a + b) / 2
            ang = math.degrees(math.atan2(d[1], d[0]))
            toe.add(box(), T(mid[0], mid[1], mid[2] + 0.075) @ Rz(ang) @ S(L, 0.012, 0.15))


def ladder(part, base, height, facing_deg=0.0, width=0.5, cage=True, cage_from=2.2):
    """Fixed steel ladder with an optional safety cage. Climbing face faces facing_deg."""
    x, y, z = base
    M = T(x, y, z) @ Rz(facing_deg)
    for sx in (-width / 2, width / 2):
        part.add(box(), M @ T(sx, 0, height / 2 + 0.5) @ S(0.06, 0.012, height + 1.0))
    for k in np.arange(0.3, height, 0.28):
        part.add(cyl(0.013, width, 6), M @ T(0, 0, k) @ Ry(90))
    if cage:
        R = 0.36
        for k in np.arange(cage_from, height + 1.0, 0.9):
            part.add(torus(R, 0.012, 16, 4, 180, 360), M @ T(0, -R + 0.05, k))
        for a in (200, 240, 270, 300, 340):
            aa = math.radians(a)
            px, py = R * math.cos(aa), -R + 0.05 + R * math.sin(aa)
            part.add(box(), M @ T(px, py, (cage_from + height + 1.0) / 2) @ S(0.04, 0.008, height + 1.0 - cage_from))


def stair(part, start, direction_deg, rise, width=0.9, going=0.25, riser=0.19, rail=None):
    """Straight steel stair flight: stringers, treads, optional rails."""
    n = max(2, int(round(rise / riser)))
    rr = rise / n
    run = going * n
    M = T(*start) @ Rz(direction_deg)
    for sx in (-width / 2, width / 2):
        L = math.hypot(run, rise)
        ang = math.degrees(math.atan2(rise, run))
        part.add(box(), M @ T(run / 2, sx, rise / 2) @ Ry(-ang) @ S(L + 0.2, 0.012, 0.22))
    for i in range(n):
        part.add(box(), M @ T(going * (i + 0.5), 0, rr * (i + 1) - 0.02) @ S(going, width - 0.03, 0.035))
    if rail is not None:
        for sx in (-width / 2 - 0.03, width / 2 + 0.03):
            a = apply_point(M, (0, sx, 0))
            b = apply_point(M, (run, sx, rise))
            handrail(rail, [a, b], height=1.0, post_step=1.2)


def deck(part, x0, y0, x1, y1, z, frame_part=None, t=0.04):
    """Grating deck (alpha-masked) on a steel edge frame."""
    part.add(plane(x1 - x0, y1 - y0), T((x0 + x1) / 2, (y0 + y1) / 2, z), uv="xy", tile=0.3)
    if frame_part is not None:
        for (cx, cy, sx, sy) in (((x0 + x1) / 2, y0, x1 - x0, 0.08), ((x0 + x1) / 2, y1, x1 - x0, 0.08),
                                 (x0, (y0 + y1) / 2, 0.08, y1 - y0), (x1, (y0 + y1) / 2, 0.08, y1 - y0)):
            frame_part.add(box(), T(cx, cy, z - 0.07) @ S(sx, sy, 0.14))


def sign_board(machine, name, text, at, facing_deg=0.0, width=None, height=0.42, size=0.2,
               board_mat="graphite", text_mat="white_paint", label=None, post=False):
    """Plate with raised lettering (two meshes: board and text)."""
    w = width or (0.13 * size / 0.2 * len(text) + 0.4)
    M = T(*at) @ Rz(facing_deg)
    b = machine.part(name, board_mat)
    b.add(rbox(w, 0.04, height, 0.01), M)
    if post:
        b.add(cyl(0.035, at[2], 8), T(at[0], at[1], at[2] / 2))
    b.done(label=label or text, role="sign")
    t = machine.part(name + "_TEXT", text_mat)
    t.add(text_prim(text, size, 0.012), M @ T(0, -0.021, 0) @ Rx(90))
    t.done()


def zone_sign(title, x, y, z=7.2, facing_deg=0.0, coll="SITE_SIGNS"):
    """Large hanging department sign, readable from the aisle."""
    m = Machine("SIGN_" + clean_name(title) + "_", T(x, y, z) @ Rz(facing_deg), coll, "site")
    w = 0.62 * len(title) + 1.2
    p = m.part("BOARD", "signal_blue")
    p.add(rbox(w, 0.12, 1.3, 0.03), T(0, 0, 0))
    for sx in (-w / 2 + 0.4, w / 2 - 0.4):
        p.add(cyl(0.01, SITE["eave"] - z - 0.6, 4), T(sx, 0, (SITE["eave"] - z) / 2 + 0.3))
    p.done(label=f"{title.capitalize()} sign", role="sign")
    t = m.part("TEXT", "white_paint")
    for side in (-1, 1):
        t.add(text_prim(title, 0.78, 0.02), T(0, side * 0.065, 0) @ Rz(0 if side < 0 else 180) @ Rx(90))
    t.done()
    return m.objects
