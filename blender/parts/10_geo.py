# =============================================================================
#  Geometry kernel
#
#  Every shape is built as numpy arrays (vertices, analytic normals, triangles,
#  UVs) and written to Blender in one call per mesh. Analytic normals are set as
#  custom normals, so a rounded edge reads as rounded and a flat face stays flat
#  without relying on auto-smooth, and the glTF export carries them unchanged.
# =============================================================================

# ----------------------------------------------------------------- transforms
def T(x=0.0, y=0.0, z=0.0):
    m = np.eye(4)
    m[0, 3], m[1, 3], m[2, 3] = x, y, z
    return m


def Rx(deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    m = np.eye(4); m[1, 1], m[1, 2], m[2, 1], m[2, 2] = c, -s, s, c
    return m


def Ry(deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    m = np.eye(4); m[0, 0], m[0, 2], m[2, 0], m[2, 2] = c, s, -s, c
    return m


def Rz(deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    m = np.eye(4); m[0, 0], m[0, 1], m[1, 0], m[1, 1] = c, -s, s, c
    return m


def S(x, y=None, z=None):
    y = x if y is None else y
    z = x if z is None else z
    m = np.eye(4); m[0, 0], m[1, 1], m[2, 2] = x, y, z
    return m


def mm(*ms):
    out = np.eye(4)
    for m in ms:
        out = out @ m
    return out


def XF(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    if np.isscalar(scale):
        scale = (scale, scale, scale)
    return T(*loc) @ Rz(rot[2]) @ Ry(rot[1]) @ Rx(rot[0]) @ S(*scale)


def _unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def align_z(d, ref=(0, 0, 1)):
    """Rotation taking +Z to direction d. Local X stays horizontal when possible."""
    d = _unit(d)
    r = np.asarray(ref, float)
    if abs(np.dot(d, _unit(r))) > 0.99:
        r = np.array((1.0, 0.0, 0.0)) if abs(d[0]) < 0.9 else np.array((0.0, 1.0, 0.0))
    x = _unit(np.cross(r, d))
    y = np.cross(d, x)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2] = x, y, d
    return m


def between(p0, p1, ref=(0, 0, 1)):
    """Matrix placing a z in [0, 1] primitive from p0 to p1 (scaled along z)."""
    p0 = np.asarray(p0, float); p1 = np.asarray(p1, float)
    L = float(np.linalg.norm(p1 - p0))
    return T(*p0) @ align_z(p1 - p0, ref) @ S(1, 1, max(L, 1e-6))


def apply_point(M, p):
    return (M @ np.array([p[0], p[1], p[2], 1.0]))[:3]


# ----------------------------------------------------------------- primitives
class Prim:
    __slots__ = ("V", "N", "F", "UV")

    def __init__(self, V, N, F, UV=None):
        self.V = np.asarray(V, float)
        self.N = np.asarray(N, float)
        self.F = np.asarray(F, np.int64).reshape(-1, 3)
        self.UV = None if UV is None else np.asarray(UV, float)


def _concat(prims):
    V, N, F, UV, off = [], [], [], [], 0
    for p in prims:
        V.append(p.V); N.append(p.N); F.append(p.F + off)
        UV.append(p.UV if p.UV is not None else np.zeros((len(p.V), 2)))
        off += len(p.V)
    return Prim(np.concatenate(V), np.concatenate(N), np.concatenate(F), np.concatenate(UV))


_BOX = None


def box():
    """Unit cube centred on the origin (size 1). Scale it with S()."""
    global _BOX
    if _BOX is None:
        V, N, F, UV = [], [], [], []
        for n, u, v in (((1, 0, 0), (0, 1, 0), (0, 0, 1)), ((-1, 0, 0), (0, -1, 0), (0, 0, 1)),
                        ((0, 1, 0), (-1, 0, 0), (0, 0, 1)), ((0, -1, 0), (1, 0, 0), (0, 0, 1)),
                        ((0, 0, 1), (1, 0, 0), (0, 1, 0)), ((0, 0, -1), (1, 0, 0), (0, -1, 0))):
            n, u, v = np.array(n, float), np.array(u, float), np.array(v, float)
            b = len(V)
            for su, sv in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                V.append(0.5 * (n + u * su + v * sv)); N.append(n); UV.append(((su + 1) / 2, (sv + 1) / 2))
            F += [(b, b + 1, b + 2), (b, b + 2, b + 3)]
        _BOX = Prim(V, N, F, UV)
    return _BOX


def rbox(sx, sy, sz, r=0.02, seg=1):
    """Box of size (sx, sy, sz) centred on the origin with rounded edges of radius r.

    seg is the number of facets per 45 degrees of the edge round. The normals
    are analytic, so even seg=1 reads as a soft machined edge.
    """
    h = np.array([sx, sy, sz], float) / 2.0
    seg = max(1, int(round(seg * LOD[-1])))
    r = float(min(max(r, 1e-4), h.min() * 0.98))
    a = h - r
    V, N, F, UV = [], [], [], []
    for k in range(3):
        i, j = [(1, 2), (2, 0), (0, 1)][k]
        for s in (1.0, -1.0):
            ci = [-h[i] + r * t / seg for t in range(seg)] + [-a[i], a[i]] + [a[i] + r * t / seg for t in range(1, seg + 1)]
            cj = [-h[j] + r * t / seg for t in range(seg)] + [-a[j], a[j]] + [a[j] + r * t / seg for t in range(1, seg + 1)]
            n = len(ci)
            gi, gj = np.meshgrid(ci, cj, indexing="ij")
            P = np.zeros((n, n, 3))
            P[..., i] = gi; P[..., j] = gj; P[..., k] = s * h[k]
            P = P.reshape(-1, 3)
            inner = np.clip(P, -a, a)
            d = P - inner
            dl = np.linalg.norm(d, axis=1, keepdims=True)
            nrm = d / np.maximum(dl, 1e-12)
            Q = inner + nrm * r
            b = len(V) and sum(len(x) for x in V)
            V.append(Q); N.append(nrm)
            UV.append(np.stack([(gi.ravel() + h[i]) / (2 * h[i]), (gj.ravel() + h[j]) / (2 * h[j])], 1))
            idx = np.arange(n * n).reshape(n, n) + b
            q00, q10, q11, q01 = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
            if s > 0:
                F.append(np.stack([q00, q10, q11], 1)); F.append(np.stack([q00, q11, q01], 1))
            else:
                F.append(np.stack([q00, q11, q10], 1)); F.append(np.stack([q00, q01, q11], 1))
    return Prim(np.concatenate(V), np.concatenate(N), np.concatenate(F), np.concatenate(UV))


def lathe(profile, seg=24, smooth_deg=35.0, a0=0.0, a1=360.0, closed=False):
    """Revolve a (radius, z) profile around Z.

    The profile runs so that the solid lies on its left: bottom centre outward,
    up the outside, back to the top centre. Corners sharper than smooth_deg
    stay crisp; gentler ones are smoothed.
    """
    P = np.asarray(profile, float)
    k = len(P)
    ang = np.radians(np.linspace(a0, a1, seg + 1))
    ca, sa = np.cos(ang), np.sin(ang)
    d = P[1:] - P[:-1]
    L = np.linalg.norm(d, axis=1)
    segN = np.stack([d[:, 1], -d[:, 0]], 1) / np.maximum(L, 1e-12)[:, None]
    lim = math.cos(math.radians(smooth_deg))
    lens = np.concatenate([[0.0], np.cumsum(L)])
    total = lens[-1] if lens[-1] > 0 else 1.0
    nseg = k - 1

    def nb(idx):
        if closed:
            idx %= nseg
        return idx if 0 <= idx < nseg and L[idx] > 1e-12 else None

    V, N, F, UV = [], [], [], []
    base = 0
    u = np.linspace(0, 1, seg + 1)
    for i in range(nseg):
        if L[i] <= 1e-12:
            continue
        ends = []
        for other in (nb(i - 1), nb(i + 1)):
            n_i = segN[i]
            if other is not None and np.dot(n_i, segN[other]) >= lim:
                s_ = n_i + segN[other]
                ends.append(s_ / np.linalg.norm(s_))
            else:
                ends.append(n_i)
        (rA, zA), (rB, zB) = P[i], P[i + 1]
        nA, nB = ends
        for (rr, zz, nn, vv) in ((rA, zA, nA, lens[i]), (rB, zB, nB, lens[i + 1])):
            V.append(np.stack([rr * ca, rr * sa, np.full(seg + 1, zz)], 1))
            N.append(np.stack([nn[0] * ca, nn[0] * sa, np.full(seg + 1, nn[1])], 1))
            UV.append(np.stack([u, np.full(seg + 1, vv / total)], 1))
        a_ = base + np.arange(seg)
        b_ = a_ + 1
        c_ = base + seg + 1 + np.arange(seg) + 1
        d_ = base + seg + 1 + np.arange(seg)
        if rA > 1e-9:
            F.append(np.stack([a_, b_, c_], 1))
        if rB > 1e-9:
            F.append(np.stack([a_, c_, d_], 1))
        base += 2 * (seg + 1)
    return Prim(np.concatenate(V), np.concatenate(N), np.concatenate(F), np.concatenate(UV))


_CACHE = {}

# Level of detail: 1.0 for the instrumented machines, 0.5 for background
# machinery. Scales circle segment counts and fillet steps (see low_detail).
LOD = [1.0]


class low_detail:
    def __init__(self, factor=0.5):
        self.factor = factor

    def __enter__(self):
        LOD.append(self.factor)

    def __exit__(self, *exc):
        LOD.pop()


def _seg(n, minimum=6):
    return max(minimum, int(round(n * LOD[-1])))


def _cached(key, fn):
    p = _CACHE.get(key)
    if p is None:
        p = fn()
        _CACHE[key] = p
    return p


def cyl(r, h, seg=24, r_top=None, caps=True):
    """Cylinder (or frustum) along Z, centred on the origin."""
    rt = r if r_top is None else r_top
    seg = _seg(seg)
    key = ("cyl", round(r, 5), round(h, 5), seg, round(rt, 5), caps)

    def make():
        prof = [(r, -h / 2), (rt, h / 2)]
        if caps:
            prof = [(0.0, -h / 2)] + prof + [(0.0, h / 2)]
        return lathe(prof, seg, smooth_deg=20.0)
    return _cached(key, make)


def fcyl(r, h, fillet=0.02, seg=24, fseg=3):
    """Cylinder with rounded rims, along Z, centred on the origin."""
    seg = _seg(seg)
    fseg = max(1, int(round(fseg * LOD[-1])))
    key = ("fcyl", round(r, 5), round(h, 5), round(fillet, 5), seg, fseg)

    def make():
        f = min(fillet, r * 0.45, h * 0.45)
        prof = [(0.0, -h / 2), (r - f, -h / 2)]
        for t in range(1, fseg + 1):
            a = math.radians(-90 + 90 * t / fseg)
            prof.append((r - f + f * math.cos(a), -h / 2 + f + f * math.sin(a)))
        for t in range(0, fseg + 1):
            a = math.radians(90 * t / fseg)
            prof.append((r - f + f * math.cos(a), h / 2 - f + f * math.sin(a)))
        prof.append((0.0, h / 2))
        return lathe(prof, seg, smooth_deg=40.0)
    return _cached(key, make)


def tube(r_out, r_in, h, seg=24):
    """Hollow cylinder (ring) along Z, centred."""
    seg = _seg(seg)
    key = ("tube", round(r_out, 5), round(r_in, 5), round(h, 5), seg)
    return _cached(key, lambda: lathe([(r_in, -h / 2), (r_out, -h / 2), (r_out, h / 2), (r_in, h / 2), (r_in, -h / 2)],
                                     seg, smooth_deg=20.0))


def sphere(r, seg=24, rings=12):
    seg, rings = _seg(seg), _seg(rings, 4)
    key = ("sph", round(r, 5), seg, rings)

    def make():
        prof = [(r * math.cos(math.radians(-90 + 180 * t / rings)), r * math.sin(math.radians(-90 + 180 * t / rings)))
                for t in range(rings + 1)]
        prof[0] = (0.0, -r); prof[-1] = (0.0, r)
        return lathe(prof, seg, smooth_deg=89.0)
    return _cached(key, make)


def dome(r, h, seg=24, rings=6):
    """Cap of an ellipsoid: base circle radius r at z=0 rising to height h."""
    seg, rings = _seg(seg), _seg(rings, 2)
    key = ("dome", round(r, 5), round(h, 5), seg, rings)

    def make():
        prof = [(0.0, 0.0), (r, 0.0)]
        for t in range(1, rings + 1):
            a = math.radians(90 * t / rings)
            prof.append((r * math.cos(a), h * math.sin(a)))
        prof[-1] = (0.0, h)
        return lathe(prof, seg, smooth_deg=50.0)
    return _cached(key, make)


def torus(R, r, seg=32, segr=12, a0=0.0, a1=360.0):
    seg, segr = _seg(seg), _seg(segr, 4)
    key = ("tor", round(R, 5), round(r, 5), seg, segr, a0, a1)

    def make():
        prof = [(R + r * math.cos(math.radians(-90 - 360 * t / segr)), r * math.sin(math.radians(-90 - 360 * t / segr)))
                for t in range(segr + 1)]
        return lathe(prof, seg, smooth_deg=89.0, a0=a0, a1=a1, closed=True)
    return _cached(key, make)


def _ccw(poly):
    P = np.asarray(poly, float)
    area = 0.5 * np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
    return P if area >= 0 else P[::-1]


def _cap(P2, z, up):
    tris = tessellate_polygon([[Vector((float(x), float(y), 0.0)) for x, y in P2]])
    F = []
    for t in tris:
        a, b, c = P2[t[0]], P2[t[1]], P2[t[2]]
        cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if (cross > 0) == up:
            F.append((t[0], t[1], t[2]))
        else:
            F.append((t[0], t[2], t[1]))
    V = np.column_stack([P2, np.full(len(P2), z)])
    N = np.tile([0.0, 0.0, 1.0 if up else -1.0], (len(P2), 1))
    return Prim(V, N, F, P2.copy())


def prism(poly, h=1.0, smooth_deg=0.0, caps=True, z0=0.0):
    """Extrude a 2D polygon (any winding, may be concave) along Z from z0 to z0+h."""
    P = _ccw(poly)
    n = len(P)
    E = np.roll(P, -1, axis=0) - P
    L = np.linalg.norm(E, axis=1)
    EN = np.stack([E[:, 1], -E[:, 0]], 1) / np.maximum(L, 1e-12)[:, None]
    lim = math.cos(math.radians(smooth_deg)) if smooth_deg > 0 else 2.0
    perim = np.concatenate([[0.0], np.cumsum(L)])
    V, N, F, UV = [], [], [], []
    for i in range(n):
        if L[i] < 1e-12:
            continue
        j = (i + 1) % n
        nA = EN[i]; nB = EN[i]
        if np.dot(EN[i], EN[i - 1]) >= lim:
            s_ = EN[i] + EN[i - 1]; nA = s_ / np.linalg.norm(s_)
        if np.dot(EN[i], EN[j]) >= lim:
            s_ = EN[i] + EN[j]; nB = s_ / np.linalg.norm(s_)
        b = sum(len(x) for x in V)
        quad = np.array([[P[i][0], P[i][1], z0], [P[j][0], P[j][1], z0], [P[j][0], P[j][1], z0 + h], [P[i][0], P[i][1], z0 + h]])
        V.append(quad)
        N.append(np.array([[nA[0], nA[1], 0], [nB[0], nB[1], 0], [nB[0], nB[1], 0], [nA[0], nA[1], 0]], float))
        UV.append(np.array([[perim[i], z0], [perim[i + 1], z0], [perim[i + 1], z0 + h], [perim[i], z0 + h]]))
        F.append(np.array([[b, b + 1, b + 2], [b, b + 2, b + 3]]))
    side = Prim(np.concatenate(V), np.concatenate(N), np.concatenate(F), np.concatenate(UV))
    if not caps:
        return side
    return _concat([side, _cap(P, z0, False), _cap(P, z0 + h, True)])


def plane(sx, sy):
    """Single quad in XY at z=0, facing +Z, centred."""
    V = [(-sx / 2, -sy / 2, 0), (sx / 2, -sy / 2, 0), (sx / 2, sy / 2, 0), (-sx / 2, sy / 2, 0)]
    return Prim(V, [(0, 0, 1)] * 4, [(0, 1, 2), (0, 2, 3)], [(0, 0), (1, 0), (1, 1), (0, 1)])


def grid_plane(sx, sy, nx, ny, height_fn=None):
    """Subdivided XY plane, optionally displaced in Z by height_fn(x, y)."""
    xs = np.linspace(-sx / 2, sx / 2, nx + 1)
    ys = np.linspace(-sy / 2, sy / 2, ny + 1)
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    gz = np.zeros_like(gx) if height_fn is None else height_fn(gx, gy)
    V = np.stack([gx, gy, gz], -1).reshape(-1, 3)
    dzdx = np.gradient(gz, xs, axis=0) if nx > 0 else np.zeros_like(gz)
    dzdy = np.gradient(gz, ys, axis=1) if ny > 0 else np.zeros_like(gz)
    N = np.stack([-dzdx, -dzdy, np.ones_like(gz)], -1).reshape(-1, 3)
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    idx = np.arange((nx + 1) * (ny + 1)).reshape(nx + 1, ny + 1)
    a, b, c, d = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel(), idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
    F = np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)])
    UV = np.stack([(gx.ravel() + sx / 2) / sx, (gy.ravel() + sy / 2) / sy], 1)
    return Prim(V, N, F, UV)


def fillet_path(pts, radius, seg=6):
    """Round the corners of a polyline with quadratic arcs of roughly `radius`."""
    pts = [np.asarray(p, float) for p in pts]
    if len(pts) < 3 or radius <= 0:
        return np.array(pts)
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b, c = pts[i - 1], pts[i], pts[i + 1]
        d1, d2 = _unit(b - a), _unit(c - b)
        cosang = float(np.clip(np.dot(d1, d2), -1, 1))
        turn = math.acos(cosang)
        if turn < 1e-3:
            out.append(b); continue
        t = radius * math.tan(turn / 2)
        t = min(t, 0.49 * np.linalg.norm(b - a), 0.49 * np.linalg.norm(c - b))
        p1, p2 = b - d1 * t, b + d2 * t
        for k in range(seg + 1):
            s = k / seg
            out.append((1 - s) ** 2 * p1 + 2 * (1 - s) * s * b + s ** 2 * p2)
    out.append(pts[-1])
    return np.array(out)


def sweep(path, radius=0.05, seg=12, profile=None, caps=True, smooth_deg=40.0, up=(0, 0, 1)):
    """Sweep a closed 2D profile (default: a circle of `radius`) along a 3D polyline."""
    path = np.asarray(path, float)
    m = len(path)
    seg = _seg(seg, 5)
    if profile is None:
        ang = np.linspace(0, 2 * math.pi, seg, endpoint=False)
        prof = np.stack([radius * np.cos(ang), radius * np.sin(ang)], 1)
        pn = np.stack([np.cos(ang), np.sin(ang)], 1)
        smooth_all = True
    else:
        prof = _ccw(profile)
        smooth_all = False
    tan = np.zeros_like(path)
    tan[1:-1] = path[2:] - path[:-2]
    tan[0] = path[1] - path[0]
    tan[-1] = path[-1] - path[-2]
    tan /= np.maximum(np.linalg.norm(tan, axis=1, keepdims=True), 1e-12)
    ref = np.asarray(up, float)
    if abs(np.dot(tan[0], _unit(ref))) > 0.99:
        ref = np.array((1.0, 0.0, 0.0)) if abs(tan[0][0]) < 0.9 else np.array((0.0, 1.0, 0.0))
    nrm = [_unit(np.cross(ref, tan[0]))]
    for i in range(1, m):
        t0, t1 = tan[i - 1], tan[i]
        axis = np.cross(t0, t1)
        s = np.linalg.norm(axis)
        n_prev = nrm[-1]
        if s < 1e-9:
            nrm.append(n_prev)
            continue
        axis /= s
        ang_ = math.atan2(s, float(np.dot(t0, t1)))
        c, sn = math.cos(ang_), math.sin(ang_)
        n_new = n_prev * c + np.cross(axis, n_prev) * sn + axis * np.dot(axis, n_prev) * (1 - c)
        nrm.append(_unit(n_new - tan[i] * np.dot(n_new, tan[i])))
    nrm = np.array(nrm)
    bin_ = np.cross(tan, nrm)
    k = len(prof)
    lens = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
    V, N, F, UV = [], [], [], []
    if smooth_all:
        cols = np.vstack([prof, prof[:1]])
        ncols = np.vstack([pn, pn[:1]])
        nc = k + 1
        for i in range(m):
            V.append(path[i] + cols[:, :1] * nrm[i] + cols[:, 1:2] * bin_[i])
            N.append(ncols[:, :1] * nrm[i] + ncols[:, 1:2] * bin_[i])
            UV.append(np.stack([np.linspace(0, 1, nc), np.full(nc, lens[i])], 1))
        idx = np.arange(m * nc).reshape(m, nc)
        a, b = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel()
        c, d = idx[1:, 1:].ravel(), idx[1:, :-1].ravel()
        F = [np.stack([a, b, c], 1), np.stack([a, c, d], 1)]
        body = Prim(np.concatenate(V), np.concatenate(N), np.concatenate(F), np.concatenate(UV))
    else:
        E = np.roll(prof, -1, axis=0) - prof
        EL = np.linalg.norm(E, axis=1)
        EN = np.stack([E[:, 1], -E[:, 0]], 1) / np.maximum(EL, 1e-12)[:, None]
        lim = math.cos(math.radians(smooth_deg))
        prims = []
        for e in range(k):
            j = (e + 1) % k
            nA = EN[e]; nB = EN[e]
            if np.dot(EN[e], EN[e - 1]) >= lim:
                nA = _unit(EN[e] + EN[e - 1])
            if np.dot(EN[e], EN[j]) >= lim:
                nB = _unit(EN[e] + EN[j])
            Vs, Ns = [], []
            for i in range(m):
                Vs.append([path[i] + prof[e][0] * nrm[i] + prof[e][1] * bin_[i],
                           path[i] + prof[j][0] * nrm[i] + prof[j][1] * bin_[i]])
                Ns.append([nA[0] * nrm[i] + nA[1] * bin_[i], nB[0] * nrm[i] + nB[1] * bin_[i]])
            Vs = np.array(Vs).reshape(-1, 3); Ns = np.array(Ns).reshape(-1, 3)
            idx = np.arange(m * 2).reshape(m, 2)
            a, b, c, d = idx[:-1, 0], idx[:-1, 1], idx[1:, 1], idx[1:, 0]
            uv = np.stack([np.tile([0.0, 1.0], m), np.repeat(lens, 2)], 1)
            prims.append(Prim(Vs, Ns, np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)]), uv))
        body = _concat(prims)
    if not caps:
        return body
    capv = []
    for i, sgn in ((0, -1.0), (m - 1, 1.0)):
        tris = tessellate_polygon([[Vector((float(x), float(y), 0.0)) for x, y in prof]])
        P3 = path[i] + prof[:, :1] * nrm[i] + prof[:, 1:2] * bin_[i]
        Fc = []
        for t in tris:
            a, b, c = P3[t[0]], P3[t[1]], P3[t[2]]
            if np.dot(np.cross(b - a, c - a), tan[i]) * sgn >= 0:
                Fc.append((t[0], t[1], t[2]))
            else:
                Fc.append((t[0], t[2], t[1]))
        capv.append(Prim(P3, np.tile(tan[i] * sgn, (k, 1)), Fc, prof.copy()))
    return _concat([body] + capv)


def ibeam_profile(h, b, tw, tf):
    """I/H section, height h along local Y, flange width b along local X."""
    return [(-b / 2, -h / 2), (b / 2, -h / 2), (b / 2, -h / 2 + tf), (tw / 2, -h / 2 + tf),
            (tw / 2, h / 2 - tf), (b / 2, h / 2 - tf), (b / 2, h / 2), (-b / 2, h / 2),
            (-b / 2, h / 2 - tf), (-tw / 2, h / 2 - tf), (-tw / 2, -h / 2 + tf), (-b / 2, -h / 2 + tf)]


def ibeam(h, b, tw, tf):
    """Unit-length (z 0..1) I-beam; place with between()."""
    key = ("ibeam", h, b, tw, tf)
    return _cached(key, lambda: prism(ibeam_profile(h, b, tw, tf), 1.0))


def chan_profile(h, b, t):
    return [(0, -h / 2), (b, -h / 2), (b, -h / 2 + t), (t, -h / 2 + t), (t, h / 2 - t), (b, h / 2 - t), (b, h / 2), (0, h / 2)]


def angle_profile(a, t):
    return [(0, 0), (a, 0), (a, t), (t, t), (t, a), (0, a)]


def rect_profile(w, h):
    return [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]


def round_rect_profile(w, h, r, seg=3):
    r = min(r, w / 2 * 0.99, h / 2 * 0.99)
    pts = []
    for cx, cy, a0 in ((w / 2 - r, -h / 2 + r, -90), (w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180)):
        for t in range(seg + 1):
            a = math.radians(a0 + 90 * t / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def circle_profile(r, seg=16):
    return [(r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]


# ----------------------------------------------------------------- UV helpers
def box_uv(V, N, tile):
    ax = np.abs(N).argmax(1)
    u = np.where(ax == 0, V[:, 1], V[:, 0])
    v = np.where(ax == 2, V[:, 1], V[:, 2])
    return np.stack([u, v], 1) / tile


# ----------------------------------------------------------------- mesh builder
class MB:
    """Accumulates transformed primitives, tagged with a material key."""

    def __init__(self):
        self.parts = []

    def add(self, prim, M=None, mat="steel", uv=None, tile=1.0):
        V, N, F, UV = prim.V, prim.N, prim.F, prim.UV
        if M is not None:
            R = M[:3, :3]
            V = V @ R.T + M[:3, 3]
            try:
                Rinv = np.linalg.inv(R)
            except np.linalg.LinAlgError:
                Rinv = np.linalg.pinv(R)
            N = N @ Rinv
            N = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
            if np.linalg.det(R) < 0:
                F = F[:, ::-1]
        if uv == "box":
            UV = box_uv(V, N, tile)
        elif uv == "xy":
            UV = V[:, :2] / tile
        elif uv == "prim" and UV is not None:
            UV = UV / tile
        elif uv is None:
            UV = None
        self.parts.append((V, N, F, UV, mat))
        return self

    def extend(self, other, M=None):
        for V, N, F, UV, mat in other.parts:
            self.add(Prim(V, N, F, UV), M, mat, uv="prim" if UV is not None else None)
        return self

    @property
    def empty(self):
        return not self.parts

    def triangles(self):
        return sum(len(p[2]) for p in self.parts)

    def by_material(self):
        groups = {}
        for V, N, F, UV, mat in self.parts:
            groups.setdefault(mat, []).append((V, N, F, UV))
        out = {}
        for mat, items in groups.items():
            Vs, Ns, Fs, UVs, off, has_uv = [], [], [], [], 0, any(it[3] is not None for it in items)
            for V, N, F, UV in items:
                Vs.append(V); Ns.append(N); Fs.append(F + off)
                if has_uv:
                    UVs.append(UV if UV is not None else np.zeros((len(V), 2)))
                off += len(V)
            out[mat] = (np.concatenate(Vs), np.concatenate(Ns), np.concatenate(Fs),
                        np.concatenate(UVs) if has_uv else None)
        return out

    def to_objects(self, name, coll, single_name=True):
        """One object per material. With a single material the object is `name`."""
        groups = self.by_material()
        objs = []
        for mat, (V, N, F, UV) in groups.items():
            oname = name if (single_name and len(groups) == 1) else f"{name}_{mat}"
            objs.append(mesh_object(oname, V, N, F, UV, mat, coll))
        return objs


def mesh_data(name, V, N, F, UV=None, mat=None):
    me = bpy.data.meshes.new(name)
    V = np.asarray(V, np.float32)
    F = np.asarray(F, np.int32)
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", V.ravel())
    nt = len(F)
    me.loops.add(nt * 3)
    me.loops.foreach_set("vertex_index", F.ravel())
    me.polygons.add(nt)
    me.polygons.foreach_set("loop_start", np.arange(0, nt * 3, 3, dtype=np.int32))
    me.polygons.foreach_set("loop_total", np.full(nt, 3, dtype=np.int32))
    me.polygons.foreach_set("use_smooth", np.ones(nt, dtype=bool))
    if UV is not None:
        uvl = me.uv_layers.new(name="UVMap")
        uvl.data.foreach_set("uv", np.asarray(UV, np.float32)[F.ravel()].ravel())
    me.update()
    me.validate(clean_customdata=False)
    me.normals_split_custom_set_from_vertices(np.asarray(N, np.float32))
    if mat is not None:
        me.materials.append(material(mat) if isinstance(mat, str) else mat)
    return me


def mesh_object(name, V, N, F, UV, mat, coll):
    name = unique_name(name)
    me = mesh_data(name, V, N, F, UV, mat)
    ob = bpy.data.objects.new(name, me)
    (coll if coll is not None else bpy.context.scene.collection).objects.link(ob)
    STATS["objects"] += 1
    STATS["triangles"] += len(F)
    return ob


def mb_meshes(name, mb):
    """One single-material mesh data-block per material of an MB.

    Shared meshes must be single-material: three.js names an instanced node's
    per-material children after the shared mesh, so a multi-material mesh used
    twice yields duplicate mesh names, and the viewer binds by name.
    """
    out = {}
    for mat, (V, N, F, UV) in mb.by_material().items():
        out[mat] = mesh_data(unique_name(f"{name}_{mat}"), V, N, F, UV, mat)
    return out


def material_suffix(mat):
    return "PAINT" if mat.startswith("carpaint_") else clean_name(mat)


def place_meshes(meshes, name, M, coll, label=None, zone=None, role=None, tags=()):
    """Place a set of shared single-material meshes as uniquely named nodes."""
    objs = []
    coll = coll if not isinstance(coll, str) else collection(coll)
    single = len(meshes) == 1
    Mw = Matrix(np.asarray(M).tolist())
    for mat, me in meshes.items():
        nm = unique_name(name if single else f"{name}_{material_suffix(mat)}")
        ob = bpy.data.objects.new(nm, me)
        ob.matrix_world = Mw
        coll.objects.link(ob)
        STATS["objects"] += 1
        STATS["instances"] += 1
        STATS["triangles"] += len(me.polygons)
        if label:
            register(ob, label, zone or "site", role=role, tags=tags)
        objs.append(ob)
    return objs


def instance(src, name, M, coll):
    """A new object sharing src's mesh: the glTF stores the geometry once."""
    name = unique_name(name)
    ob = bpy.data.objects.new(name, src.data)
    ob.matrix_world = Matrix(np.asarray(M).tolist())
    coll.objects.link(ob)
    STATS["objects"] += 1
    STATS["instances"] += 1
    STATS["triangles"] += len(src.data.polygons)
    return ob


STATS = {"objects": 0, "triangles": 0, "instances": 0}


class Machine:
    """Builds one machine in its own local frame (origin on the floor).

    hero=True:  every part() becomes its own single-material mesh named
                PREFIX + NAME, which is what the viewer selects and binds.
    hero=False: parts merge per material into a few meshes named
                PREFIX_MATERIAL, which keeps draw calls low for scenery.
    """

    def __init__(self, prefix, frame, coll, zone, machine_id=None, hero=True, template=False, into=None):
        self.prefix = prefix
        self.frame = np.asarray(frame, float)
        self.coll = coll if not isinstance(coll, str) else collection(coll)
        self.zone, self.machine_id = zone, machine_id
        # a template (or a machine merged into another's batch) is never hero
        self.template = template or into is not None
        self.hero = hero and not self.template
        self.mb = into.mb if into is not None else (None if self.hero else MB())
        self.objects = []

    def part(self, name, mat, uv=None, tile=1.0):
        return MPart(self, name, mat, uv, tile)

    def world(self, p):
        return apply_point(self.frame, p)

    def finish(self):
        if self.template:
            return []
        if not self.hero and self.mb is not None and not self.mb.empty:
            self.objects += self.mb.to_objects(self.prefix, self.coll, single_name=False)
            self.mb = MB()
        return self.objects


class MPart:
    def __init__(self, machine, name, mat, uv, tile):
        self.m, self.name, self.mat, self.uv, self.tile = machine, name, mat, uv, tile
        self.mb = MB() if machine.hero else machine.mb

    def add(self, prim, M=None, uv=None, tile=None):
        Mw = self.m.frame if M is None else self.m.frame @ M
        self.mb.add(prim, Mw, self.mat, uv=uv if uv is not None else self.uv,
                    tile=tile if tile is not None else self.tile)
        return self

    def done(self, label=None, role=None, tags=(), channel=None):
        if not self.m.hero or self.mb.empty:
            return None
        ob = self.mb.to_objects(self.m.prefix + self.name, self.m.coll)[0]
        if label:
            register(ob, label, self.m.zone, machine=self.m.machine_id, role=role, tags=tags, channel=channel)
        self.m.objects.append(ob)
        return ob


def Group(frame, coll, zone, machine_id=None):
    """A hero machine with no name prefix (part names are used as given)."""
    return Machine("", frame, coll, zone, machine_id, hero=True)


# ----------------------------------------------------------------- environment batches
class EnvStore:
    """Static scenery merged per (group, material).

    Grouping by area keeps each merged mesh's bounds local, so three.js can
    cull it and a pointer ray only tests the triangles near the pointer.
    """

    def __init__(self):
        self.groups = {}

    def mb(self, group):
        g = self.groups.get(group)
        if g is None:
            g = self.groups[group] = (MB(), None)
        return g[0]

    def set_collection(self, group, coll):
        mb, _ = self.groups.get(group, (MB(), None))
        self.groups[group] = (mb, coll)

    def flush(self, default_coll):
        made = []
        for group, (mb, coll) in self.groups.items():
            if mb.empty:
                continue
            made += mb.to_objects(group, coll or default_coll, single_name=False)
        self.groups = {}
        return made


ENV = EnvStore()


def cell_of(x, y):
    """Structural bay label (column grid 14 m x 18 m) used to group scenery."""
    cx = int(math.floor((x - SITE["x0"]) / 14.0))
    cy = int(math.floor((y - SITE["y0"]) / 18.0))
    return f"C{max(cx, 0):02d}{max(cy, 0):02d}"


def env(kind, x, y, coll_name=None):
    group = f"{kind}_{cell_of(x, y)}"
    mbk = ENV.mb(group)
    if coll_name:
        ENV.set_collection(group, collection(coll_name))
    return mbk
