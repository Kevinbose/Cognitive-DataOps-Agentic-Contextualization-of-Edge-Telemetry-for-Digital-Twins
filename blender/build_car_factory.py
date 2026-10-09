# =============================================================================
#  CAR FACTORY DIGITAL TWIN BUILDER
#  Cognitive DataOps: a car plant at true scale, exported as one .glb
#
#  Blender 4.2 or newer (developed and verified on Blender 5.2 LTS).
#  1 Blender unit = 1 metre. Blender is Z-up; the glTF export is Y-up, so a
#  Blender point (x, y, z) appears in three.js at (x, z, -y).
#
#  Run it either way:
#    GUI:      Scripting workspace > Open > build_car_factory.py > Run Script
#    Headless: blender -b -P build_car_factory.py -- --out <folder>
#
#  Options after "--":
#    --out DIR         where car_factory_updated.glb is written (default: ./out
#                      next to this script, or the .blend's folder)
#    --quality Q       final (default) or draft (no bake, lower texture sizes)
#    --no-export       build the scene only
#    --no-bake         skip the floor ambient-occlusion bake
#    --save-blend      also save car_factory_updated.blend
#    --only ZONES      development: build only some zones, comma separated
#                      (site,press,robot,pressline,body,paint,assembly,
#                       logistics,utilities)
# =============================================================================

import bpy
import bmesh
import math
import os
import sys
import re
import json
import time
import random
import warnings

import numpy as np
from mathutils import Vector, Matrix
from mathutils.geometry import tessellate_polygon

warnings.filterwarnings("ignore", category=DeprecationWarning)

# -----------------------------------------------------------------------------
#  USER ASSETS (optional)
#
#  The script builds every machine procedurally, with exact names and real
#  dimensions, so it needs no downloads. If you have high-resolution models,
#  point these paths at them: each is imported, its origin reset to its
#  geometry, scaled to the real-world size in LAYOUT below, placed, and its
#  meshes renamed to upper case (see place_user_asset).
#
#  Equivalent manual import lines, if you prefer to import by hand first:
#    bpy.ops.import_scene.gltf(filepath=r"C:\assets\robot.glb")
#    bpy.ops.import_scene.gltf(filepath=r"C:\assets\press.glb")
#    bpy.ops.wm.obj_import(filepath=r"C:\assets\fence_panel.obj")
# -----------------------------------------------------------------------------
USER_ASSETS = {
    "robot": None,   # r"C:\assets\robot.glb"   6-axis welding robot
    "press": None,   # r"C:\assets\press.glb"   heavy stamping press
    "fence": None,   # r"C:\assets\fence.glb"   one safety fence panel
}


# -----------------------------------------------------------------------------
#  Arguments
# -----------------------------------------------------------------------------
def _script_argv():
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


def _parse_args():
    import argparse
    p = argparse.ArgumentParser(prog="build_car_factory", add_help=False)
    p.add_argument("--out", default=None)
    p.add_argument("--quality", choices=["final", "draft"], default="final")
    p.add_argument("--no-export", dest="no_export", action="store_true")
    p.add_argument("--no-bake", dest="no_bake", action="store_true")
    p.add_argument("--save-blend", dest="save_blend", action="store_true")
    p.add_argument("--only", default="")
    args, _unknown = p.parse_known_args(_script_argv())
    return args


ARGS = _parse_args()
DRAFT = ARGS.quality == "draft"
ONLY = {z.strip() for z in ARGS.only.split(",") if z.strip()}


def zone_enabled(zone):
    return not ONLY or zone in ONLY


def _default_out_dir():
    if ARGS.out:
        return os.path.abspath(ARGS.out)
    here = None
    try:
        here = os.path.dirname(os.path.abspath(__file__))
    except NameError:
        pass
    if not here or not os.path.isdir(here):
        here = os.path.dirname(bpy.data.filepath) if bpy.data.filepath else os.getcwd()
    return os.path.join(here, "out")


OUT_DIR = _default_out_dir()
TEX_DIR = os.path.join(OUT_DIR, "textures")
GLB_NAME = "car_factory_updated.glb"
os.makedirs(TEX_DIR, exist_ok=True)

T_START = time.time()


def log(msg):
    print(f"[factory {time.time() - T_START:7.1f}s] {msg}", flush=True)


# A fixed seed: the same script always builds the same plant, so mesh names,
# positions and the exported file are reproducible between runs.
RNG = random.Random(20261008)
NPRNG = np.random.default_rng(20261008)


# -----------------------------------------------------------------------------
#  Names
#
#  three.js strips "[ ] . : /" from node names and the viewer binds sensors by
#  the exact mesh name, so every name is upper case A-Z, 0-9 and "_", and is
#  unique. Blender's own ".001" suffixes never occur because names are chosen
#  here, before the data-block exists.
# -----------------------------------------------------------------------------
_USED_NAMES = set()
REGISTRY = []          # one entry per named, bindable or notable mesh


def clean_name(base):
    s = re.sub(r"[^A-Za-z0-9]+", "_", str(base)).strip("_").upper()
    return s or "OBJECT"


def unique_name(base):
    s = clean_name(base)
    name, i = s, 2
    while name in _USED_NAMES or name in bpy.data.objects or name in bpy.data.meshes:
        name = f"{s}_{i}"
        i += 1
    _USED_NAMES.add(name)
    return name


def register(obj, label, zone, machine=None, role=None, tags=(), channel=None):
    """Describe a mesh for the binding UI and the diagnosis agent.

    The same facts are written as glTF extras on the node (three.js exposes
    them as object.userData) and to car_factory_updated.registry.json.
    """
    obj["cdo_label"] = label
    obj["cdo_zone"] = zone
    if machine:
        obj["cdo_machine"] = machine
    if role:
        obj["cdo_role"] = role
    if tags:
        obj["cdo_tags"] = ",".join(tags)
    if channel:
        obj["cdo_suggested_channel"] = channel
    REGISTRY.append({
        "meshName": obj.name, "label": label, "zone": zone, "machineId": machine,
        "role": role, "tags": list(tags), "suggestedChannel": channel,
    })


# -----------------------------------------------------------------------------
#  Scene
# -----------------------------------------------------------------------------
def clear_scene():
    """Remove everything: the default cube, camera and light, and any data."""
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except RuntimeError:
            pass
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images,
                       bpy.data.curves, bpy.data.lights, bpy.data.cameras,
                       bpy.data.node_groups):
        for item in list(datablocks):
            try:
                datablocks.remove(item)
            except (RuntimeError, ReferenceError):
                pass
    scene = bpy.context.scene
    for child in list(scene.collection.children):
        scene.collection.children.unlink(child)
    for c in list(bpy.data.collections):
        if c.users == 0:
            bpy.data.collections.remove(c)
    _USED_NAMES.clear()
    REGISTRY.clear()


def setup_scene():
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"
    return scene


_COLLECTIONS = {}


def collection(name):
    """A collection under the scene root, for the outliner only.

    Collections are not exported as glTF nodes, so they do not change mesh names.
    """
    if name in _COLLECTIONS and _COLLECTIONS[name].name in bpy.data.collections:
        return _COLLECTIONS[name]
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(c)
    _COLLECTIONS[name] = c
    return c


# =============================================================================
# part: 10_geo.py
# =============================================================================
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


# =============================================================================
# part: 15_kit.py
# =============================================================================
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


# =============================================================================
# part: 20_materials.py
# =============================================================================
# =============================================================================
#  Materials
#
#  Physically based, glTF metallic-roughness only, so what Blender shows is what
#  three.js renders. Bare metals keep metalness at or below 0.7: the twin viewer
#  lights the scene with lamps and no environment map, and a fully metallic
#  surface has no diffuse colour, so it would render nearly black there.
#  Colours are sRGB hex, converted to linear for the shader.
# =============================================================================

def srgb_to_linear(c):
    c = max(0.0, min(1.0, c))
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h):
    h = h.lstrip("#")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


# key: base colour, roughness, metalness, plus optional coat, emission, alpha,
# double-sided (ds) and texture generator (tex).
MAT_SPEC = {
    # --- paints (dielectric) ---------------------------------------------------
    "press_blue":     dict(c="#1d5296", r=0.38, m=0.0, coat=0.35, coat_r=0.2),
    "press_grey":     dict(c="#c4c7c2", r=0.45, m=0.0, coat=0.2),
    "machine_grey":   dict(c="#80868b", r=0.5, m=0.05),
    "dark_grey":      dict(c="#3b3f43", r=0.55, m=0.05),
    "graphite":       dict(c="#26292c", r=0.5, m=0.1),
    "robot_orange":   dict(c="#f0641a", r=0.32, m=0.0, coat=0.45, coat_r=0.15),
    "robot_base":     dict(c="#4b5055", r=0.5, m=0.1),
    "robot_white":    dict(c="#e6e7e3", r=0.35, m=0.0, coat=0.4),
    "paint_robot":    dict(c="#d9dbd6", r=0.3, m=0.0, coat=0.3),
    "motor_teal":     dict(c="#1f6c87", r=0.4, m=0.05, coat=0.25),
    # bindable hero parts: neutral, so the viewer's select (teal), warn (amber),
    # alarm and agent (red) tints all read clearly on top of them
    "motor_slate":    dict(c="#5b6670", r=0.38, m=0.15, coat=0.3),
    "filter_silver":  dict(c="#c9cdd0", r=0.3, m=0.35, coat=0.3),
    "lube_grey":      dict(c="#aab0aa", r=0.45, m=0.05, coat=0.2),
    "safety_yellow":  dict(c="#f2bd12", r=0.42, m=0.0, coat=0.15),
    "safety_red":     dict(c="#c4251c", r=0.4, m=0.0, coat=0.2),
    "signal_green":   dict(c="#2e8a3c", r=0.45, m=0.0),
    "signal_blue":    dict(c="#1f5fae", r=0.45, m=0.0),
    "white_paint":    dict(c="#e4e5e0", r=0.55, m=0.0),
    "cabinet_grey":   dict(c="#cdd0cb", r=0.45, m=0.0, coat=0.1),
    "lube_green":     dict(c="#4f7a62", r=0.45, m=0.0, coat=0.2),
    "filter_red":     dict(c="#b5301f", r=0.35, m=0.0, coat=0.35),
    "panel_white":    dict(c="#dcdeda", r=0.6, m=0.0),
    "panel_blue":     dict(c="#2d4f73", r=0.55, m=0.0),
    "door_green":     dict(c="#3d6f4a", r=0.5, m=0.0),
    "ecoat_grey":     dict(c="#3d4146", r=0.45, m=0.0, coat=0.3, ds=True),
    "primer_grey":    dict(c="#9da19d", r=0.55, m=0.0, ds=True),
    # --- metals (moderate metalness, see above) -------------------------------
    "steel":          dict(c="#a3a8ad", r=0.32, m=0.6),
    "steel_dark":     dict(c="#5c6166", r=0.42, m=0.55),
    "galvanized":     dict(c="#a9aeb0", r=0.45, m=0.5),
    "chrome":         dict(c="#d6dadf", r=0.12, m=0.7),
    "die_steel":      dict(c="#566472", r=0.3, m=0.6),
    "cast_iron":      dict(c="#5a5e61", r=0.62, m=0.35),
    "aluminium":      dict(c="#c3c7cb", r=0.3, m=0.65),
    "copper":         dict(c="#b9703f", r=0.3, m=0.7),
    "brass":          dict(c="#b59a52", r=0.3, m=0.7),
    "sheet_steel":    dict(c="#aeb3b7", r=0.28, m=0.6),
    "biw_steel":      dict(c="#9aa0a5", r=0.3, m=0.6, ds=True),
    "rail_steel":     dict(c="#6e7276", r=0.35, m=0.6),
    # --- non-metals -------------------------------------------------------------
    "rubber":         dict(c="#1b1c1e", r=0.85, m=0.0),
    "plastic_black":  dict(c="#202225", r=0.45, m=0.0),
    "cable":          dict(c="#141516", r=0.55, m=0.0),
    "hose_blue":      dict(c="#1f4e9a", r=0.45, m=0.0),
    "hose_red":       dict(c="#a92a22", r=0.45, m=0.0),
    "corrugated":     dict(c="#2a2c2f", r=0.6, m=0.0),
    "glass":          dict(c="#a7c1cf", r=0.05, m=0.0, alpha=0.28, ds=True),
    "glass_dark":     dict(c="#16202a", r=0.06, m=0.25, coat=0.6),
    "screen":         dict(c="#0b1a26", r=0.15, m=0.0, em="#3f8fd0", em_s=0.6),
    "wood":           dict(c="#9c7447", r=0.8, m=0.0),
    "cardboard":      dict(c="#b18656", r=0.85, m=0.0),
    "bin_blue":       dict(c="#2a5ba3", r=0.5, m=0.0),
    "bin_grey":       dict(c="#6f7479", r=0.55, m=0.0),
    "bin_yellow":     dict(c="#e8b416", r=0.5, m=0.0),
    "fabric":         dict(c="#2b2c2f", r=0.9, m=0.0),
    "interior":       dict(c="#323438", r=0.65, m=0.0, ds=True),
    "tire":           dict(c="#161718", r=0.75, m=0.0),
    "rim":            dict(c="#b7bbbf", r=0.25, m=0.6),
    "lens_clear":     dict(c="#e8eef2", r=0.05, m=0.0, em="#ffffff", em_s=0.35),
    "lens_red":       dict(c="#8a0c0c", r=0.1, m=0.0, em="#ff2a1a", em_s=0.6),
    "insulation":     dict(c="#d8d8d2", r=0.7, m=0.0),
    "duct":           dict(c="#b9bdbf", r=0.35, m=0.55),
    "concrete_block": dict(c="#9a9a94", r=0.9, m=0.0),
    "struct_white":   dict(c="#dcdcd3", r=0.5, m=0.1),
    "struct_blue":    dict(c="#2b4c6f", r=0.5, m=0.05),
    "precast":        dict(c="#b9b8b0", r=0.85, m=0.0),
    "floor_edge":     dict(c="#7f7f79", r=0.85, m=0.0),
    "foundation":     dict(c="#8b8b85", r=0.88, m=0.0),
    "water":          dict(c="#2d4a52", r=0.08, m=0.0),
    "steel_coil":     dict(c="#8f969c", r=0.28, m=0.65),
    "grass":          dict(c="#5f7f3c", r=0.95, m=0.0),
    "skin":           dict(c="#b98b69", r=0.6, m=0.0),
    # --- emissive ----------------------------------------------------------------
    "led_white":      dict(c="#ffffff", r=0.3, m=0.0, em="#fff8ec", em_s=2.0),
    "led_red":        dict(c="#7a0a08", r=0.3, m=0.0, em="#ff2318", em_s=1.6),
    "led_amber":      dict(c="#7a4a00", r=0.3, m=0.0, em="#ffa514", em_s=1.0),
    "led_green":      dict(c="#0a5a1a", r=0.3, m=0.0, em="#2bff59", em_s=1.6),
    "led_blue":       dict(c="#0a2a6a", r=0.3, m=0.0, em="#3a7bff", em_s=1.0),
    "lamp_off":       dict(c="#5d6166", r=0.25, m=0.0),
    "lamp_red_off":   dict(c="#5c1713", r=0.2, m=0.0, coat=0.5),
    "lamp_amber_off": dict(c="#6a4610", r=0.2, m=0.0, coat=0.5),
    "weld_glow":      dict(c="#ffd27a", r=0.3, m=0.0, em="#ffb347", em_s=3.0),
    # --- textured (generated in 30_textures) ----------------------------------
    "mesh_panel":     dict(c="#ffffff", r=0.45, m=0.4, tex="tex_wire_mesh", mask=True, ds=True),
    "grating":        dict(c="#ffffff", r=0.5, m=0.4, tex="tex_grating", mask=True, ds=True),
    "hazard":         dict(c="#ffffff", r=0.45, m=0.0, tex="tex_hazard"),
    "cladding":       dict(c="#ffffff", r=0.55, m=0.15, tex="tex_cladding", ds=True),
    "wall_concrete":  dict(c="#ffffff", r=0.9, m=0.0, tex="tex_concrete"),
    "asphalt":        dict(c="#ffffff", r=0.92, m=0.0, tex="tex_asphalt"),
    "roof_panel":     dict(c="#ffffff", r=0.6, m=0.2, tex="tex_roof", ds=True),
}

_MATS = {}


def _bsdf_set(bsdf, names, value):
    for n in names:
        sock = bsdf.inputs.get(n)
        if sock is not None:
            sock.default_value = value
            return sock
    return None


def _new_node_material(name):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if out is None:
        out = nt.nodes.new("ShaderNodeOutputMaterial")
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    return m, nt, bsdf


def material(key):
    """The Blender material for a palette key, created on first use."""
    m = _MATS.get(key)
    if m is not None:
        return m
    spec = MAT_SPEC.get(key)
    if spec is None:
        raise KeyError(f"unknown material key {key!r}")
    m, nt, bsdf = _new_node_material("M_" + clean_name(key))
    col = hex_lin(spec["c"])
    _bsdf_set(bsdf, ["Base Color"], (*col, 1.0))
    _bsdf_set(bsdf, ["Roughness"], spec.get("r", 0.5))
    _bsdf_set(bsdf, ["Metallic"], spec.get("m", 0.0))
    if spec.get("coat"):
        _bsdf_set(bsdf, ["Coat Weight", "Clearcoat"], spec["coat"])
        _bsdf_set(bsdf, ["Coat Roughness", "Clearcoat Roughness"], spec.get("coat_r", 0.1))
    if spec.get("em"):
        _bsdf_set(bsdf, ["Emission Color", "Emission"], (*hex_lin(spec["em"]), 1.0))
        _bsdf_set(bsdf, ["Emission Strength"], spec.get("em_s", 1.0))
    if spec.get("alpha") is not None:
        _bsdf_set(bsdf, ["Alpha"], spec["alpha"])
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(m, attr, val)
            except (AttributeError, TypeError):
                pass
    if spec.get("tex"):
        img = texture_image(spec["tex"])
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        tex.interpolation = "Linear"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if spec.get("mask"):
            rnd = nt.nodes.new("ShaderNodeMath")
            rnd.operation = "ROUND"
            nt.links.new(tex.outputs["Alpha"], rnd.inputs[0])
            nt.links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
            for attr, val in (("surface_render_method", "DITHERED"), ("blend_method", "CLIP")):
                try:
                    setattr(m, attr, val)
                except (AttributeError, TypeError):
                    pass
    m.use_backface_culling = not spec.get("ds", False)
    m.diffuse_color = (*col, spec.get("alpha", 1.0) or 1.0)
    _MATS[key] = m
    return m


def car_paint_key(hex_colour):
    """Register (once) and return a clear-coated car paint material key."""
    key = "carpaint_" + hex_colour.lstrip("#").lower()
    if key not in MAT_SPEC:
        MAT_SPEC[key] = dict(c=hex_colour, r=0.22, m=0.15, coat=1.0, coat_r=0.05, ds=True)
    return key


def image_material(key, img, rough=0.8, metal=0.0, ds=False):
    """A material over a specific image (e.g. a baked floor tile)."""
    if key in _MATS:
        return _MATS[key]
    m, nt, bsdf = _new_node_material("M_" + clean_name(key))
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    _bsdf_set(bsdf, ["Roughness"], rough)
    _bsdf_set(bsdf, ["Metallic"], metal)
    m.use_backface_culling = not ds
    MAT_SPEC.setdefault(key, dict(c="#ffffff", r=rough, m=metal))
    _MATS[key] = m
    return m


# =============================================================================
# part: 30_textures.py
# =============================================================================
# =============================================================================
#  Procedural textures (numpy only, deterministic, no downloads)
#
#  glTF cannot carry Blender's procedural shader nodes, so surface detail is
#  computed here as pixels and saved as small tiling JPEG/PNG files. Values are
#  authored in sRGB (display) space, which is how 8-bit colour images are stored.
# =============================================================================

def tex_size(final, draft):
    return draft if DRAFT else final


def fft_noise(h, w, beta=2.0, seed=0, fmin=0.0):
    """Periodic 1/f^beta noise in [0, 1]. Periodic means it tiles seamlessly."""
    rng = np.random.default_rng(seed)
    spec = np.fft.rfft2(rng.standard_normal((h, w)))
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    spec = spec / f ** (beta / 2.0)
    if fmin > 0:
        spec[f < fmin] = 0
    spec[0, 0] = 0
    out = np.fft.irfft2(spec, s=(h, w))
    lo, hi = np.percentile(out, 0.5), np.percentile(out, 99.5)
    return np.clip((out - lo) / max(hi - lo, 1e-9), 0, 1)


def blur(a, sigma):
    """Periodic gaussian blur (pixels) via FFT."""
    if sigma <= 0:
        return a
    h, w = a.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (math.pi * sigma) ** 2 * (fx * fx + fy * fy))
    if a.ndim == 2:
        return np.fft.irfft2(np.fft.rfft2(a) * g, s=(h, w))
    return np.stack([np.fft.irfft2(np.fft.rfft2(a[..., c]) * g, s=(h, w)) for c in range(a.shape[2])], -1)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def rgb(hexcol):
    h = hexcol.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)


def save_image(name, arr, fmt="JPEG", quality=88):
    """Write an (h, w, 3|4) sRGB array to TEX_DIR and load it back as a file image.

    Loading from a file (rather than packing generated pixels) lets the glTF
    exporter embed the JPEG/PNG bytes as they are, which keeps the .glb small.
    """
    arr = np.clip(np.asarray(arr, np.float32), 0, 1)
    h, w = arr.shape[:2]
    ch = 1 if arr.ndim == 2 else arr.shape[2]
    rgba = np.ones((h, w, 4), np.float32)
    if ch == 1:
        rgba[..., :3] = arr[..., None] if arr.ndim == 2 else arr
    else:
        rgba[..., :ch] = arr
    ext = ".png" if fmt == "PNG" else ".jpg"
    path = os.path.join(TEX_DIR, clean_name(name).lower() + ext)
    tmp = bpy.data.images.new("_tmp_" + name, w, h, alpha=(ch == 4))
    tmp.pixels.foreach_set(np.flipud(rgba).ravel())
    tmp.filepath_raw = path
    tmp.file_format = fmt
    scene = bpy.context.scene
    old_q = scene.render.image_settings.quality
    scene.render.image_settings.quality = quality
    try:
        tmp.save(filepath=path, quality=quality)
    except TypeError:
        tmp.save()
    scene.render.image_settings.quality = old_q
    bpy.data.images.remove(tmp)
    img = bpy.data.images.load(path, check_existing=False)
    img.name = "T_" + clean_name(name)
    return img


_TEX = {}


def texture_image(gen_name):
    img = _TEX.get(gen_name)
    if img is None:
        img = globals()[gen_name]()
        _TEX[gen_name] = img
    return img


# Each generator returns a Blender image. World scale is fixed by the UV tile
# size the geometry uses (noted per texture).

def tex_wire_mesh():
    """Welded wire mesh, 50 mm x 50 mm, 4 mm wire. One tile = 0.40 m."""
    n = 256
    cells = 8
    px = n / cells
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    dx = np.abs(((x + px / 2) % px) - px / 2)
    dy = np.abs(((y + px / 2) % px) - px / 2)
    wire = np.maximum(smoothstep(1.9, 1.0, dx), smoothstep(1.9, 1.0, dy))
    shade = 0.75 + 0.25 * np.maximum(1 - dx / 1.6, 1 - dy / 1.6).clip(0, 1)
    col = rgb("#2c2f33")[None, None, :] * shade[..., None] + 0.08
    return save_image("tex_wire_mesh", np.dstack([col, wire]), fmt="PNG")


def tex_grating():
    """Pressed steel grating, 34 x 76 mm mesh. One tile = 0.30 m."""
    n = 256
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    bear = np.abs(((x + 14) % 29) - 14.5)       # bearing bars along v
    cross = np.abs(((y + 32) % 64) - 32)         # cross bars along u
    solid = np.maximum(smoothstep(3.0, 2.0, bear), smoothstep(2.4, 1.4, cross))
    noise = fft_noise(n, n, 1.6, seed=11)
    col = rgb("#9ea3a6")[None, None, :] * (0.82 + 0.18 * noise[..., None])
    return save_image("tex_grating", np.dstack([col, solid]), fmt="PNG")


def tex_hazard():
    """45 degree yellow and black hazard stripes, 100 mm bands. One tile = 0.40 m."""
    n = 256
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    band = ((x + y) / (n / 2)) % 1.0
    stripe = smoothstep(0.47, 0.53, band) * (1 - smoothstep(0.97, 1.0, band))
    yellow, black = rgb("#efb910"), rgb("#1b1b1b")
    wear = fft_noise(n, n, 1.4, seed=5)
    col = yellow[None, None] * (1 - stripe[..., None]) + black[None, None] * stripe[..., None]
    col = col * (0.88 + 0.12 * wear[..., None])
    return save_image("tex_hazard", col, quality=90)


def tex_cladding():
    """Light grey trapezoidal steel cladding, ribs every 200 mm. One tile = 1.0 m."""
    n = tex_size(512, 256)
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    u = (x / n * 5.0) % 1.0
    # profile: crest 0..0.25, slope, valley, slope; brightness from facet angle
    shade = np.select([u < 0.22, u < 0.32, u < 0.78, u < 0.88],
                      [1.0, 0.78, 0.94, 1.08], 0.94)
    streak = blur(fft_noise(n, n, 1.0, seed=21), 1.0)
    vertical = blur(np.tile(fft_noise(1, n, 1.2, seed=22), (n, 1)), 0.5)
    base = rgb("#cfd3d2")
    col = base[None, None] * shade[..., None] * (0.93 + 0.05 * streak[..., None] + 0.04 * vertical[..., None])
    return save_image("tex_cladding", col, quality=88)


def tex_concrete():
    """Cast concrete: mottling, aggregate, pores. One tile = 4.0 m."""
    n = tex_size(1024, 512)
    big = fft_noise(n, n, 2.4, seed=31)
    mid = fft_noise(n, n, 1.6, seed=32)
    fine = fft_noise(n, n, 0.6, seed=33)
    pores = (fft_noise(n, n, 0.2, seed=34) > 0.93).astype(np.float32)
    v = 0.56 + 0.07 * (big - 0.5) + 0.05 * (mid - 0.5) + 0.04 * (fine - 0.5) - 0.12 * blur(pores, 0.7)
    col = np.dstack([v * 1.0, v * 0.995, v * 0.965])
    return save_image("tex_concrete", col, quality=86)


def tex_asphalt():
    """Asphalt with light aggregate. One tile = 3.0 m."""
    n = tex_size(512, 256)
    big = fft_noise(n, n, 2.2, seed=41)
    fine = fft_noise(n, n, 0.3, seed=42)
    stones = (fine > 0.82).astype(np.float32) * 0.12
    v = 0.17 + 0.04 * (big - 0.5) + 0.05 * (fine - 0.5) + stones
    return save_image("tex_asphalt", np.dstack([v, v, v * 1.02]), quality=86)


def tex_roof():
    """Translucent roof light / sandwich panel strip. One tile = 1.0 m."""
    n = 256
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    rib = 0.9 + 0.1 * np.cos(x / n * 2 * math.pi * 4)
    noise = fft_noise(n, n, 1.5, seed=51)
    v = rib * (0.8 + 0.08 * noise)
    return save_image("tex_roof", np.dstack([v * 0.86, v * 0.88, v * 0.9]), quality=86)


# =============================================================================
# part: 40_site.py
# =============================================================================
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


# =============================================================================
# part: 45_floor.py
# =============================================================================
# =============================================================================
#  Floor: one textured slab per department, with the paint baked into pixels
#
#  Floor paint is rasterised into the texture rather than modelled as thin
#  decals: at the viewer's default distance a few millimetres of offset z-fight,
#  and pixels cannot. Contact shadows under machines are painted the same way
#  (and refined by the ambient-occlusion bake when it runs).
# =============================================================================

FLOOR_FINISH = {
    # zone: base colour (sRGB), mottling strength, roughness
    "press":    ("#8b8c87", 0.10, 0.82),   # power-floated concrete, oiled
    "body":     ("#a2a6a4", 0.06, 0.62),   # sealed concrete
    "paint":    ("#b5b9b6", 0.04, 0.5),    # clean-room epoxy
    "assembly": ("#a9adac", 0.05, 0.55),   # epoxy
}

YELLOW = rgb("#e9b513")
WHITE = rgb("#e9eae4")
GREEN = rgb("#3f8d55")
BLACK = rgb("#1c1c1c")
RED = rgb("#b8312a")
BLUE = rgb("#2d64ad")


class FloorTile:
    def __init__(self, zone):
        z = ZONES[zone]
        self.zone = zone
        self.x0, self.x1, self.y0, self.y1 = z["x0"], z["x1"], z["y0"], z["y1"]
        self.ppm = 14.0 if DRAFT else 36.0
        self.w = int(round((self.x1 - self.x0) * self.ppm))
        self.h = int(round((self.y1 - self.y0) * self.ppm))
        self.img = None
        self.shade = np.ones((self.h, self.w), np.float32)
        self._base()

    # pixel window covering world box, with coordinate grids
    def window(self, xa, ya, xb, yb, pad=0.0):
        j0 = int(math.floor((min(xa, xb) - pad - self.x0) * self.ppm))
        j1 = int(math.ceil((max(xa, xb) + pad - self.x0) * self.ppm))
        i0 = int(math.floor((self.y1 - max(ya, yb) - pad) * self.ppm))
        i1 = int(math.ceil((self.y1 - min(ya, yb) + pad) * self.ppm))
        j0, j1 = max(j0, 0), min(j1, self.w)
        i0, i1 = max(i0, 0), min(i1, self.h)
        if j1 <= j0 or i1 <= i0:
            return None
        X = self.x0 + (np.arange(j0, j1) + 0.5) / self.ppm
        Y = self.y1 - (np.arange(i0, i1) + 0.5) / self.ppm
        GX, GY = np.meshgrid(X, Y)
        return (slice(i0, i1), slice(j0, j1), GX, GY)

    def _base(self):
        col, mot, _ = FLOOR_FINISH[self.zone]
        h, w = self.h, self.w
        seed = {"press": 1, "body": 2, "paint": 3, "assembly": 4}[self.zone]
        big = fft_noise(h, w, 2.6, seed=100 + seed)
        mid = fft_noise(h, w, 1.8, seed=200 + seed)
        fine = fft_noise(h, w, 0.8, seed=300 + seed)
        v = 1.0 + mot * (big - 0.5) * 1.6 + mot * 0.8 * (mid - 0.5) + 0.035 * (fine - 0.5)
        self.rgb = np.clip(rgb(col)[None, None, :] * v[..., None], 0, 1).astype(np.float32)
        # saw-cut contraction joints every 6 m
        GX = self.x0 + (np.arange(w) + 0.5) / self.ppm
        GY = self.y1 - (np.arange(h) + 0.5) / self.ppm
        jx = np.abs(((GX + 3.0) % 6.0) - 3.0)
        jy = np.abs(((GY + 3.0) % 6.0) - 3.0)
        lx = np.clip(1.0 - jx * self.ppm / 1.2, 0, 1)[None, :]
        ly = np.clip(1.0 - jy * self.ppm / 1.2, 0, 1)[:, None]
        joint = np.maximum(lx, ly)
        self.rgb *= (1.0 - 0.28 * joint)[..., None]

    # ---- painting primitives (alpha-blended) ---------------------------------
    def _blend(self, win, cov, color):
        si, sj = win[0], win[1]
        wear = 0.82 + 0.18 * fft_noise_cached(self, cov.shape)
        a = np.clip(cov * wear, 0, 1)[..., None]
        self.rgb[si, sj] = self.rgb[si, sj] * (1 - a) + color[None, None, :] * a * (0.9 + 0.1 * self.rgb[si, sj] / max(self.rgb.mean(), 1e-3))

    def rect(self, xa, ya, xb, yb, color, alpha=1.0, rot=0.0):
        cx, cy = (xa + xb) / 2, (ya + yb) / 2
        hx, hy = abs(xb - xa) / 2, abs(yb - ya) / 2
        r = math.hypot(hx, hy)
        win = self.window(cx - r, cy - r, cx + r, cy + r, 0.1)
        if win is None:
            return
        _, _, GX, GY = win
        c, s = math.cos(math.radians(-rot)), math.sin(math.radians(-rot))
        lx = (GX - cx) * c - (GY - cy) * s
        ly = (GX - cx) * s + (GY - cy) * c
        d = np.maximum(np.abs(lx) - hx, np.abs(ly) - hy)
        self._blend(win, np.clip(0.5 - d * self.ppm, 0, 1) * alpha, color)

    def frame(self, xa, ya, xb, yb, width, color):
        self.line((xa, ya), (xb, ya), width, color)
        self.line((xb, ya), (xb, yb), width, color)
        self.line((xb, yb), (xa, yb), width, color)
        self.line((xa, yb), (xa, ya), width, color)

    def line(self, p0, p1, width, color, dash=None, alpha=1.0):
        (xa, ya), (xb, yb) = p0, p1
        win = self.window(xa, ya, xb, yb, width)
        if win is None:
            return
        _, _, GX, GY = win
        dx, dy = xb - xa, yb - ya
        L2 = dx * dx + dy * dy
        t = np.clip(((GX - xa) * dx + (GY - ya) * dy) / max(L2, 1e-9), 0, 1)
        d = np.hypot(GX - (xa + t * dx), GY - (ya + t * dy))
        cov = np.clip((width / 2 - d) * self.ppm + 0.5, 0, 1)
        if dash:
            L = math.sqrt(L2)
            ph = (t * L) % (dash[0] + dash[1])
            cov *= np.clip((dash[0] - ph) * self.ppm + 0.5, 0, 1)
        self._blend(win, cov * alpha, color)

    def disc(self, cx, cy, r, color, alpha=1.0):
        win = self.window(cx - r, cy - r, cx + r, cy + r, 0.1)
        if win is None:
            return
        _, _, GX, GY = win
        d = np.hypot(GX - cx, GY - cy) - r
        self._blend(win, np.clip(0.5 - d * self.ppm, 0, 1) * alpha, color)

    def ring(self, cx, cy, r, width, color, dash=None):
        win = self.window(cx - r - width, cy - r - width, cx + r + width, cy + r + width)
        if win is None:
            return
        _, _, GX, GY = win
        d = np.abs(np.hypot(GX - cx, GY - cy) - r)
        cov = np.clip((width / 2 - d) * self.ppm + 0.5, 0, 1)
        if dash:
            s = (np.arctan2(GY - cy, GX - cx) + math.pi) * r
            ph = s % (dash[0] + dash[1])
            cov *= np.clip((dash[0] - ph) * self.ppm + 0.5, 0, 1)
        self._blend(win, cov, color)

    def hatch(self, xa, ya, xb, yb, period=0.4, colors=(YELLOW, BLACK)):
        win = self.window(xa, ya, xb, yb, 0.05)
        if win is None:
            return
        _, _, GX, GY = win
        inside = np.clip(0.5 - np.maximum(np.maximum(xa - GX, GX - xb), np.maximum(ya - GY, GY - yb)) * self.ppm, 0, 1)
        band = ((GX + GY) / period) % 1.0
        stripe = np.clip((np.abs(band - 0.5) - 0.25) * self.ppm * period * 2 + 0.5, 0, 1)
        self._blend(win, inside * stripe, colors[1])
        self._blend(win, inside * (1 - stripe), colors[0])

    def arrow(self, x, y, ang, length=2.4, width=0.35, color=WHITE):
        a = math.radians(ang)
        d = np.array([math.cos(a), math.sin(a)])
        p = np.array([x, y])
        self.line(tuple(p - d * length / 2), tuple(p + d * (length / 2 - 0.5)), width, color)
        n = np.array([-d[1], d[0]])
        tip = p + d * length / 2
        for sgn in (-1, 1):
            self.line(tuple(tip), tuple(tip - d * 0.7 + n * sgn * 0.45), width * 0.9, color)

    def stain(self, cx, cy, r, strength=0.35):
        win = self.window(cx - r * 1.5, cy - r * 1.5, cx + r * 1.5, cy + r * 1.5)
        if win is None:
            return
        si, sj, GX, GY = win
        n = fft_noise(GX.shape[0], GX.shape[1], 2.2, seed=int(abs(cx * 13 + cy * 7)) % 9999)
        d = np.hypot(GX - cx, GY - cy) / r
        m = np.clip(1.2 - d + 0.5 * (n - 0.5), 0, 1) ** 1.5 * strength
        self.rgb[si, sj] *= (1 - m)[..., None] * np.array([1.0, 0.98, 0.94])[None, None, :] + m[..., None] * 0.35

    def shadow(self, kind, cx, cy, sx, sy, rot, strength, soft):
        pad = soft * 3 + 0.2
        r = math.hypot(sx, sy) / 2 + pad
        win = self.window(cx - r, cy - r, cx + r, cy + r)
        if win is None:
            return
        si, sj, GX, GY = win
        if kind == "disc":
            d = np.hypot(GX - cx, GY - cy) - sx
        else:
            c, s = math.cos(math.radians(-rot)), math.sin(math.radians(-rot))
            lx = (GX - cx) * c - (GY - cy) * s
            ly = (GX - cx) * s + (GY - cy) * c
            q = np.stack([np.abs(lx) - sx / 2, np.abs(ly) - sy / 2], -1)
            outside = np.linalg.norm(np.maximum(q, 0), axis=-1)
            inside = np.minimum(np.maximum(q[..., 0], q[..., 1]), 0)
            d = outside + inside
        occ = 1.0 / (1.0 + np.exp(d / max(soft * 0.45, 1e-3)))      # soft edge
        self.shade[si, sj] *= (1.0 - strength * occ)

    def finish(self):
        """Apply shading and write the texture."""
        col = self.rgb * self.shade[..., None]
        self.img = save_image(f"floor_{self.zone}", col, quality=90)
        return self.img


_NOISE_CACHE = {}


def fft_noise_cached(tile, shape):
    key = shape
    n = _NOISE_CACHE.get(key)
    if n is None:
        h, w = shape
        n = fft_noise(max(h, 8), max(w, 8), 1.2, seed=(h * 31 + w) % 997)[:h, :w]
        _NOISE_CACHE[key] = n
    return n


FLOOR_TILES = {}


def paint_floor():
    """Rasterise every marking and footprint into the four department tiles."""
    tiles = {z: FloorTile(z) for z in ZONES}
    FLOOR_TILES.update(tiles)
    for kind, kw in MARKINGS:
        for t in tiles.values():
            getattr(t, kind)(**kw)
    for fp in FOOTPRINTS:
        for t in tiles.values():
            t.shadow(*fp)
    return tiles


def build_floor_meshes():
    coll = collection("SITE_GROUND")
    objs = []
    for zone, tile in FLOOR_TILES.items():
        img = tile.finish()
        _, _, rough = FLOOR_FINISH[zone]
        mat = image_material(f"floor_{zone}", img, rough=rough)
        w, h = tile.x1 - tile.x0, tile.y1 - tile.y0
        pr = plane(w, h)
        name = f"FLOOR_{zone.upper()}"
        V = pr.V + np.array([(tile.x0 + tile.x1) / 2, (tile.y0 + tile.y1) / 2, 0.0])
        ob = mesh_object(name, V, pr.N, pr.F, pr.UV, mat, coll)
        register(ob, f"{ZONES[zone]['title'].capitalize()} floor", zone, role="floor")
        objs.append(ob)
    return objs


def standard_markings():
    """Aisles, walkways and zone borders common to the whole hall."""
    x0, x1, y0, y1 = SITE["x0"], SITE["x1"], SITE["y0"], SITE["y1"]
    # main east-west transport aisle, 6 m, yellow edge lines, dashed centre
    for y in (-3.0, 3.0):
        mark("line", p0=(x0 + 0.5, y), p1=(x1 - 0.5, y), width=0.1, color=YELLOW)
    mark("line", p0=(x0 + 2, 0.0), p1=(x1 - 2, 0.0), width=0.1, color=WHITE, dash=(2.0, 2.0))
    # north-south aisle, 5 m
    for x in (-2.5, 2.5):
        mark("line", p0=(x, y0 + 0.5), p1=(x, -3.0), width=0.1, color=YELLOW)
        mark("line", p0=(x, 3.0), p1=(x, y1 - 0.5), width=0.1, color=YELLOW)
    mark("line", p0=(0.0, y0 + 1), p1=(0.0, -3.5), width=0.1, color=WHITE, dash=(2.0, 2.0))
    mark("line", p0=(0.0, 3.5), p1=(0.0, y1 - 1), width=0.1, color=WHITE, dash=(2.0, 2.0))
    # pedestrian walkway, green with white edges, along the south of the main aisle
    for (xa, xb) in ((x0 + 1.0, -3.0), (3.0, x1 - 1.0)):
        mark("rect", xa=xa, ya=-4.6, xb=xb, yb=-3.3, color=GREEN, alpha=0.9)
        mark("line", p0=(xa, -4.6), p1=(xb, -4.6), width=0.08, color=WHITE)
    # zebra crossings where the walkway crosses the N-S aisle
    for i in range(6):
        xx = -2.2 + i * 0.85
        mark("rect", xa=xx, ya=-4.6, xb=xx + 0.45, yb=-3.3, color=WHITE)
    # flow arrows in the aisles
    for x in (-40.0, -20.0, 20.0, 40.0):
        mark("arrow", x=x, y=-1.5, ang=180.0)
        mark("arrow", x=x, y=1.5, ang=0.0)
    # perimeter safety line 1 m inside the walls
    mark("line", p0=(x0 + 1.0, y1 - 1.0), p1=(x1 - 1.0, y1 - 1.0), width=0.1, color=YELLOW)
    mark("line", p0=(x0 + 1.0, y0 + 1.0), p1=(x0 + 1.0, y1 - 1.0), width=0.1, color=YELLOW)


# =============================================================================
# part: 50_press.py
# =============================================================================
# =============================================================================
#  Heavy stamping press (straight-side, double-crank, top drive)
#
#  Hero dimensions (k = 1): 2,500 t, bed 6.8 m x 4.0 m, crown top 5.5 m,
#  main motor top 6.6 m, foundation 8.2 m x 5.4 m. Local frame: origin on the
#  floor at the bed centre, +X right, -Y front (die area, operator side), +Z up.
#  The drive (flywheel, clutch, belt guard) is on the left (-X) end.
# =============================================================================

# extrusion along -X of a profile drawn in (Y, Z)
M_YZ = np.array([[0.0, 0.0, -1.0, 0.0], [1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]])


def press_dims(k):
    zf = 0.12
    zb1 = zf + 1.0 * k
    zbol = zb1 + 0.28 * k
    zld = zbol + 0.5 * k
    zud0 = zld + 0.9 * k
    zud1 = zud0 + 0.55 * k
    zsl1 = zud1 + 0.7 * k
    zc0 = zsl1 + 0.35 * k
    zc1 = zc0 + 1.1 * k
    return dict(zc0=zc0, zc1=zc1, zbr=(zc0 + zc1) / 2, Dc=3.6 * k, Wb=6.8 * k, Db=4.0 * k)


def world_rect(F, x0, y0, x1, y1):
    pts = [apply_point(F, (x, y, 0)) for x in (x0, x1) for y in (y0, y1)]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def press_floor_marks(F, Wf, Df):
    """Hazard band round the foundation and a keep-out line 1 m further out."""
    ax0, ay0, ax1, ay1 = world_rect(F, -Wf / 2, -Df / 2, Wf / 2, Df / 2)
    b = 0.35
    mark("hatch", xa=ax0 - b, ya=ay0 - b, xb=ax1 + b, yb=ay0)
    mark("hatch", xa=ax0 - b, ya=ay1, xb=ax1 + b, yb=ay1 + b)
    mark("hatch", xa=ax0 - b, ya=ay0, xb=ax0, yb=ay1)
    mark("hatch", xa=ax1, ya=ay0, xb=ax1 + b, yb=ay1)
    mark("frame", xa=ax0 - 1.4, ya=ay0 - 1.4, xb=ax1 + 1.4, yb=ay1 + 1.4, width=0.1, color=YELLOW)
    cx, cy = (ax0 + ax1) / 2, (ay0 + ay1) / 2
    footprint(cx, cy, ax1 - ax0 - 0.4, ay1 - ay0 - 0.4, 0, 0.6, 0.9)


def build_press(prefix, x, y, rot, hero=True, k=1.0, machine_id=None, plate_text=None,
                frame_mat="press_blue", body_mat="press_grey", coll=None, template=False):
    if not hero and LOD[-1] >= 1.0:
        with low_detail(0.5):
            return build_press(prefix, x, y, rot, hero, k, machine_id, plate_text, frame_mat, body_mat, coll, template)
    F = T(x, y, 0.0) @ Rz(rot)
    m = Machine(prefix, F, coll or ("HERO_PRESS" if hero else "PRESS_SHOP"), "press", machine_id, hero,
                template=template)

    zf = 0.12
    Wb, Db, Hb = 6.8 * k, 4.0 * k, 1.0 * k
    zb1 = zf + Hb
    zbol = zb1 + 0.28 * k
    zld = zbol + 0.5 * k
    zud0 = zld + 0.9 * k
    zud1 = zud0 + 0.55 * k
    zsl1 = zud1 + 0.7 * k
    zc0 = zsl1 + 0.35 * k
    zc1 = zc0 + 1.1 * k
    ux0, ux1 = 2.45 * k, 3.35 * k
    Du = 3.4 * k
    Dc = 3.6 * k
    Wf, Df = Wb + 1.4, Db + 1.4

    # ---------------------------------------------------------------- base
    p = m.part("FOUNDATION", "foundation")
    p.add(rbox(Wf, Df, zf, 0.03), T(0, 0, zf / 2))
    p.done(label="Press foundation block", role="structure", tags=("foundation",))

    p = m.part("BED", body_mat)
    p.add(rbox(Wb, Db, Hb, 0.05, 2), T(0, 0, zf + Hb / 2))
    for sx in (-1, 1):                                   # bed access doors, front
        p.add(rbox(1.6 * k, 0.04, 0.55 * k, 0.015), T(sx * 1.6 * k, -Db / 2 - 0.02, zf + Hb * 0.5))
    p.add(rbox(Wb + 0.08, Db + 0.08, 0.08, 0.02), T(0, 0, zb1 - 0.04))
    p.done(label="Press bed", role="structure", tags=("bed",))

    p = m.part("BOLSTER", "steel_dark")
    p.add(rbox(4.6 * k, 2.6 * k, zbol - zb1, 0.02), T(0, 0, (zb1 + zbol) / 2))
    for sy in (-1, 1):
        for sx in np.linspace(-1.9, 1.9, 4) * k:
            p.add(fcyl(0.09, 0.07, 0.01, 16), T(sx, sy * 1.33 * k, zb1 + 0.1) @ Rx(90))
    p.done(label="Moving bolster", role="structure", tags=("bolster",))

    # ---------------------------------------------------------------- dies and part
    p = m.part("DIE_LOWER", "die_steel")
    p.add(rbox(3.6 * k, 2.1 * k, 0.32 * k, 0.02), T(0, 0, zbol + 0.16 * k))
    p.add(rbox(2.5 * k, 1.25 * k, 0.2 * k, 0.09, 2), T(0, 0, zld - 0.1 * k))          # punch
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(cyl(0.07, 0.25 * k, 16), T(sx * 1.6 * k, sy * 0.85 * k, zbol + 0.32 * k + 0.12 * k))
    p.done(label="Lower die (draw punch)", role="tooling", tags=("die",))

    p = m.part("DIE_UPPER", "die_steel")
    p.add(rbox(3.6 * k, 2.1 * k, zud1 - zud0, 0.02), T(0, 0, (zud0 + zud1) / 2))
    p.add(rbox(2.8 * k, 1.5 * k, 0.12, 0.03), T(0, 0, zud0 - 0.06))
    p.done(label="Upper die", role="tooling", tags=("die",))

    p = m.part("DIE_GUIDE_PINS", "chrome")
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(cyl(0.05, 0.42 * k, 16), T(sx * 1.6 * k, sy * 0.85 * k, zud0 - 0.21 * k))
    p.done(label="Die guide pins", role="tooling")

    def bump(gx, gy):
        ax, ay = 1.25 * k, 0.62 * k
        d = np.maximum(np.abs(gx) / ax, np.abs(gy) / ay)
        return 0.2 * k * np.clip((1.12 - d) / 0.24, 0, 1) ** 1.6
    p = m.part("PANEL", "sheet_steel")
    p.add(grid_plane(2.9 * k, 1.6 * k, 36, 20, bump), T(0, 0, zld - 0.2 * k + 0.006))
    p.done(label="Formed door panel in the die", role="workpiece", tags=("panel",))

    # ---------------------------------------------------------------- slide and drive links
    p = m.part("SLIDE", body_mat)
    p.add(rbox(4.6 * k, 2.7 * k, zsl1 - zud1, 0.05, 2), T(0, 0, (zud1 + zsl1) / 2))
    p.add(rbox(1.2 * k, 0.25, 0.3, 0.03), T(0, -1.35 * k - 0.1, zud1 + 0.35 * k))       # slide adjust motor box
    p.done(label="Slide (ram)", role="motion", tags=("slide",))

    p = m.part("CONNECTING_RODS", "chrome")
    for sx in (-1.6 * k, 1.6 * k):
        for sy in (-0.7 * k, 0.7 * k):
            p.add(cyl(0.16 * k, zc0 - zsl1 + 0.1, 20), T(sx, sy, (zsl1 + zc0) / 2))
    p.done(label="Connecting rods (pitmans)", role="motion")

    p = m.part("CONNECTING_ROD_BOOTS", "rubber")
    for sx in (-1.6 * k, 1.6 * k):
        for sy in (-0.7 * k, 0.7 * k):
            for zz in np.linspace(zsl1 + 0.04, zc0 - 0.06, 5):
                p.add(cyl(0.21 * k, 0.05, 20), T(sx, sy, zz))
    p.done()

    # ---------------------------------------------------------------- uprights
    for side, name in ((-1, "UPRIGHT_LEFT"), (1, "UPRIGHT_RIGHT")):
        p = m.part(name, frame_mat)
        cx, t = side * (ux0 + ux1) / 2, ux1 - ux0
        for (ya, yb) in ((-Du / 2, -0.62 * k), (0.62 * k, Du / 2)):
            p.add(rbox(t, yb - ya, zc0 - zb1, 0.05, 2), T(cx, (ya + yb) / 2, (zb1 + zc0) / 2))
        p.add(rbox(t, 1.3 * k, 0.5 * k, 0.03), T(cx, 0, zb1 + 0.25 * k))
        p.add(rbox(t, 1.3 * k, 0.55 * k, 0.03), T(cx, 0, zc0 - 0.275 * k))
        for yy in (-1.15 * k, 1.15 * k):
            p.add(rbox(0.1, 0.1, zc0 - zb1 - 0.3, 0.02), T(side * (ux1 + 0.04), yy, (zb1 + zc0) / 2))
        p.done(label=f"Upright, {'left' if side < 0 else 'right'}", role="structure", tags=("frame",))

    p = m.part("SLIDE_GIBS", "brass")
    for side in (-1, 1):
        for yy in (-0.9 * k, 0.9 * k):
            p.add(box(), T(side * (ux0 - 0.03), yy, (zbol + zc0) / 2 + 0.3) @ S(0.06, 0.22, zc0 - zbol - 0.6))
    p.done(label="Slide guide gibs", role="motion")

    # ---------------------------------------------------------------- crown
    p = m.part("CROWN", frame_mat)
    p.add(rbox(Wb, Dc, zc1 - zc0, 0.07, 2), T(0, 0, (zc0 + zc1) / 2))
    for sx in (-1.7 * k, 0.0, 1.7 * k):
        p.add(rbox(1.5 * k, 2.6 * k, 0.05, 0.02), T(sx, 0, zc1 + 0.025))               # top covers
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(rbox(0.22, 0.12, 0.22, 0.03), T(sx * (Wb / 2 - 0.35), sy * (Dc / 2 - 0.2), zc1 + 0.11))  # lifting lugs
    p.add(rbox(Wb - 0.6, 0.05, 0.08, 0.01), T(0, -Dc / 2 - 0.02, zc0 + 0.1))
    p.done(label="Crown (drive housing)", role="structure", tags=("crown", "frame"))

    p = m.part("TIE_RODS", "steel")
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(cyl(0.25 * k, 0.28, 6), T(sx * 2.9 * k, sy * 1.2 * k, zc1 + 0.14))      # hex nuts
            p.add(fcyl(0.17 * k, 0.5, 0.03, 20), T(sx * 2.9 * k, sy * 1.2 * k, zc1 + 0.28 + 0.2))
    p.done(label="Tie rods and nuts", role="structure")

    # ---------------------------------------------------------------- main bearings
    zbr = (zc0 + zc1) / 2
    for side, name, lab in ((-1, "MAIN_BEARING", "Main bearing, drive end"),
                            (1, "MAIN_BEARING_NDE", "Main bearing, non-drive end")):
        p = m.part(name, "cast_iron")
        M = T(side * 1.6 * k, -Dc / 2, zbr) @ Rx(90)
        p.add(fcyl(0.42 * k, 0.3 * k, 0.04, 32), M @ T(0, 0, 0.15 * k))
        p.add(fcyl(0.5 * k, 0.07, 0.015, 32), M @ T(0, 0, 0.035))
        p.add(fcyl(0.3 * k, 0.06, 0.02, 32), M @ T(0, 0, 0.3 * k + 0.03))
        bolt_ring(p, M @ T(0, 0, 0.07), 0.46 * k, 12, 0.024, 0.035, 6)
        bolt_ring(p, M @ T(0, 0, 0.3 * k + 0.06), 0.24 * k, 6, 0.018, 0.025, 6)
        p.add(cyl(0.025, 0.16, 8), M @ T(0, 0.43 * k, 0.15 * k) @ Rx(-90) @ T(0, 0, 0.08))  # grease nipple
        p.done(label=lab, role="bearing", tags=("main_bearing_housing", "bearing"),
               channel="PRESS-STAMP-01.BEARING_VIBRATION_RMS" if side < 0 and hero else None)
        if side < 0 and hero:
            s = m.part("MAIN_BEARING_SENSOR", "graphite")
            Ms = M @ T(0, 0.42 * k, 0.15 * k) @ Rx(-90)
            s.add(fcyl(0.035, 0.07, 0.008, 16), Ms @ T(0, 0, 0.035))
            s.add(cyl(0.012, 0.05, 8), Ms @ T(0, 0, 0.09))
            s.add(sweep(fillet_path([apply_point(Ms, (0, 0, 0.11)), apply_point(Ms, (0.0, 0, 0.3)),
                                     apply_point(Ms, (0.5, 0.0, 0.3))], 0.08), radius=0.008, seg=6))
            s.done(label="Accelerometer on the drive-end main bearing", role="sensor",
                   tags=("vibration_sensor",), channel="PRESS-STAMP-01.BEARING_VIBRATION_RMS")

    # ---------------------------------------------------------------- drive: clutch, flywheel, guard
    fx0 = -Wb / 2
    zfw = zbr
    yfw = 0.3 * k
    Rfw = 0.95 * k
    Rg = 1.12 * k
    p = m.part("CLUTCH_BRAKE", "cast_iron")
    p.add(fcyl(0.55 * k, 0.32 * k, 0.03, 32), T(fx0 - 0.16 * k, yfw, zfw) @ Ry(90))
    bolt_ring(p, T(fx0 - 0.32 * k, yfw, zfw) @ Ry(-90), 0.45 * k, 12, 0.02, 0.03)
    p.done(label="Clutch and brake unit", role="drive", tags=("clutch",))

    gx0 = fx0 - 0.34 * k                   # guard inner face
    gw = 0.62 * k                          # guard width along X
    p = m.part("FLYWHEEL", "cast_iron")
    Mf = T(gx0 - gw / 2, yfw, zfw) @ Ry(90)
    p.add(tube(Rfw, Rfw - 0.16 * k, 0.4 * k, 48), Mf)
    p.add(fcyl(0.24 * k, 0.5 * k, 0.03, 24), Mf)
    for i in range(6):
        a = 60.0 * i
        p.add(rbox(0.14 * k, Rfw - 0.3 * k, 0.18 * k, 0.03), Mf @ Rz(a) @ T(0, (Rfw - 0.3 * k) / 2 + 0.2 * k, 0))
    p.done(label="Flywheel", role="drive", tags=("flywheel",))

    p = m.part("FLYWHEEL_GUARD", "safety_yellow")
    p.add(tube(Rg, Rg - 0.02, gw, 56), T(gx0 - gw / 2, yfw, zfw) @ Ry(90))
    p.add(cyl(Rg, 0.02, 56), T(gx0 + 0.01, yfw, zfw) @ Ry(90))
    for i in range(4):
        a = math.radians(45 + 90 * i)
        p.add(box(), T(gx0 - gw, yfw + Rg * 0.98 * math.cos(a), zfw + Rg * 0.98 * math.sin(a)) @ S(0.04, 0.05, 0.05))
    p.done(label="Flywheel guard", role="guard", tags=("guard",))
    p = m.part("FLYWHEEL_GUARD_MESH", "mesh_panel")
    p.add(cyl(Rg - 0.015, 0.004, 56, caps=True), T(gx0 - gw + 0.01, yfw, zfw) @ Ry(90), uv="box", tile=0.4)
    p.done()

    # ---------------------------------------------------------------- main motor on the crown
    mr = 0.42 * k
    ym, zm = 1.25 * k, zc1 + 0.25 + mr
    mx_out, mx_in = -3.05 * k, -1.55 * k
    p = m.part("MOTOR_BASE", "dark_grey")
    p.add(rbox(1.75 * k, 1.0 * k, 0.25, 0.02), T((mx_out + mx_in) / 2, ym, zc1 + 0.125))
    p.done()
    p = m.part("MAIN_MOTOR", "motor_slate")
    Lm = mx_in - mx_out
    Mm = T((mx_out + mx_in) / 2, ym, zm) @ Ry(90)
    p.add(cyl(mr, Lm - 0.2, 40, caps=False), Mm)
    for i in range(36):                                                           # axial cooling fins
        a = 360.0 * i / 36
        p.add(box(), Mm @ Rz(a) @ T(mr + 0.03, 0, 0) @ S(0.06, 0.012, Lm - 0.32))
    p.add(fcyl(mr + 0.01, 0.12, 0.03, 40), Mm @ T(0, 0, -(Lm - 0.2) / 2 - 0.05))   # drive-end shield
    p.add(fcyl(mr + 0.05, 0.36, 0.04, 40), Mm @ T(0, 0, (Lm - 0.2) / 2 + 0.16))    # fan cowl
    for rr in (0.1, 0.2, 0.3):
        p.add(torus(rr * k, 0.012, 32, 4), Mm @ T(0, 0, (Lm - 0.2) / 2 + 0.345))
    p.add(rbox(0.38, 0.32, 0.26, 0.03), T((mx_out + mx_in) / 2 + 0.1, ym, zm + mr + 0.1))  # terminal box
    for sx in (-0.45, 0.45):
        p.add(rbox(0.2, 0.75 * k, 0.16, 0.02), T((mx_out + mx_in) / 2 + sx, ym, zm - mr - 0.02))  # feet
    p.add(torus(0.06, 0.015, 12, 6), T((mx_out + mx_in) / 2 - 0.3, ym, zm + mr + 0.06) @ Rx(90))
    p.done(label="Main drive motor, 250 kW", role="motor", tags=("main_motor", "motor"),
           channel="PRESS-STAMP-01.MAIN_MOTOR_CURRENT" if hero else None)
    p = m.part("MOTOR_SHAFT", "steel")
    p.add(cyl(0.065, abs(mx_out - (gx0 - gw / 2)) + 0.1, 16), T((mx_out + gx0 - gw / 2) / 2, ym, zm) @ Ry(90))
    p.done()

    # belt guard: hull of the motor pulley and the top of the flywheel guard, in (Y, Z)
    poly = circles_hull([(ym, zm, 0.36), (yfw + 0.12, zfw + 0.6 * k, 0.6 * k)], 24)
    p = m.part("BELT_GUARD", "safety_yellow")
    p.add(prism(poly, gw - 0.04), T(gx0 - 0.02, 0, 0) @ M_YZ)
    p.done(label="Drive belt guard", role="guard", tags=("guard", "belt"))

    # ---------------------------------------------------------------- platform, rails, ladder
    r = m.part("RAILING", "safety_yellow")
    toe = m.part("TOE_BOARD", "safety_yellow")
    e = 0.12
    handrail(r, [(-Wb / 2 + e, -Dc / 2 + e, zc1), (Wb / 2 - e, -Dc / 2 + e, zc1), (Wb / 2 - e, Dc / 2 - e, zc1),
                 (-Wb / 2 + e, Dc / 2 - e, zc1)], height=1.1, post_step=1.7, closed=True, toe=toe)
    r.done(label="Crown platform guard rail", role="access")
    toe.done()
    lad = m.part("LADDER", "safety_yellow")
    ladder(lad, (Wb / 2 + 0.45, 1.2 * k, 0.0), zc1, facing_deg=90.0, cage=True)
    lad.done(label="Access ladder with cage", role="access")

    # ---------------------------------------------------------------- andon
    zA = zc1 + 0.05
    ax, ay = Wb / 2 - 0.55, -Dc / 2 + 0.45
    p = m.part("ANDON", "graphite")
    p.add(cyl(0.08, 0.04, 20), T(ax, ay, zA + 0.02))
    p.add(cyl(0.022, 0.6, 10), T(ax, ay, zA + 0.32))
    p.add(dome(0.08, 0.06, 20, 4), T(ax, ay, zA + 0.62 + 0.42))
    p.done(label="Andon stack light", role="signal", tags=("andon",))
    for i, (nm, mat) in enumerate((("ANDON_GREEN", "led_green"), ("ANDON_AMBER", "lamp_amber_off"), ("ANDON_RED", "lamp_red_off"))):
        p = m.part(nm, mat)
        p.add(fcyl(0.075, 0.13, 0.02, 24), T(ax, ay, zA + 0.7 + i * 0.14))
        p.done()

    # ---------------------------------------------------------------- lubrication unit (floor, front-left)
    L0 = T(-5.2 * k, 2.2 * k, 0.0)
    p = m.part("LUBE_SKID", "steel_dark")
    p.add(rbox(1.25, 2.3, 0.14, 0.02), L0 @ T(0, 0, 0.07))
    p.add(rbox(1.33, 2.38, 0.05, 0.01), L0 @ T(0, 0, 0.165))
    p.done()
    p = m.part("LUBE_UNIT", "lube_grey")
    p.add(rbox(0.95, 1.25, 0.82, 0.04, 2), L0 @ T(0, 0.45, 0.19 + 0.41))
    p.add(fcyl(0.07, 0.08, 0.01, 16), L0 @ T(0.2, 0.75, 1.05))
    p.add(cyl(0.035, 0.18, 10), L0 @ T(-0.25, 0.85, 1.1))
    p.done(label="Central lubrication unit (oil reservoir)", role="lubrication",
           tags=("lube_unit", "lube_reservoir"), channel=None)
    p = m.part("LUBE_SIGHT_GLASS", "glass_dark")
    p.add(rbox(0.04, 0.12, 0.4, 0.01), L0 @ T(-0.48, 0.45, 0.6))
    p.done()
    p = m.part("LUBE_PUMP", "motor_teal")
    Mp = L0 @ T(0.05, -0.55, 0.42) @ Rx(90)
    p.add(cyl(0.14, 0.4, 24), Mp)
    for i in range(16):
        p.add(box(), Mp @ Rz(22.5 * i) @ T(0.15, 0, 0) @ S(0.03, 0.008, 0.32))
    p.add(fcyl(0.15, 0.08, 0.02, 24), Mp @ T(0, 0, 0.24))
    p.add(rbox(0.2, 0.36, 0.08, 0.01), L0 @ T(0.05, -0.55, 0.23))
    p.done(label="Lubrication pump motor", role="lubrication", tags=("lube_pump",))
    p = m.part("LUBE_PUMP_HEAD", "cast_iron")
    p.add(fcyl(0.1, 0.18, 0.02, 20), L0 @ T(0.05, -0.18, 0.42) @ Rx(90))
    p.done()
    p = m.part("LUBE_FILTER", "filter_silver")
    for dx in (-0.2, 0.2):
        Mf2 = L0 @ T(dx, -0.95, 0.5)
        p.add(fcyl(0.1, 0.42, 0.03, 24), Mf2)
        p.add(dome(0.1, 0.06, 24, 4), Mf2 @ T(0, 0, 0.21))
    p.done(label="Lube oil filter bank (duplex)", role="filter", tags=("lube_filter", "filter"),
           channel="PRESS-STAMP-01.LUBE_OIL_PRESSURE" if hero else None)
    p = m.part("LUBE_MANIFOLD", "steel_dark")
    p.add(rbox(0.6, 0.16, 0.12, 0.02), L0 @ T(0, -0.95, 0.24))
    p.add(rbox(0.12, 0.08, 0.1, 0.01), L0 @ T(0, -0.95, 0.85))      # differential pressure indicator
    p.done()
    p = m.part("LUBE_GAUGE", "white_paint")
    Mg = L0 @ T(0.0, -0.95, 0.98) @ Rx(90)
    p.add(fcyl(0.075, 0.03, 0.006, 24), Mg)
    p.done(label="Lube oil pressure gauge", role="gauge", tags=("lube_pressure",))
    p = m.part("LUBE_GAUGE_RIM", "chrome")
    p.add(tube(0.082, 0.072, 0.04, 24), Mg)
    p.add(cyl(0.012, 0.22, 8), L0 @ T(0, -0.95, 0.86))
    p.done()
    p = m.part("LUBE_PIPING", "copper")
    # up a pipe stand beside the unit, then across above the flywheel guard into
    # the crown end: nothing crosses the bolster-change track on the floor
    sx0, sy0 = -5.2 * k + 0.45, 2.2 * k - 0.95
    for i, dz in enumerate((0.0, 0.06, 0.12)):
        yo = 0.07 * i
        path = fillet_path([(-5.2 * k + 0.3, sy0, 0.3 + dz), (sx0, sy0 + yo, 0.3 + dz),
                            (sx0, sy0 + yo, zc0 + 0.15 + dz), (sx0, Dc / 2 - 0.1 - yo, zc0 + 0.15 + dz),
                            (-Wb / 2 + 0.02, Dc / 2 - 0.1 - yo, zc0 + 0.15 + dz)], 0.14, 5)
        p.add(sweep(path, radius=0.016, seg=8))
    p.done(label="Lube supply lines to crown", role="lubrication", tags=("lube_lines",))
    p = m.part("LUBE_PIPE_STAND", "steel_dark")
    p.add(box(), T(sx0 + 0.08, sy0 + 0.07, (zc0 + 0.4) / 2) @ S(0.08, 0.08, zc0 + 0.4))
    p.add(box(), T(sx0 + 0.08, sy0 + 0.07, 0.01) @ S(0.3, 0.3, 0.02))
    p.done()

    # ---------------------------------------------------------------- air receiver, cabinets, HMI
    # counterbalance air receiver beside the control cabinets, clear of the
    # part-transfer path behind the press
    atx, aty = Wb / 2 + 1.6, Db / 2 + 1.5
    p = m.part("AIR_TANK", "white_paint")
    p.add(cyl(0.45, 2.0, 32, caps=False), T(atx, aty, 0.75) @ Rx(90))
    p.add(dome(0.45, 0.22, 32, 5), T(atx, aty + 1.0, 0.75) @ Rx(-90))
    p.add(dome(0.45, 0.22, 32, 5), T(atx, aty - 1.0, 0.75) @ Rx(90))
    p.add(cyl(0.05, 0.3, 10), T(atx, aty + 0.4, 1.3))
    p.done(label="Counterbalance air receiver", role="pneumatic", tags=("air_tank",))
    p = m.part("AIR_TANK_SADDLES", "dark_grey")
    for sy in (-0.6, 0.6):
        p.add(rbox(0.8, 0.2, 0.35, 0.02), T(atx, aty + sy, 0.17))
    p.done()

    p = m.part("CONTROL_CABINET", "cabinet_grey")
    for i in range(3):
        yy = (i - 1) * 0.82
        p.add(rbox(0.6, 0.8, 2.0, 0.02), T(Wb / 2 + 1.6, yy, 0.1 + 1.0))
        p.add(box(), T(Wb / 2 + 1.29, yy + 0.3, 1.1) @ S(0.03, 0.03, 0.22))      # handles
    p.done(label="Press control cabinet", role="controls", tags=("control_cabinet",))
    p = m.part("CONTROL_CABINET_PLINTH", "graphite")
    p.add(box(), T(Wb / 2 + 1.6, 0, 0.05) @ S(0.62, 2.48, 0.1))
    p.add(box(), T(Wb / 2 + 1.6, 0, 2.18) @ S(0.62, 2.48, 0.06))
    p.done()
    p = m.part("HMI", "graphite")
    Mh = T(2.4 * k, -Db / 2 - 1.4, 0.0) @ Rz(0)
    p.add(cyl(0.05, 1.2, 12), Mh @ T(0, 0, 0.6))
    p.add(rbox(0.6, 0.12, 0.44, 0.02), Mh @ T(0, 0, 1.45) @ Rx(-15))
    p.add(rbox(0.36, 0.36, 0.06, 0.01), Mh @ T(0, 0, 0.03))
    p.done(label="Operator HMI panel", role="controls", tags=("hmi",))
    p = m.part("HMI_SCREEN", "screen")
    p.add(box(), Mh @ T(0, 0, 1.45) @ Rx(-15) @ T(0, -0.062, 0.0) @ S(0.52, 0.005, 0.34))
    p.done()

    # ---------------------------------------------------------------- light curtains at the die opening
    p = m.part("LIGHT_CURTAIN", "safety_yellow")
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(rbox(0.07, 0.07, 2.4, 0.01), T(sx * 2.62 * k, sy * (Db / 2 + 0.35), zb1 + 0.05 + 1.2))
    p.done(label="Safety light curtains", role="safety", tags=("light_curtain",))
    p = m.part("LIGHT_CURTAIN_LED", "led_red")
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(box(), T(sx * (2.62 * k - 0.04), sy * (Db / 2 + 0.35), zb1 + 1.25) @ S(0.012, 0.02, 2.2))
    p.done()

    # bolster change rails, out to the left (towards the aisle)
    p = m.part("BOLSTER_RAILS", "rail_steel")
    for sy in (-0.9 * k, 0.9 * k):
        p.add(box(), T(-Wb / 2 - 3.2, sy, 0.025) @ S(6.4, 0.09, 0.05))
    p.done(label="Moving bolster change rails", role="structure")

    # name plate on the crown front, between the bearings
    if plate_text:
        sign_board(m, "NAMEPLATE", plate_text, (0.0, -Dc / 2 - 0.04, zbr), 0.0,
                   width=2.05 * k, height=0.34 * k, size=0.16 * k, label=f"{plate_text} name plate")

    if hero:
        # hazard striping on the die-opening edges of both uprights, front and back
        p = m.part("DIE_OPENING_STRIPES", "hazard", uv="box", tile=0.4)
        for side in (-1, 1):
            for sy in (-1, 1):
                p.add(box(), T(side * (ux0 + 0.02), sy * (Du / 2 + 0.006), (zb1 + zc0) / 2) @ S(0.16, 0.012, zc0 - zb1 - 0.1))
        p.add(box(), T(0, -2.6 * k / 2 - 0.02, zbol - 0.05) @ S(4.6 * k, 0.012, 0.1))
        p.done()
        # crown: inspection covers, lube distributor block with feed lines, capacity plate
        p = m.part("CROWN_COVERS", "press_grey")
        for sx in (-2.4, -0.8, 0.8, 2.4):
            p.add(rbox(1.1, 0.04, 0.42, 0.02), T(sx * k, -Dc / 2 - 0.02, zc1 - 0.32))
        p.done()
        p = m.part("CROWN_COVER_BOLTS", "steel")
        for sx in (-2.4, -0.8, 0.8, 2.4):
            for bx in (-0.48, 0.48):
                for bz in (-0.16, 0.16):
                    p.add(cyl(0.016, 0.02, 6), T(sx * k + bx, -Dc / 2 - 0.045, zc1 - 0.32 + bz) @ Rx(90))
        p.done()
        p = m.part("LUBE_DISTRIBUTOR", "brass")
        p.add(rbox(0.5, 0.12, 0.16, 0.01), T(-0.2, -Dc / 2 - 0.06, zc0 + 0.18))
        for i in range(6):
            x = -0.4 + i * 0.16
            p.add(sweep(fillet_path([(x, -Dc / 2 - 0.08, zc0 + 0.26), (x, -Dc / 2 - 0.08, zc0 + 0.42),
                                     (x * 2.2 + (1.6 if x > -0.2 else -1.6), -Dc / 2 - 0.08, zc0 + 0.42)], 0.06, 3),
                        radius=0.008, seg=6))
        p.done()
        sign_board(m, "CAPACITY_PLATE", "2500 t", (Wb / 2 - 0.75, -Dc / 2 - 0.04, zc0 + 0.25), 0.0,
                   width=0.8, height=0.28, size=0.16, board_mat="safety_yellow", text_mat="graphite")
        # cable tray from the control cabinets up the right upright to the crown
        p = m.part("CABLE_TRAY", "galvanized")
        tx = Wb / 2 + 0.25
        p.add(box(), T(tx, -1.1 * k, (0.2 + zc1) / 2) @ S(0.06, 0.35, zc1 - 0.2))
        p.add(box(), T((tx + Wb / 2 + 1.3) / 2, -1.1 * k, 2.3) @ S(Wb / 2 + 1.3 - tx, 0.35, 0.06))
        p.done()
        p = m.part("CABLES", "cable")
        p.add(box(), T(tx + 0.045, -1.1 * k, (0.2 + zc1) / 2) @ S(0.04, 0.28, zc1 - 0.25))
        p.add(box(), T((tx + Wb / 2 + 1.3) / 2, -1.1 * k, 2.345) @ S(Wb / 2 + 1.3 - tx, 0.28, 0.04))
        p.done()
    press_floor_marks(F, Wf, Df)
    footprint(*apply_point(F, (-5.2 * k, 2.2 * k, 0))[:2], 1.4, 2.5, rot + 0, 0.45, 0.4)
    m.finish()
    return m


# =============================================================================
# part: 55_robot.py
# =============================================================================
# =============================================================================
#  Six-axis industrial robot (210 kg payload class, 2.7 m reach)
#
#  Kinematics follow a KR 210 R2700-class arm: A2 sits 0.33 m forward of A1 and
#  0.675 m above the base, lower arm 1.15 m, forearm offset 0.115 m, A3 to wrist
#  centre 1.22 m, wrist centre to flange 0.215 m. Joint angles are solved so the
#  tool really touches its work (see solve_reach), which is what makes a line of
#  robots look like it is working rather than posed.
#
#  Local frame: origin on the floor under A1, +X forward (the robot's front).
# =============================================================================

ROBOT_DIM = dict(a1z=0.675, a2x=0.33, a2=1.15, a3off=0.115, a3=1.22, a6=0.215, base_h=0.24)


def robot_fk(th, plinth=0.0):
    """Joint frames for angles th[0..5] (degrees). Returns dict of 4x4 matrices."""
    d = ROBOT_DIM
    t1, t2, t3, t4, t5, t6 = th
    B = T(0, 0, plinth)
    M1 = B @ T(0, 0, d["base_h"]) @ Rz(t1)
    M2 = M1 @ T(d["a2x"], 0, d["a1z"] - d["base_h"]) @ Ry(t2)
    M3 = M2 @ T(0, 0, d["a2"]) @ Ry(t3)
    M4 = M3 @ T(0, 0, d["a3off"]) @ Rx(t4)
    M5 = M4 @ T(d["a3"], 0, 0) @ Ry(t5)
    M6 = M5 @ T(d["a6"], 0, 0) @ Rx(t6)
    return dict(B=B, M1=M1, M2=M2, M3=M3, M4=M4, M5=M5, M6=M6)


# tool centre point in flange coordinates, per tool type
TOOL_TCP = {"spot_gun": (0.835, 0.0, -0.29), "gripper": (0.32, 0.0, 0.0), "sealer": (0.42, 0.0, -0.12),
            "paint": (0.36, 0.0, 0.0), "glazing": (0.30, 0.0, 0.0), "none": (0.05, 0.0, 0.0)}


def solve_reach(target_local, tool="spot_gun", plinth=0.0, approach=(0, 0, -1), seed=(0, 30, 10, 0, 40, 0), iters=80):
    """Damped least squares on A1, A2, A3, A5 (A4, A6 fixed) so the TCP reaches the
    target with the tool's jaw axis close to `approach` (local robot frame)."""
    tcp = np.array([*TOOL_TCP[tool], 1.0])
    target = np.asarray(target_local, float)
    app = _unit(approach)
    th = np.array(seed, float)
    free = [0, 1, 2, 4]
    limits = {1: (-70, 95), 2: (-110, 80), 4: (-120, 120)}

    def err(t):
        fr = robot_fk(t, plinth)
        p = (fr["M6"] @ tcp)[:3]
        # a C-gun closes along the flange -Z; other tools work along the flange +X
        axis = -fr["M6"][:3, 2] if tool == "spot_gun" else fr["M6"][:3, 0]
        return np.concatenate([p - target, 0.3 * (axis - app)])

    h = 0.1                                    # degrees
    for _ in range(iters):
        e = err(th)
        if np.linalg.norm(e[:3]) < 1e-3 and np.linalg.norm(e[3:]) < 0.03:
            break
        J = np.zeros((6, len(free)))
        for j, idx in enumerate(free):
            dt = np.array(th); dt[idx] += h
            J[:, j] = (err(dt) - e) / math.radians(h)
        step = np.linalg.solve(J.T @ J + 0.02 * np.eye(len(free)), -J.T @ e)
        step = np.degrees(np.clip(step, -0.25, 0.25))
        for j, idx in enumerate(free):
            th[idx] += step[j]
            if idx in limits:
                th[idx] = float(np.clip(th[idx], *limits[idx]))
    return tuple(float(v) for v in th)


def _arm_profile(r0, r1, L):
    """Capsule-like side profile in (x, z) from a circle r0 at z=0 to r1 at z=L."""
    return circles_hull([(0.0, 0.0, r0), (0.0, L, r1)], 28)


M_XZ = np.array([[1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]])
# prism profile drawn in (x, z), extruded along +y  (det = -1, builder flips winding)


def build_robot(prefix, frame, th, tool="spot_gun", plinth=0.35, hero=False, coll=None, zone="body",
                machine_id=None, body_mat="robot_orange", motor_mat="graphite", base_mat="robot_base", into=None):
    if into is not None:
        frame = into.frame @ frame
    m = Machine(prefix, frame, coll or ("HERO_ROBOT" if hero else "BODY_SHOP"), zone, machine_id, hero, into=into)
    d = ROBOT_DIM
    fr = robot_fk(th, plinth)
    B, M1, M2, M3, M4, M5, M6 = (fr[k] for k in ("B", "M1", "M2", "M3", "M4", "M5", "M6"))

    # ---------------------------------------------------------------- plinth and base
    if plinth > 0:
        p = m.part("PEDESTAL", "steel_dark")
        p.add(rbox(1.05, 1.05, plinth - 0.03, 0.02), T(0, 0, (plinth - 0.03) / 2))
        p.add(rbox(1.35, 1.35, 0.03, 0.01), T(0, 0, 0.015))
        for sx in (-0.58, 0.58):
            for sy in (-0.58, 0.58):
                p.add(cyl(0.025, 0.06, 8), T(sx, sy, 0.06))
        p.done(label="Robot pedestal", role="structure")
    p = m.part("BASE", base_mat)
    p.add(rbox(0.78, 0.78, 0.06, 0.01), B @ T(0, 0, 0.03))
    p.add(fcyl(0.36, d["base_h"] - 0.06, 0.03, 40), B @ T(0, 0, 0.06 + (d["base_h"] - 0.06) / 2))
    bolt_ring(p, B @ T(0, 0, 0.06), 0.33, 8, 0.02, 0.025)
    p.done(label="Robot base (A1 housing)", role="robot_base", tags=("base",))

    # ---------------------------------------------------------------- A1 carousel and shoulder
    p = m.part("A1_COLUMN", body_mat)
    p.add(fcyl(0.37, 0.16, 0.03, 40), M1 @ T(0, 0, 0.08))
    prof = circles_hull([(-0.12, 0.12, 0.26), (d["a2x"], d["a1z"] - d["base_h"], 0.31)], 28)
    p.add(prism(prof, 0.56), M1 @ T(0, -0.28, 0) @ M_XZ)
    p.done(label="Axis 1 rotating column", role="robot_link", tags=("axis_1",))
    p = m.part("A1_MOTOR", motor_mat)
    p.add(fcyl(0.1, 0.36, 0.02, 24), M1 @ T(-0.32, 0.16, 0.32))
    p.add(rbox(0.12, 0.1, 0.1, 0.01), M1 @ T(-0.32, 0.16, 0.54))
    p.done(label="Axis 1 servo motor", role="motor", tags=("axis_1_motor",))

    # ---------------------------------------------------------------- A2 lower arm
    p = m.part("A2_LOWER_ARM", body_mat)
    p.add(fcyl(0.3, 0.64, 0.04, 40), M2 @ Rx(90))                                   # A2 hub
    p.add(prism(_arm_profile(0.25, 0.19, d["a2"]), 0.34), M2 @ T(0, -0.17, 0) @ M_XZ)
    p.add(fcyl(0.22, 0.5, 0.04, 32), M2 @ T(0, 0, d["a2"]) @ Rx(90))                # A3 hub
    p.done(label="Axis 2 lower arm", role="robot_link", tags=("axis_2",))
    if hero:
        p = m.part("ID_LABEL", "white_paint")
        p.add(text_prim("ROBOT-WELD-01", 0.075, 0.004), M2 @ T(0.0, 0.172, 0.62) @ Rx(-90) @ Rz(-90))
        p.done()
    p = m.part("A2_MOTOR", motor_mat)
    p.add(fcyl(0.13, 0.4, 0.02, 24), M2 @ T(0, 0.52, 0) @ Rx(90))
    p.add(rbox(0.13, 0.12, 0.1, 0.01), M2 @ T(0.0, 0.52, 0.17))
    p.done(label="Axis 2 servo motor", role="motor", tags=("axis_2_motor",))

    # counterbalance: carousel rear to lower arm, recomputed for the pose
    pa = apply_point(M1, (-0.3, -0.33, 0.62))
    pb = apply_point(M2, (-0.2, -0.33, 0.45))
    p = m.part("COUNTERBALANCE", "dark_grey")
    p.add(fcyl(0.085, 1.0, 0.02, 20), between(pa, pa + (pb - pa) * 0.62) @ T(0, 0, 0.5))
    p.done(label="Hydropneumatic counterbalance", role="robot_link", tags=("counterbalance",))
    p = m.part("COUNTERBALANCE_ROD", "chrome")
    p.add(cyl(0.035, 1.0, 12), between(pa + (pb - pa) * 0.6, pb) @ T(0, 0, 0.5))
    p.done()

    # ---------------------------------------------------------------- A3 arm housing (wrist motors at the rear)
    p = m.part("A3_ARM", body_mat)
    p.add(rbox(0.62, 0.44, 0.42, 0.08, 2), M3 @ T(-0.06, 0, d["a3off"]))
    p.add(fcyl(0.24, 0.46, 0.04, 32), M3 @ Rx(90))
    p.done(label="Axis 3 arm housing", role="robot_link", tags=("axis_3",))
    p = m.part("A4_SERVO_MOTOR", motor_mat)
    Mm = M3 @ T(-0.37, 0, d["a3off"] + 0.02) @ Ry(-90)
    p.add(fcyl(0.1, 0.34, 0.02, 24), Mm @ T(0, 0, 0.17))
    p.add(rbox(0.12, 0.1, 0.1, 0.01), Mm @ T(0.12, 0, 0.17))
    p.done(label="Axis 4 servo motor (wrist roll)", role="motor", tags=("axis_4_motor", "servo"),
           channel="ROBOT-WELD-01.AXIS_4_SERVO_TORQUE" if hero else None)
    p = m.part("WRIST_MOTORS", motor_mat)
    for sy in (-0.14, 0.14):
        Mw = M3 @ T(-0.36, sy, d["a3off"] + 0.17) @ Ry(-90)
        p.add(fcyl(0.075, 0.3, 0.02, 20), Mw @ T(0, 0, 0.15))
    p.done(label="Axis 5 and 6 servo motors", role="motor", tags=("axis_5_motor", "axis_6_motor"))

    # ---------------------------------------------------------------- A4 forearm tube, A5 wrist, A6 flange
    p = m.part("A4_FOREARM", body_mat)
    p.add(cyl(0.15, 0.88, 32, r_top=0.12), M4 @ T(0.66, 0, 0) @ Ry(90))
    p.add(fcyl(0.17, 0.1, 0.02, 32), M4 @ T(0.26, 0, 0) @ Ry(90))
    for sy in (-0.12, 0.12):                                                          # wrist fork
        p.add(rbox(0.26, 0.05, 0.22, 0.03), M4 @ T(d["a3"] - 0.06, sy, 0))
    p.done(label="Axis 4 forearm", role="robot_link", tags=("axis_4",))
    p = m.part("A5_WRIST", body_mat)
    p.add(fcyl(0.1, 0.19, 0.02, 28), M5 @ Rx(90))
    p.add(cyl(0.085, 0.14, 28, r_top=0.075), M5 @ T(0.1, 0, 0) @ Ry(90))
    p.done(label="Axis 5 wrist", role="robot_link", tags=("axis_5",))
    p = m.part("A6_FLANGE", "steel")
    p.add(fcyl(0.08, 0.04, 0.008, 28), M6 @ T(-0.02, 0, 0) @ Ry(90))
    p.add(rbox(0.035, 0.2, 0.2, 0.01), M6 @ T(0.017, 0, 0))
    p.done(label="Axis 6 tool flange", role="robot_link", tags=("axis_6", "flange"))

    # ---------------------------------------------------------------- tool
    tcp_w = None
    if tool == "spot_gun":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("WELD_GUN", "steel_dark")
        p.add(rbox(0.3, 0.24, 0.34, 0.03), G @ T(0.17, 0, 0.02))                     # transformer
        c_shape = [(0.3, 0.07), (0.86, 0.07), (0.86, -0.05), (0.42, -0.05), (0.42, -0.45),
                   (0.84, -0.45), (0.84, -0.55), (0.3, -0.55)]
        p.add(prism(c_shape, 0.07), G @ T(0, -0.035, 0) @ M_XZ)
        p.add(rbox(0.08, 0.16, 0.1, 0.01), G @ T(0.3, 0, -0.2))
        p.done(label="Servo spot-welding gun", role="tool", tags=("weld_gun", "gun"),
               channel="ROBOT-WELD-01.WELD_GUN_TEMP" if hero else None)
        p = m.part("WELD_GUN_SERVO", motor_mat)
        p.add(fcyl(0.065, 0.3, 0.015, 20), G @ T(0.8, 0, 0.22))
        p.add(cyl(0.03, 0.14, 12), G @ T(0.8, 0, 0.0))
        p.done(label="Weld gun servo actuator", role="tool", tags=("gun_servo",))
        p = m.part("WELD_GUN_TIP", "copper")
        p.add(cyl(0.022, 0.2, 16), G @ T(0.8, 0, -0.15))
        p.add(dome(0.022, 0.025, 16, 3), G @ T(0.8, 0, -0.25) @ Rx(180))
        p.add(cyl(0.022, 0.13, 16), G @ T(0.8, 0, -0.385))
        p.add(dome(0.022, 0.025, 16, 3), G @ T(0.8, 0, -0.32))
        p.done(label="Electrode caps (tool centre point)", role="tool", tags=("tcp", "electrode"),
               channel="ROBOT-WELD-01.TOOL_CENTER_POINT_DEVIATION" if hero else None)
        tcp_w = apply_point(G, (0.8, 0, -0.29))
        hp = m.part("WELD_GUN_HOSES", "hose_blue")
        hr = m.part("WELD_GUN_HOSES_RED", "hose_red")
        for part_, dy in ((hp, 0.05), (hr, -0.05)):
            path = fillet_path([apply_point(G, (0.15, dy, 0.2)), apply_point(G, (0.0, dy, 0.38)),
                                apply_point(M4, (0.7, dy, 0.24)), apply_point(M4, (0.25, dy, 0.24))], 0.1, 5)
            part_.add(sweep(path, radius=0.014, seg=8))
        hp.done(); hr.done()
    elif tool == "gripper":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("GRIPPER", "aluminium")
        p.add(rbox(0.1, 0.9, 0.08, 0.01), G @ T(0.08, 0, 0))
        p.add(rbox(0.1, 0.08, 0.9, 0.01), G @ T(0.08, 0, 0))
        for sy in (-0.42, 0.42):
            for sz in (-0.42, 0.42):
                p.add(cyl(0.04, 0.16, 12), G @ T(0.2, sy if abs(sz) < 0.1 else 0, sz if abs(sy) < 0.1 else 0) @ Ry(90))
        p.done(label="Vacuum gripper", role="tool")
    elif tool == "sealer":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("SEALER_GUN", "aluminium")
        p.add(fcyl(0.06, 0.3, 0.01, 16), G @ T(0.15, 0, 0) @ Ry(90))
        p.add(cyl(0.012, 0.18, 8), G @ T(0.35, 0, -0.06) @ Ry(135))
        p.done(label="Sealer applicator", role="tool")
    elif tool == "paint":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("ATOMIZER", "aluminium")
        p.add(cyl(0.07, 0.24, 20, r_top=0.05), G @ T(0.12, 0, 0) @ Ry(90))
        p.add(cyl(0.035, 0.06, 20), G @ T(0.27, 0, 0) @ Ry(90))
        p.done(label="Rotary bell atomizer", role="tool")
    elif tool == "glazing":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("GLAZING_GRIPPER", "aluminium")
        p.add(rbox(0.08, 1.1, 0.06, 0.01), G @ T(0.06, 0, 0))
        for sy in (-0.5, 0.5):
            p.add(cyl(0.07, 0.05, 16), G @ T(0.13, sy, 0) @ Ry(90))
        p.done(label="Glazing suction gripper", role="tool")

    # ---------------------------------------------------------------- dress pack (cable bundle)
    p = m.part("DRESS_PACK", "corrugated")
    side = -0.36
    path = [apply_point(M1, (-0.42, side + 0.05, 0.25)), apply_point(M1, (-0.2, side, 0.75)),
            apply_point(M2, (-0.2, side, 0.25)), apply_point(M2, (-0.22, side, 0.8)),
            apply_point(M3, (-0.3, side + 0.05, d["a3off"] + 0.3)), apply_point(M4, (0.4, 0.0, 0.24)),
            apply_point(M4, (0.95, 0.0, 0.2))]
    if tool == "spot_gun":
        path.append(apply_point(M6, (0.05, 0.0, 0.25)))
    p.add(sweep(fillet_path(path, 0.18, 6), radius=0.042, seg=10))
    p.done(label="Robot dress pack", role="cabling", tags=("dress_pack",))

    m.finish()
    m.tcp = None if tcp_w is None else apply_point(frame, tcp_w)
    return m


def robot_controller(prefix, frame, coll, zone, hero=False, machine_id=None, into=None):
    """Controller cabinet with teach pendant, plus the weld timer cabinet."""
    if into is not None:
        frame = into.frame @ frame
    m = Machine(prefix, frame, coll, zone, machine_id, hero, into=into)
    p = m.part("CONTROLLER", "cabinet_grey")
    p.add(rbox(0.8, 0.55, 1.25, 0.02), T(0, 0, 0.1 + 0.625))
    p.add(box(), T(0.0, -0.28, 0.95) @ S(0.62, 0.02, 0.5))
    p.done(label="Robot controller cabinet", role="controls", tags=("controller",))
    p = m.part("CONTROLLER_TRIM", "robot_orange")
    p.add(box(), T(0, -0.278, 1.28) @ S(0.8, 0.02, 0.06))
    p.add(box(), T(0, 0, 0.05) @ S(0.82, 0.57, 0.1))
    p.done()
    p = m.part("TEACH_PENDANT", "graphite")
    p.add(rbox(0.33, 0.06, 0.24, 0.02), T(0.25, -0.3, 1.05) @ Rx(-10))
    p.add(sweep(fillet_path([(0.25, -0.31, 0.93), (0.3, -0.36, 0.6), (0.36, -0.3, 0.3), (0.38, -0.28, 0.18)], 0.1), radius=0.008, seg=6))
    p.done(label="Teach pendant", role="controls", tags=("pendant",))
    p = m.part("PENDANT_SCREEN", "screen")
    p.add(box(), T(0.25, -0.334, 1.05) @ Rx(-10) @ S(0.2, 0.004, 0.14))
    p.done()
    p = m.part("WELD_CONTROLLER", "cabinet_grey")
    p.add(rbox(0.6, 0.45, 1.6, 0.02), T(1.0, 0, 0.8))
    p.done(label="Weld timer cabinet", role="controls", tags=("weld_timer",))
    p = m.part("WELD_CONTROLLER_PANEL", "graphite")
    p.add(box(), T(1.0, -0.23, 1.2) @ S(0.36, 0.02, 0.24))
    p.done()
    p = m.part("CONTROLLER_LEDS", "led_green")
    p.add(cyl(0.012, 0.012, 8), T(-0.2, -0.29, 1.15) @ Rx(90))
    p.add(cyl(0.012, 0.012, 8), T(1.08, -0.235, 1.38) @ Rx(90))
    p.done()
    footprint(*apply_point(frame, (0.5, 0, 0))[:2], 2.0, 0.8, math.degrees(math.atan2(frame[1, 0], frame[0, 0])), 0.4, 0.25)
    return m.finish()


# =============================================================================
# part: 56_fence.py
# =============================================================================
# =============================================================================
#  Machine safety fencing (ISO 14120 style welded-mesh panels)
#
#  2.2 m high: 60 x 60 mm yellow posts, panels up to 1.5 m wide, 50 mm wire
#  mesh (alpha-masked texture, so it costs two triangles a panel), 150 mm
#  solid kick plate. Openings are gates (interlocked) or light-curtain muting
#  openings for conveyors.
# =============================================================================

FENCE_H = 2.2
KICK_H = 0.15


def fence(m, pts, openings=(), closed=True, height=FENCE_H, max_panel=1.5, names=None, post_mat="safety_yellow"):
    """Fence along a polyline in the machine's local frame.

    openings: list of dicts {seg, s0, s1, kind} where kind is gate, curtain
    or open; s0/s1 are metres along that segment from its start.
    names: optional overrides for the part names (posts, mesh, frame, kick).
    """
    names = names or {}
    posts = m.part(names.get("posts", "FENCE_POSTS"), post_mat)
    mesh = m.part(names.get("mesh", "FENCE_MESH"), "mesh_panel")
    frame = m.part(names.get("frame", "FENCE_FRAMES"), "dark_grey")
    kick = m.part(names.get("kick", "FENCE_KICK_PLATES"), "dark_grey")
    gate_p = m.part(names.get("gate", "FENCE_GATE"), post_mat)
    curtain = m.part(names.get("curtain", "FENCE_LIGHT_CURTAIN"), "safety_yellow")
    curtain_led = m.part(names.get("curtain_led", "FENCE_LIGHT_CURTAIN_LED"), "led_red")
    lock = m.part(names.get("lock", "FENCE_INTERLOCK"), "safety_red")

    P = [np.asarray(p, float) for p in pts]
    if closed:
        P = P + [P[0]]
    post_spots = []
    for si, (a, b) in enumerate(zip(P[:-1], P[1:])):
        L = float(np.linalg.norm(b - a))
        d = (b - a) / L
        ang = math.degrees(math.atan2(d[1], d[0]))
        ops = sorted([o for o in openings if o["seg"] == si], key=lambda o: o["s0"])
        # solid runs between openings
        runs, cur = [], 0.0
        for o in ops:
            runs.append((cur, o["s0"])); cur = o["s1"]
        runs.append((cur, L))
        for (r0, r1) in runs:
            if r1 - r0 < 0.05:
                continue
            n = max(1, int(math.ceil((r1 - r0) / max_panel)))
            for k in range(n):
                s0 = r0 + (r1 - r0) * k / n
                s1 = r0 + (r1 - r0) * (k + 1) / n
                c = a + d * (s0 + s1) / 2
                w = s1 - s0 - 0.07
                M = T(c[0], c[1], 0) @ Rz(ang)
                mesh.add(plane(w, height - KICK_H - 0.06), M @ T(0, 0, KICK_H + (height - KICK_H) / 2) @ Rx(90), uv="box", tile=0.4)
                kick.add(box(), M @ T(0, 0, KICK_H / 2 + 0.01) @ S(w, 0.012, KICK_H))
                for zz in (KICK_H + 0.01, height - 0.02):
                    frame.add(box(), M @ T(0, 0, zz) @ S(w, 0.025, 0.025))
                for sx in (-w / 2, w / 2):
                    frame.add(box(), M @ T(sx, 0, (KICK_H + height) / 2) @ S(0.02, 0.025, height - KICK_H))
                post_spots += [a + d * s0, a + d * s1]
        for o in ops:
            s0, s1 = o["s0"], o["s1"]
            c = a + d * (s0 + s1) / 2
            M = T(c[0], c[1], 0) @ Rz(ang)
            w = s1 - s0
            post_spots += [a + d * s0, a + d * s1]
            if o["kind"] == "gate":
                gw = w - 0.12
                M2 = M @ T(-w / 2 + 0.06, 0, 0) @ Rz(-12) @ T(gw / 2, 0, 0)      # slightly ajar
                mesh.add(plane(gw - 0.06, height - KICK_H - 0.1), M2 @ T(0, 0, KICK_H + (height - KICK_H) / 2) @ Rx(90), uv="box", tile=0.4)
                for zz in (KICK_H + 0.02, height - 0.04, (KICK_H + height) / 2):
                    gate_p.add(box(), M2 @ T(0, 0, zz) @ S(gw, 0.035, 0.035))
                for sx in (-gw / 2, gw / 2):
                    gate_p.add(box(), M2 @ T(sx, 0, (KICK_H + height) / 2) @ S(0.035, 0.035, height - KICK_H))
                lock.add(rbox(0.06, 0.05, 0.16, 0.008), M @ T(w / 2 - 0.08, -0.05, 1.1))
            elif o["kind"] == "curtain":
                for sx in (-w / 2 + 0.05, w / 2 - 0.05):
                    curtain.add(rbox(0.05, 0.05, 1.9, 0.008), M @ T(sx, -0.05, 0.95 + 0.05))
                    curtain_led.add(box(), M @ T(sx + (0.027 if sx < 0 else -0.027), -0.05, 1.0) @ S(0.006, 0.02, 1.75))
                frame.add(box(), M @ T(0, 0, height - 0.02) @ S(w, 0.025, 0.025))       # header
    # posts, de-duplicated
    seen = []
    for p in post_spots:
        if any(np.linalg.norm(p - q) < 0.05 for q in seen):
            continue
        seen.append(p)
        posts.add(rbox(0.06, 0.06, height + 0.05, 0.006), T(p[0], p[1], (height + 0.05) / 2))
        posts.add(box(), T(p[0], p[1], 0.005) @ S(0.16, 0.16, 0.01))
    out = {}
    for key, part in (("posts", posts), ("mesh", mesh), ("frame", frame), ("kick", kick), ("gate", gate_p),
                      ("curtain", curtain), ("curtain_led", curtain_led), ("lock", lock)):
        out[key] = part
    return out


def finish_fence(parts, label_prefix="Safety fence"):
    labels = {"posts": f"{label_prefix} posts", "mesh": f"{label_prefix} mesh panels", "gate": f"{label_prefix} gate",
              "curtain": f"{label_prefix} light curtain", "lock": f"{label_prefix} gate interlock"}
    for key, part in parts.items():
        part.done(label=labels.get(key), role="safety" if key in labels else None, tags=("fence",) if key in labels else ())


# =============================================================================
# part: 57_car.py
# =============================================================================
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


# =============================================================================
# part: 58_props.py
# =============================================================================
# =============================================================================
#  Props: the things that make a plant look worked in
#
#  Every function adds to an MB in world coordinates via a matrix M, so props
#  merge into the per-bay scenery batches. Sizes are real: Euro pallet
#  1.2 x 0.8 m, small load carrier 0.6 x 0.4 m, steel coil up to 1.8 m across.
# =============================================================================

def prop_pallet(mb, M, load=None, h_load=0.9, colour="cardboard"):
    for sx in (-0.55, 0.0, 0.55):
        mb.add(box(), M @ T(sx, 0, 0.055) @ S(0.1, 0.8, 0.07), "wood")
    for sy in (-0.35, 0.0, 0.35):
        mb.add(box(), M @ T(0, sy, 0.125) @ S(1.2, 0.1, 0.022), "wood")
        mb.add(box(), M @ T(0, sy, 0.012) @ S(1.2, 0.1, 0.022), "wood")
    if load == "boxes":
        for ix in (-0.3, 0.3):
            for iy in (-0.2, 0.2):
                hh = h_load * (0.75 + 0.25 * ((ix + iy + 1) % 1.0))
                mb.add(rbox(0.58, 0.38, hh, 0.01), M @ T(ix, iy, 0.136 + hh / 2), colour)
    elif load == "bins":
        for ix in (-0.3, 0.3):
            for iy in (-0.2, 0.2):
                for lev in range(3):
                    mb.add(rbox(0.58, 0.38, 0.27, 0.01), M @ T(ix, iy, 0.136 + 0.135 + lev * 0.28), colour)
    elif load == "block":
        mb.add(rbox(1.18, 0.78, h_load, 0.02), M @ T(0, 0, 0.136 + h_load / 2), colour)


def prop_klt(mb, M, colour="bin_blue"):
    """Small load carrier, 600 x 400 x 280 mm, open top."""
    mb.add(rbox(0.6, 0.4, 0.02, 0.005), M @ T(0, 0, 0.01), colour)
    for (cx, cy, sx, sy) in ((0, -0.19, 0.6, 0.02), (0, 0.19, 0.6, 0.02), (-0.29, 0, 0.02, 0.4), (0.29, 0, 0.02, 0.4)):
        mb.add(box(), M @ T(cx, cy, 0.14) @ S(sx, sy, 0.28), colour)


def prop_flow_rack(mb, M, w=2.4, d=1.2, h=1.9, levels=3, colour="bin_blue"):
    """Gravity flow rack at the line side, with small load carriers."""
    for sx in (-w / 2, w / 2):
        for sy in (-d / 2, d / 2):
            mb.add(box(), M @ T(sx, sy, h / 2) @ S(0.04, 0.04, h), "aluminium")
    for lev in range(levels):
        z = 0.45 + lev * (h - 0.5) / levels
        tilt = Rx(-8)
        mb.add(box(), M @ T(0, 0, z) @ tilt @ S(w, d, 0.02), "aluminium")
        for k in range(int(w / 0.62)):
            prop_klt(mb, M @ T(-w / 2 + 0.33 + k * 0.62, -0.1, z + 0.02) @ tilt, colour)


def prop_coil(mb, M, r=0.85, w=1.4, bore=0.31):
    """Steel coil on a cradle, axis along local X."""
    mb.add(tube(r, bore, w, 48), M @ T(0, 0, r + 0.05) @ Ry(90), "steel_coil")
    for k in np.linspace(-w / 2 + 0.15, w / 2 - 0.15, 3):
        mb.add(box(), M @ T(k, 0, r * 0.62) @ Rx(0) @ S(0.06, r * 1.1, 0.03), "steel_dark")      # straps
    for sy in (-0.45, 0.45):
        mb.add(box(), M @ T(0, sy, 0.12) @ S(w * 0.9, 0.35, 0.24), "wood")


def prop_die(mb, M, sx=3.4, sy=2.0, sz=1.15, colour="die_steel"):
    mb.add(rbox(sx, sy, sz * 0.45, 0.03), M @ T(0, 0, sz * 0.225), colour)
    mb.add(rbox(sx, sy, sz * 0.45, 0.03), M @ T(0, 0, sz * 0.55 + sz * 0.225), colour)
    for ix in (-1, 1):
        for iy in (-1, 1):
            mb.add(cyl(0.06, sz * 0.15, 12), M @ T(ix * (sx / 2 - 0.25), iy * (sy / 2 - 0.25), sz * 0.475), "chrome")
    mb.add(box(), M @ T(0, -sy / 2 - 0.005, sz * 0.75) @ S(0.6, 0.012, 0.2), "safety_yellow")


def prop_panel_rack(mb, M, n=10, colour="sheet_steel", w=2.6, d=1.4, h=1.6):
    """Steel stillage holding stamped panels on edge."""
    for sx in (-w / 2, w / 2):
        for sy in (-d / 2, d / 2):
            mb.add(box(), M @ T(sx, sy, h / 2) @ S(0.08, 0.08, h), "safety_yellow")
        mb.add(box(), M @ T(sx, 0, 0.12) @ S(0.08, d, 0.1), "safety_yellow")
    for sy in (-d / 2, d / 2):
        mb.add(box(), M @ T(0, sy, 0.12) @ S(w, 0.08, 0.1), "safety_yellow")
        mb.add(box(), M @ T(0, sy, h - 0.04) @ S(w, 0.08, 0.08), "safety_yellow")
    for k in range(n):
        x = -w / 2 + 0.3 + k * (w - 0.6) / max(n - 1, 1)
        mb.add(rbox(0.012, d - 0.25, h - 0.45, 0.004), M @ T(x, 0, 0.2 + (h - 0.45) / 2) @ Ry(8), colour)


def prop_barrel(mb, M, colour="signal_blue"):
    mb.add(fcyl(0.29, 0.88, 0.02, 20), M @ T(0, 0, 0.44), colour)
    for z in (0.3, 0.6):
        mb.add(torus(0.292, 0.012, 20, 4), M @ T(0, 0, z), colour)


def prop_workbench(mb, M, w=1.8, d=0.8):
    mb.add(rbox(w, d, 0.05, 0.01), M @ T(0, 0, 0.9), "wood")
    for sx in (-w / 2 + 0.05, w / 2 - 0.05):
        for sy in (-d / 2 + 0.05, d / 2 - 0.05):
            mb.add(box(), M @ T(sx, sy, 0.45) @ S(0.05, 0.05, 0.88), "signal_blue")
    mb.add(box(), M @ T(0, 0, 0.15) @ S(w - 0.1, d - 0.1, 0.02), "steel_dark")
    mb.add(box(), M @ T(0, d / 2 - 0.02, 1.35) @ S(w, 0.02, 0.85), "steel_dark")       # tool wall
    for k in range(6):
        mb.add(box(), M @ T(-w / 2 + 0.2 + k * 0.28, d / 2 - 0.05, 1.4) @ S(0.04, 0.04, 0.2), "safety_red")


def prop_safety_station(mb, M):
    """Fire extinguisher, eye wash and first aid board on a post."""
    mb.add(box(), M @ T(0, 0, 1.0) @ S(0.08, 0.08, 2.0), "safety_red")
    mb.add(rbox(0.5, 0.03, 0.6, 0.01), M @ T(0, -0.06, 1.7), "signal_green")
    mb.add(fcyl(0.08, 0.5, 0.02, 16), M @ T(0.18, -0.1, 0.55), "safety_red")
    mb.add(dome(0.08, 0.05, 16, 3), M @ T(0.18, -0.1, 0.8), "safety_red")


def prop_cabinet(mb, M, w=1.0, d=0.5, h=1.95, colour="signal_blue"):
    mb.add(rbox(w, d, h, 0.015), M @ T(0, 0, h / 2), colour)
    mb.add(box(), M @ T(0, -d / 2 - 0.005, h * 0.55) @ S(0.01, 0.01, 0.2), "chrome")


# ---------------------------------------------------------------- vehicles (machines, merged)
def build_forklift(prefix, x, y, heading, coll, zone, colour="safety_yellow", fork_h=0.15):
    m = Machine(prefix, T(x, y, 0) @ Rz(heading), coll, zone, hero=False)
    b = m.part("BODY", colour)
    b.add(rbox(1.9, 1.1, 0.75, 0.08, 2), T(-0.2, 0, 0.55))
    b.add(rbox(0.6, 1.1, 0.7, 0.1), T(-0.95, 0, 0.95))                              # counterweight
    b.add(rbox(0.7, 0.9, 0.25, 0.05), T(-0.1, 0, 1.05))                              # seat base
    b.done()
    g = m.part("GUARD", "graphite")
    for sx in (0.35, -0.75):
        for sy in (-0.5, 0.5):
            g.add(box(), T(sx, sy, 1.5) @ S(0.06, 0.06, 1.1))
    g.add(box(), T(-0.2, 0, 2.08) @ S(1.25, 1.06, 0.06))
    for k in np.linspace(-0.7, 0.3, 6):
        g.add(box(), T(k, 0, 2.1) @ S(0.03, 1.0, 0.03))
    g.add(rbox(0.45, 0.45, 0.5, 0.05), T(-0.25, 0, 1.37), )
    g.done()
    w = m.part("WHEELS", "tire")
    for (wx, r) in ((0.45, 0.32), (-0.85, 0.26)):
        for sy in (-0.47, 0.47):
            w.add(cyl(r, 0.22, 20), T(wx, sy, r) @ Rx(90))
    w.done()
    mast = m.part("MAST", "graphite")
    for sy in (-0.32, 0.32):
        mast.add(box(), T(0.85, sy, 1.25) @ S(0.1, 0.08, 2.4))
    mast.add(box(), T(0.86, 0, 2.4) @ S(0.1, 0.72, 0.08))
    mast.add(box(), T(0.95, 0, fork_h + 0.45) @ S(0.06, 0.8, 0.5))
    mast.done()
    f = m.part("FORKS", "steel_dark")
    for sy in (-0.25, 0.25):
        f.add(box(), T(1.5, sy, fork_h) @ S(1.15, 0.12, 0.045))
        f.add(box(), T(0.97, sy, fork_h + 0.35) @ S(0.045, 0.12, 0.7))
    f.done()
    footprint(x, y, 3.0, 1.2, heading, 0.45, 0.35)
    return m.finish()


def build_agv(prefix, x, y, heading, coll, zone, load=None, colour="signal_blue"):
    """Low automated guided vehicle (1.6 x 0.9 m) with optional load."""
    m = Machine(prefix, T(x, y, 0) @ Rz(heading), coll, zone, hero=False)
    b = m.part("BODY", "graphite")
    b.add(rbox(1.6, 0.9, 0.28, 0.04, 2), T(0, 0, 0.17))
    b.done()
    t = m.part("TRIM", colour)
    t.add(box(), T(0, 0, 0.31) @ S(1.5, 0.82, 0.02))
    t.done()
    s = m.part("SCANNERS", "safety_yellow")
    for sx in (-0.82, 0.82):
        s.add(fcyl(0.06, 0.1, 0.01, 12), T(sx, 0, 0.3))
    s.done()
    l = m.part("LIGHTS", "led_blue")
    l.add(box(), T(0.805, 0, 0.18) @ S(0.01, 0.6, 0.03))
    l.done()
    if load == "rack":
        prop_panel_rack(m.mb, m.frame @ T(0, 0, 0.32), n=8, w=1.5, d=0.85, h=1.2)
    elif load == "battery":
        m.mb.add(rbox(1.5, 0.85, 0.16, 0.02), m.frame @ T(0, 0, 0.4), "graphite")
        m.mb.add(box(), m.frame @ T(0, 0, 0.49) @ S(1.3, 0.7, 0.02), "safety_red")
    elif load == "klt":
        for ix in (-0.45, 0.15):
            for iy in (-0.2, 0.2):
                prop_klt(m.mb, m.frame @ T(ix + 0.15, iy, 0.32))
    footprint(x, y, 1.7, 1.0, heading, 0.4, 0.25)
    return m.finish()


def build_tugger_train(prefix, x, y, heading, coll, zone, carts=3):
    m = Machine(prefix, T(x, y, 0) @ Rz(heading), coll, zone, hero=False)
    tr = m.part("TRACTOR", "signal_blue")
    tr.add(rbox(1.5, 0.9, 0.7, 0.06, 2), T(0, 0, 0.5))
    tr.add(rbox(0.5, 0.86, 0.5, 0.05), T(-0.45, 0, 1.05))
    tr.done()
    g = m.part("GUARD", "graphite")
    g.add(box(), T(-0.7, 0, 1.4) @ S(0.05, 0.86, 0.05))
    for sy in (-0.42, 0.42):
        g.add(box(), T(-0.7, sy, 1.0) @ S(0.05, 0.05, 0.8))
    g.done()
    w = m.part("WHEELS", "tire")
    for wx in (0.5, -0.45):
        for sy in (-0.42, 0.42):
            w.add(cyl(0.2, 0.15, 16), T(wx, sy, 0.2) @ Rx(90))
    xc = -1.25
    for c in range(carts):
        cx = xc - 1.05 - c * 2.1
        f = m.part("CART", "steel_dark")
        f.add(box(), T(cx, 0, 0.35) @ S(1.8, 0.9, 0.05))
        f.add(box(), T(cx + 1.0, 0, 0.3) @ S(0.25, 0.05, 0.05))
        for sx in (-0.85, 0.85):
            for sy in (-0.42, 0.42):
                f.add(box(), T(cx + sx, sy, 0.9) @ S(0.04, 0.04, 1.1))
        f.add(box(), T(cx, 0, 1.0) @ S(1.8, 0.9, 0.03))
        f.done()
        for sx in (-0.7, 0.7):
            for sy in (-0.38, 0.38):
                w.add(cyl(0.1, 0.06, 12), T(cx + sx, sy, 0.1) @ Rx(90))
        for ix in (-0.6, 0.0, 0.6):
            for lev, z in enumerate((0.38, 1.03)):
                prop_klt(m.mb, m.frame @ T(cx + ix, 0.0, z), "bin_yellow" if lev else "bin_blue")
    w.done()
    fx, fy = apply_point(m.frame, (-1.25 - carts * 1.05, 0, 0))[:2]
    footprint(fx, fy, 2.1 * carts + 1.5, 1.0, heading, 0.4, 0.3)
    return m.finish()


# =============================================================================
# part: 60_hero_robot.py
# =============================================================================
# =============================================================================
#  ROBOT-WELD-01: the instrumented spot-welding cell (body shop, front row)
#
#  Cell 12.5 m x 10.5 m inside a 2.2 m fence. The robot stands 1.1 m from the
#  east fence, so its 2.7 m reach (3.5 m to the electrode tips) stays inside
#  the guarded zone; the body arrives on a roller conveyor through a muted
#  light-curtain opening in the west fence.
# =============================================================================

def build_fixture(m, x, y, z_top=0.66, length=4.3, width=1.5, hero=False):
    """Welding fixture under a body: base frame, locators, pneumatic clamps."""
    base = m.part("FIXTURE", "steel_dark")
    for sy in (-width / 2, width / 2):
        base.add(ibeam(0.24, 0.14, 0.01, 0.014), between((x - length / 2, y + sy, 0.12), (x + length / 2, y + sy, 0.12)))
    for sx in np.linspace(-length / 2 + 0.2, length / 2 - 0.2, 5):
        base.add(box(), T(x + sx, y, 0.12) @ S(0.16, width + 0.14, 0.2))
    for sx in (-1.25, 1.35):
        for sy in (-1, 1):
            base.add(rbox(0.16, 0.16, z_top - 0.22, 0.01), T(x + sx, y + sy * (width / 2 - 0.05), (z_top + 0.22) / 2))
            base.add(rbox(0.22, 0.22, 0.06, 0.01), T(x + sx, y + sy * (width / 2 - 0.05), z_top - 0.03))
    base.done(label="Body welding fixture", role="fixture", tags=("fixture",))
    cl = m.part("FIXTURE_CLAMPS", "signal_blue")
    for sx in (-1.25, 1.35):
        for sy in (-1, 1):
            cx, cy = x + sx, y + sy * (width / 2 + 0.12)
            cl.add(fcyl(0.045, 0.32, 0.01, 16), T(cx, cy, z_top - 0.1) @ Rx(sy * 25))
            cl.add(rbox(0.05, 0.3, 0.05, 0.01), T(cx, cy - sy * 0.12, z_top + 0.2))
    cl.done(label="Pneumatic clamps", role="fixture", tags=("clamp",))
    pins = m.part("FIXTURE_PINS", "chrome")
    for sx in (-1.25, 1.35):
        for sy in (-1, 1):
            pins.add(cyl(0.015, 0.08, 10), T(x + sx, y + sy * (width / 2 - 0.05), z_top + 0.04))
    pins.done()


def roller_conveyor(mb, x0, x1, y, z=0.5, width=1.6, pitch=0.25, frame_mat="dark_grey", roller_mat="steel"):
    """Powered roller conveyor along X (into an env batch)."""
    for sy in (-width / 2, width / 2):
        mb.add(prism(chan_profile(0.16, 0.06, 0.006), 1.0), T(x1, y + sy, z) @ Ry(-90) @ Rz(90 if sy < 0 else -90) @ S(1, 1, x1 - x0), frame_mat)
    for xx in np.arange(x0 + 0.15, x1 - 0.1, pitch):
        mb.add(cyl(0.04, width - 0.04, 12), T(xx, y, z + 0.03) @ Rx(90), roller_mat)
    for xx in np.arange(x0 + 0.3, x1, 1.6):
        for sy in (-width / 2, width / 2):
            mb.add(box(), T(xx, y + sy, z / 2) @ S(0.06, 0.06, z), frame_mat)
            mb.add(box(), T(xx, y + sy, 0.006) @ S(0.16, 0.16, 0.012), frame_mat)


def build_hero_robot():
    coll = collection("HERO_ROBOT")
    c = LAYOUT["robot_cell"]
    x0, x1, y0, y1 = c["x0"], c["x1"], c["y0"], c["y1"]
    fx = LAYOUT["biw_fixture"]
    car_x, car_y = fx["x"], fx["y"]
    z_car = 0.40                       # rocker bottom at 0.67 m, on the fixture
    world = Machine("ROBOT_", np.eye(4), coll, "body", "robot-weld-01", hero=True)

    # body-in-white on its fixture, front towards the robot
    place_car("ROBOT_BIW", "biw", "white", car_x, car_y, z_car, 0.0, coll="HERO_ROBOT",
                    label="Body-in-white being welded", zone="body")
    build_fixture(world, car_x, car_y, z_top=0.66)
    conv = env("BODYCONV", car_x, car_y, "HERO_ROBOT")
    roller_conveyor(conv, x0 - 2.5, car_x - 2.4, car_y, z=0.5)

    # robot: base 1.1 m inside the east fence, solve the pose onto a weld point
    rx, ry = x1 - 4.6, car_y - 0.55
    rot = 180.0
    F = T(rx, ry, 0.0) @ Rz(rot)
    plinth = 0.35
    target_w = np.array([car_x + 1.72, car_y + 0.62, z_car + 0.80])        # fender apron flange
    Finv = np.linalg.inv(F)
    target_l = (Finv @ np.array([*target_w, 1.0]))[:3]
    approach_l = (Finv[:3, :3] @ np.array([0.0, 0.0, -1.0]))
    th = solve_reach(target_l, "spot_gun", plinth, approach_l, seed=(10, 35, 15, 0, 35, 0))
    if user_asset("robot"):
        # your model on the pedestal, its front (+X) facing the body
        p = world.part("PEDESTAL", "steel_dark")
        p.add(rbox(1.05, 1.05, plinth - 0.03, 0.02), T(rx, ry, (plinth - 0.03) / 2))
        p.done(label="Robot pedestal", role="structure")
        place_user_asset("robot", (rx, ry, plinth), rot, coll)
        rob = type("R", (), {"tcp": None})()
    else:
        rob = build_robot("ROBOT_", F, th, tool="spot_gun", plinth=plinth, hero=True, coll=coll, zone="body",
                          machine_id="robot-weld-01")
    if rob.tcp is not None:
        log(f"ROBOT-WELD-01 pose {tuple(round(a, 1) for a in th)}; tip error {np.linalg.norm(rob.tcp - target_w) * 1000:.0f} mm")
    footprint(rx, ry, 1.3, 1.3, 0, 0.55, 0.4)

    # floor cable trunking: pedestal to the east fence, out to the controller
    p = world.part("CABLE_TRUNKING", "dark_grey")
    path = [(rx + 0.55, ry), (x1 - 0.35, ry), (x1 - 0.35, y1 - 2.8), (x1 + 0.35, y1 - 2.8)]
    for (ax, ay), (bx, by) in zip(path[:-1], path[1:]):
        L = math.hypot(bx - ax, by - ay)
        ang = math.degrees(math.atan2(by - ay, bx - ax))
        p.add(rbox(L + 0.3, 0.3, 0.05, 0.01), T((ax + bx) / 2, (ay + by) / 2, 0.025) @ Rz(ang))
    p.done(label="Robot cable trunking", role="cabling")

    # weld spark at the tips (subtle glow), tip dresser, controllers
    if rob.tcp is not None:
        p = world.part("WELD_SPARK", "weld_glow")
        p.add(sphere(0.03, 12, 6), T(*target_w))
        p.done()
    p = world.part("TIP_DRESSER", "dark_grey")
    tdx, tdy = x1 - 1.4, y0 + 1.4
    p.add(rbox(0.3, 0.3, 1.05, 0.02), T(tdx, tdy, 0.525))
    p.add(rbox(0.5, 0.36, 0.22, 0.03), T(tdx, tdy, 1.16))
    p.done(label="Electrode tip dresser", role="tool_maintenance", tags=("tip_dresser",))
    p = world.part("TIP_DRESSER_MOTOR", "robot_orange")
    p.add(fcyl(0.08, 0.26, 0.01, 16), T(tdx - 0.32, tdy, 1.16) @ Ry(90))
    p.done()
    robot_controller("ROBOT_", T(x1 + 0.75, y1 - 2.8, 0) @ Rz(90), coll, "body", hero=True, machine_id="robot-weld-01")

    # fence: west edge has the conveyor opening, north edge the gate
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    if user_asset("fence"):
        fence_from_user_panel(pts, closed=True, coll=coll)
        parts = {}
    else:
        parts = None
    parts = parts if parts is not None else fence(world, pts, openings=[
        dict(seg=3, s0=(y1 - (car_y + 1.2)), s1=(y1 - (car_y - 1.2)), kind="curtain"),
        dict(seg=2, s0=0.6, s1=1.6, kind="gate"),
    ], names={k: f"CELL_FENCE_{k.upper()}" for k in ("posts", "mesh", "frame", "kick", "gate", "curtain", "curtain_led", "lock")})
    finish_fence(parts, "Robot cell fence")

    # beacon and operator panel at the gate, cell sign
    gx, gy = x1 - 1.1, y1
    p = world.part("CELL_BEACON", "graphite")
    p.add(cyl(0.02, 0.45, 8), T(x1, y1, 2.45))
    p.done(label="Cell stack light", role="signal", tags=("andon",))
    for i, (nm, mat) in enumerate((("CELL_BEACON_GREEN", "led_green"), ("CELL_BEACON_AMBER", "lamp_amber_off"), ("CELL_BEACON_RED", "lamp_red_off"))):
        p = world.part(nm, mat)
        p.add(fcyl(0.06, 0.1, 0.015, 20), T(x1, y1, 2.72 + i * 0.11))
        p.done()
    p = world.part("CELL_PANEL", "cabinet_grey")
    p.add(rbox(0.3, 0.16, 0.4, 0.02), T(x1 - 0.35, y1 + 0.12, 1.3))
    p.done(label="Cell operator panel", role="controls")
    p = world.part("CELL_PANEL_BUTTONS", "safety_red")
    p.add(cyl(0.035, 0.03, 16), T(x1 - 0.35, y1 + 0.21, 1.38) @ Rx(90))
    p.done()
    sign_board(world, "CELL_SIGN", "ROBOT-WELD-01", (x1 + 0.06, y0 + 2.6, 1.75), 90.0, width=2.3, height=0.42,
               size=0.2, label="ROBOT-WELD-01 cell sign")

    # floor: cell interior border, robot reach envelope, gate swing
    mark("frame", xa=x0 + 0.15, ya=y0 + 0.15, xb=x1 - 0.15, yb=y1 - 0.15, width=0.1, color=YELLOW)
    mark("ring", cx=rx, cy=ry, r=2.7, width=0.06, color=WHITE, dash=(0.5, 0.35))
    mark("hatch", xa=x0 - 1.0, ya=car_y - 1.2, xb=x0, yb=car_y + 1.2)
    mark("rect", xa=x1 - 1.7, ya=y1 + 0.1, xb=x1 - 0.5, yb=y1 + 1.2, color=YELLOW, alpha=0.35)
    footprint((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, 0, 0.08, 0.3)
    world.finish()


# =============================================================================
# part: 61_press_line.py
# =============================================================================
# =============================================================================
#  Press shop: tandem line, destacker, coil and blanking line, dies, racks
#
#  The tandem line runs east to west along y = -24: PRESS-STAMP-01 (the draw
#  press, instrumented) then three trim and flange presses at 11.5 m pitch,
#  linked by crossbar transfer feeders. Parallel to it, along y = -8, a coil
#  line (decoiler, straightener, servo feed) feeds the blanking press whose
#  blanks supply the destacker. Finished panels leave at the west end in
#  stillages and go to the body shop by AGV.
# =============================================================================

def crossbar_feeder(mb, xm, y, span=7.2, z=2.55):
    for sy in (-span / 2, span / 2):
        mb.add(rbox(0.5, 0.5, 3.4, 0.03), T(xm, y + sy, 1.7), "machine_grey")
        mb.add(rbox(0.9, 0.7, 0.55, 0.04), T(xm, y + sy, 3.65), "machine_grey")
        mb.add(rbox(0.2, 0.36, 0.5, 0.02), T(xm - 0.4, y + sy, 3.65), "graphite")
    mb.add(rbox(0.16, span, 0.16, 0.02), T(xm, y, z), "aluminium")                   # crossbar
    for k in np.linspace(-1.2, 1.2, 6):
        mb.add(cyl(0.012, 0.25, 8), T(xm, y + k, z - 0.2), "steel")
        mb.add(cyl(0.045, 0.03, 12), T(xm, y + k, z - 0.33), "rubber")
    # idle station between the presses holding a panel
    mb.add(rbox(1.8, 2.6, 0.08, 0.02), T(xm, y, 1.55), "dark_grey")
    for sx in (-0.7, 0.7):
        for sy in (-1.1, 1.1):
            mb.add(box(), T(xm + sx, y + sy, 0.78) @ S(0.08, 0.08, 1.5), "dark_grey")
    mb.add(rbox(1.3, 2.2, 0.012, 0.004), T(xm, y, 1.6), "sheet_steel")


def destacker(xc, y, coll="PRESS_SHOP"):
    """Blank destacker: two blank carts under a gantry with a vacuum frame,
    then a washer/oiler and a belt into the press (to the west, -X)."""
    mbd = env("PRESSAUTO", xc, y, coll)
    for sy in (-1.6, 1.6):
        mbd.add(rbox(2.2, 1.8, 0.35, 0.03), T(xc, y + sy, 0.25), "signal_blue")
        for k in range(4):
            mbd.add(cyl(0.08, 0.06, 10), T(xc + (k % 2 - 0.5) * 1.8, y + sy + (k // 2 - 0.5) * 1.4, 0.08) @ Rx(90), "rubber")
        mbd.add(box(), T(xc, y + sy, 0.62) @ S(1.7, 1.25, 0.38), "sheet_steel")
    for sx in (-2.3, 2.3):
        for sy in (-3.2, 3.2):
            mbd.add(rbox(0.3, 0.3, 3.6, 0.02), T(xc + sx, y + sy, 1.8), "safety_yellow")
    for sy in (-3.2, 3.2):
        mbd.add(rbox(4.9, 0.3, 0.4, 0.02), T(xc, y + sy, 3.7), "safety_yellow")
    mbd.add(rbox(0.5, 6.7, 0.4, 0.02), T(xc - 0.8, y, 3.9), "safety_yellow")
    mbd.add(rbox(0.6, 1.4, 1.6, 0.03), T(xc - 0.8, y, 2.9), "graphite")
    mbd.add(rbox(1.6, 1.1, 0.08, 0.01), T(xc - 0.8, y, 2.05), "aluminium")
    mbd.add(rbox(1.5, 1.0, 0.012, 0.004), T(xc - 0.8, y, 1.98), "sheet_steel")
    mbd.add(rbox(1.1, 2.2, 1.6, 0.04), T(xc - 3.4, y, 0.8), "panel_white")            # washer/oiler
    mbd.add(box(), T(xc - 3.4, y - 1.11, 1.0) @ S(0.6, 0.02, 0.4), "glass_dark")
    mbd.add(rbox(1.0, 1.8, 0.12, 0.02), T(xc - 4.2, y, 1.72), "dark_grey")             # belt to the press
    footprint(xc, y, 5.0, 6.8, 0, 0.25, 0.6)
    mark("frame", xa=xc - 2.6, ya=y - 3.5, xb=xc + 2.6, yb=y + 3.5, width=0.1, color=YELLOW)


def build_press_line():
    xs = LAYOUT["press_line_x"]
    y = LAYOUT["press_line_y"]
    k = 0.86
    tandem = Template("PRESS_TANDEM", lambda F: build_press("PRESSLINE_TANDEM", 0.0, 0.0, 0.0, hero=False, k=k,
                                                            frame_mat="machine_grey", body_mat="press_grey",
                                                            template=True))
    dims = press_dims(k)
    for i, x in enumerate(xs, start=1):
        F = T(x, y, 0.0) @ Rz(90.0)
        tandem.place(f"TANDEM_P{i}", F, "PRESS_SHOP", label=f"Tandem line press T{i}, 1,600 t",
                     zone="press", role="machine", tags=("press",))
        pm = Machine(f"TANDEM_P{i}_PLATE", F, "PRESS_SHOP", "press", hero=False)
        sign_board(pm, "N", f"T{i}", (0.0, -dims["Dc"] / 2 - 0.04, dims["zbr"]), 0.0, width=0.9, height=0.34,
                   size=0.2)
        pm.finish()
    for xa, xb in zip(xs[:-1], xs[1:]):                       # crossbar feeders
        xm = (xa + xb) / 2
        crossbar_feeder(env("PRESSAUTO", xm, y, "PRESS_SHOP"), xm, y)
        footprint(xm, y, 2.2, 7.6, 0, 0.3, 0.4)
    destacker(xs[0] + 5.6, y)                                 # tandem line infeed, east end
    # tandem line outfeed: belt and stillages between the two lines
    mbo = env("PRESSEOL", 22.8, y, "PRESS_SHOP")
    mbo.add(rbox(3.4, 1.4, 0.15, 0.02), T(22.6, y, 0.9), "dark_grey")
    for xx in (21.3, 23.9):
        mbo.add(box(), T(xx, y, 0.42) @ S(0.08, 1.3, 0.84), "dark_grey")
    mbo.add(rbox(1.3, 1.0, 0.012, 0.004), T(22.2, y, 0.985), "sheet_steel")
    for ry_ in (-31.5, -16.5):
        prop_panel_rack(env("PRESSEOL", 22.6, ry_, "PRESS_SHOP"), T(22.6, ry_, 0) @ Rz(90), n=9)
        footprint(22.6, ry_, 1.6, 2.8, 0, 0.4, 0.3)

    # ---- PRESS-STAMP-01 transfer line: destacker in front (east) of the press
    hp = LAYOUT["press"]
    destacker(hp["x"] + 6.4, hp["y"])

    # ---- coil line and blanking press along y = -8
    yc = -8.0
    mbc = env("COILLINE", 48.0, yc, "PRESS_SHOP")
    mbc.add(rbox(1.3, 1.1, 2.3, 0.04), T(53.6, yc, 1.15), "machine_grey")               # decoiler housing
    mbc.add(cyl(0.16, 1.2, 20), T(53.6, yc, 1.25) @ Rx(90) @ T(0, 0, -0.6), "steel")
    mbc.add(tube(0.9, 0.31, 1.3, 56), T(53.6, yc - 1.25, 1.25) @ Rx(90), "steel_coil")
    mbc.add(rbox(2.0, 1.8, 0.18, 0.02), T(53.6, yc - 0.8, 0.09), "dark_grey")
    mbc.add(rbox(1.9, 1.8, 1.7, 0.04), T(49.6, yc, 0.85), "machine_grey")               # straightener
    for k in range(5):
        mbc.add(cyl(0.09, 1.5, 16), T(48.9 + k * 0.35, yc, 1.75 + (k % 2) * 0.12) @ Rx(90), "chrome")
    mbc.add(fcyl(0.25, 0.6, 0.03, 20), T(49.6, yc + 1.2, 0.9) @ Rx(90), "motor_teal")
    mbc.add(rbox(1.0, 1.6, 1.5, 0.04), T(46.2, yc, 0.75), "machine_grey")               # servo roll feed
    mbc.add(fcyl(0.2, 0.5, 0.02, 20), T(46.2, yc + 1.05, 1.2) @ Rx(90), "motor_teal")
    strip = [(53.0, yc - 0.6, 0.62), (51.5, yc, 0.55), (50.6, yc, 1.62), (48.6, yc, 1.62), (46.6, yc, 1.55), (43.5, yc, 1.5)]
    mbc.add(sweep(fillet_path(strip, 0.6, 6), profile=rect_profile(0.004, 1.25), caps=True), None, "sheet_steel")
    build_press("PRESSLINE_BLANKING", 41.6, yc, 90.0, hero=False, k=0.62, plate_text="BLANKING",
                frame_mat="machine_grey", body_mat="press_grey")
    mbc.add(rbox(6.0, 1.3, 0.15, 0.02), T(35.2, yc, 0.86), "dark_grey")                 # exit conveyor
    for xx in np.arange(32.4, 38.2, 1.5):
        mbc.add(box(), T(xx, yc, 0.4) @ S(0.08, 1.2, 0.8), "dark_grey")
    for k, xx in enumerate((33.0, 34.8, 36.6)):
        mbc.add(rbox(1.4, 1.0, 0.012, 0.004), T(xx, yc, 0.945), "sheet_steel")
    for xx in (29.8, 27.4):
        mbc.add(rbox(2.0, 1.6, 0.3, 0.03), T(xx, yc, 0.15), "signal_blue")
        mbc.add(box(), T(xx, yc, 0.55) @ S(1.5, 1.05, 0.5), "sheet_steel")
    footprint(49.6, yc, 9.0, 3.0, 0, 0.35, 0.6)
    footprint(34.0, yc, 9.0, 2.0, 0, 0.25, 0.5)
    mark("hatch", xa=55.2, ya=yc - 1.9, xb=55.6, yb=yc + 1.0)
    mark("frame", xa=44.9, ya=yc - 2.4, xb=55.3, yb=yc + 2.4, width=0.1, color=YELLOW)

    # ---- coil storage
    for (cx, cy) in ((53.0, -14.2), (50.6, -14.2), (46.4, -14.2), (53.0, -17.0), (50.6, -17.0)):
        prop_coil(env("COILS", cx, cy, "PRESS_SHOP"), T(cx, cy, 0.0) @ Rz(90), r=0.82, w=1.3)
        footprint(cx, cy, 1.5, 1.9, 0, 0.45, 0.4)
    mark("frame", xa=45.2, ya=-18.3, xb=54.4, yb=-12.9, width=0.1, color=WHITE)

    # ---- die storage between the bolster rails, south side
    for (dx, dy) in ((42.2, -32.6), (31.8, -32.6), (17.6, -32.6), (52.0, -32.8)):
        prop_die(env("DIES", dx, dy, "PRESS_SHOP"), T(dx, dy, 0.0) @ Rz(90), 3.3, 2.0, 1.1)
        footprint(dx, dy, 2.2, 3.5, 0, 0.5, 0.4)
        mark("frame", xa=dx - 1.4, ya=dy - 2.0, xb=dx + 1.4, yb=dy + 2.0, width=0.08, color=WHITE)

    # ---- end of line: belt, inspection light tunnel, stillages, AGV
    mbe = env("PRESSEOL", 5.0, y, "PRESS_SHOP")
    mbe.add(rbox(4.0, 1.4, 0.15, 0.02), T(5.4, y, 0.9), "dark_grey")
    for xx in np.arange(3.6, 7.4, 1.25):
        mbe.add(box(), T(xx, y, 0.42) @ S(0.08, 1.3, 0.84), "dark_grey")
    mbe.add(rbox(1.3, 1.0, 0.012, 0.004), T(4.4, y, 0.985), "sheet_steel")
    for sx in (-0.9, 0.9):
        mbe.add(box(), T(5.6, y + sx, 1.45) @ S(0.06, 0.06, 1.3), "aluminium")
    mbe.add(box(), T(5.6, y, 2.1) @ S(0.3, 1.9, 0.06), "aluminium")
    for k in np.linspace(-0.7, 0.7, 6):
        mbe.add(box(), T(5.6, y + k, 2.05) @ S(0.25, 0.05, 0.03), "led_white")
    for i, ry_ in enumerate((-32.0, -29.0, -20.0, -17.0)):
        prop_panel_rack(env("PRESSEOL", 4.6, ry_, "PRESS_SHOP"), T(4.6, ry_, 0) @ Rz(90), n=9)
        footprint(4.6, ry_, 1.6, 2.8, 0, 0.4, 0.3)
    build_agv("PRESS_AGV_1", 0.0, -14.0, 90.0, "PRESS_SHOP", "press", load="rack")
    build_forklift("PRESS_FORKLIFT_1", 30.0, -14.6, 180.0, "PRESS_SHOP", "press")
    prop_safety_station(env("PRESSAUTO", 21.0, -11.6, "PRESS_SHOP"), T(21.0, -11.55, 0) @ Rz(180))
    prop_workbench(env("PRESSAUTO", 12.0, -14.0, "PRESS_SHOP"), T(12.0, -13.6, 0) @ Rz(180))
    for bx in (10.4, 10.9):
        prop_barrel(env("PRESSAUTO", bx, -15.6, "PRESS_SHOP"), T(bx, -15.6, 0), "signal_blue")
    zone_sign("PRESS SHOP", 30.0, -4.0, 7.4, 0.0)


# =============================================================================
# part: 62_body_shop.py
# =============================================================================
# =============================================================================
#  Body shop (south-west): sub-assembly cells, main framing and respot line,
#  overhead monorail to the paint shop
#
#  Main line along y = -8.2, flowing west, one station per 7.6 m:
#    respot A, respot B, framing (open-gate), respot C, geometry inspection,
#    closures. Every station is a fenced cell; identical cells share one mesh.
# =============================================================================

BODY_LINE_Y = -8.2
BODY_PITCH = 7.6
BODY_STATIONS = [(-10.6, "respot"), (-18.2, "respot"), (-25.8, "framing"), (-33.4, "respot"),
                 (-41.0, "inspect"), (-48.6, "closures")]


def side_frame_path():
    """Outline of a body side (sill, pillars, roof rail) in car coordinates (x, z)."""
    return [(-2.0, 0.42), (1.9, 0.42), (1.9, 0.85), (1.15, 0.98), (0.75, 1.42), (0.45, 1.6),
            (-1.5, 1.6), (-1.95, 1.45), (-2.1, 1.0), (-2.0, 0.42)]


def cell_robots(m, specs, plinth=0.35, tool="spot_gun"):
    for (rx, ry, rot, target, approach) in specs:
        F = T(rx, ry, 0.0) @ Rz(rot)
        Fi = np.linalg.inv(F)
        tl = (Fi @ np.array([*target, 1.0]))[:3]
        al = Fi[:3, :3] @ np.asarray(approach, float)
        th = solve_reach(tl, tool, plinth, al, seed=(0, 30, 20, 0, 30, 0))
        tip = (robot_fk(th, plinth)["M6"] @ np.array([*TOOL_TCP[tool], 1.0]))[:3]
        miss = np.linalg.norm(tip - tl) * 1000
        if miss > 30:
            log(f"  IK miss {miss:.0f} mm for robot at ({rx}, {ry}) target {target}")
        build_robot("R", F, th, tool=tool, plinth=plinth, into=m)


def build_line_cell(F, variant):
    m = Machine("BODYCELL", F, "BODY_SHOP", "body", hero=False, template=True)
    hx, hy = BODY_PITCH / 2 - 0.1, 3.2
    roller_conveyor(m.mb, -hx - 0.1, hx + 0.1, 0.0, z=0.5)
    zr = 2.0                          # roof rail height with the body on its skid
    if variant in ("respot", "closures"):
        build_fixture(m, 0.0, 0.0, z_top=0.66)
        cell_robots(m, [
            (1.7, -2.35, 90.0, (0.9, -0.72, zr), (0, 0, -1)),
            (-1.7, -2.35, 90.0, (-0.7, -0.62, zr + 0.02), (0, 0, -1)),
            (1.7, 2.35, -90.0, (0.3, 0.72, zr), (0, 0, -1)),
            (-1.7, 2.35, -90.0, (-1.2, 0.66, zr), (0, 0, -1)),
        ])
    elif variant == "framing":
        # open-gate framing station: portal frame, side gates with clamps
        for sx in (-3.0, 3.0):
            for sy in (-2.9, 2.9):
                m.mb.add(rbox(0.45, 0.45, 4.6, 0.03), T(sx, sy, 2.3), "signal_blue")
        for sy in (-2.9, 2.9):
            m.mb.add(rbox(6.45, 0.45, 0.5, 0.03), T(0, sy, 4.85), "signal_blue")
        for sx in (-3.0, 3.0):
            m.mb.add(rbox(0.45, 6.25, 0.5, 0.03), T(sx, 0, 4.85), "signal_blue")
        for sy in (-1.45, 1.45):
            m.mb.add(rbox(4.6, 0.12, 0.12, 0.02), T(0, sy, 2.6), "dark_grey")              # gate beam
            for sx in (-2.0, -0.7, 0.7, 2.0):
                m.mb.add(rbox(0.12, 0.12, 2.0, 0.02), T(sx, sy, 1.6), "dark_grey")
                m.mb.add(fcyl(0.04, 0.3, 0.01, 12), T(sx, sy * 0.9, 1.9) @ Rx(90), "signal_blue")
        build_fixture(m, 0.0, 0.0, z_top=0.66)
        cell_robots(m, [
            (2.2, -2.35, 120.0, (1.3, -0.75, zr), (0, 0, -1)),
            (-2.2, -2.35, 60.0, (-1.3, -0.7, zr), (0, 0, -1)),
            (2.2, 2.35, -120.0, (1.0, 0.75, zr), (0, 0, -1)),
            (-2.2, 2.35, -60.0, (-1.0, 0.7, zr), (0, 0, -1)),
        ])
    elif variant == "inspect":
        build_fixture(m, 0.0, 0.0, z_top=0.66)
        for (rx, ry, rot, target) in ((1.6, -2.4, 90.0, (0.6, -1.4, 1.5)), (-1.6, 2.4, -90.0, (-0.8, 1.4, 1.5))):
            F2 = T(rx, ry, 0.0) @ Rz(rot)
            Fi = np.linalg.inv(F2)
            tl = (Fi @ np.array([*target, 1.0]))[:3]
            al = Fi[:3, :3] @ _unit(np.array([0, -np.sign(ry), -0.3]))
            th = solve_reach(tl, "none", 0.35, al, seed=(0, 25, 10, 0, 20, 0))
            r = build_robot("INSPECT", F2, th, tool="none", plinth=0.35, into=m, body_mat="robot_white")
            fr = robot_fk(th, 0.35)
            Mt = F2 @ fr["M6"]
            m.mb.add(rbox(0.22, 0.3, 0.16, 0.02), Mt @ T(0.14, 0, 0), "graphite")          # blue-light scanner
            m.mb.add(box(), Mt @ T(0.255, 0, 0) @ S(0.01, 0.22, 0.1), "led_blue")
        for sx in (-3.4, 3.4):
            m.mb.add(box(), T(sx, 0, 1.8) @ S(0.1, 0.1, 3.6), "aluminium")
        m.mb.add(box(), T(0, 0, 3.6) @ S(6.9, 0.12, 0.12), "aluminium")
        for k in np.linspace(-2.8, 2.8, 8):
            m.mb.add(box(), T(k, 0, 3.52) @ S(0.5, 0.25, 0.04), "led_white")
    # controllers outside the south fence, tip dresser inside
    for cx in (-2.6, 0.7):
        robot_controller("C", T(cx, -hy - 0.55, 0.0), "BODY_SHOP", "body", into=m)
    m.mb.add(rbox(0.28, 0.28, 1.0, 0.02), T(hx - 0.6, -hy + 0.6, 0.5), "dark_grey")
    m.mb.add(rbox(0.45, 0.32, 0.2, 0.02), T(hx - 0.6, -hy + 0.6, 1.1), "dark_grey")
    pts = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    fence(m, pts, openings=[dict(seg=1, s0=hy - 1.25, s1=hy + 1.25, kind="curtain"),
                            dict(seg=3, s0=hy - 1.25, s1=hy + 1.25, kind="curtain"),
                            dict(seg=0, s0=2 * hx - 1.6, s1=2 * hx - 0.6, kind="gate")],
          post_mat="machine_grey")
    footprint(0, 0, 2 * hx, 2 * hy, 0, 0.06, 0.3)
    mark("frame", xa=-hx + 0.15, ya=-hy + 0.15, xb=hx - 0.15, yb=hy - 0.15, width=0.08, color=YELLOW)
    return m


def build_sub_cell(F):
    """Sub-assembly cell: two-station turntable, handling robot, two weld robots."""
    m = Machine("SUBCELL", F, "BODY_SHOP", "body", hero=False, template=True)
    hx, hy = 4.5, 4.0
    m.mb.add(fcyl(2.1, 0.5, 0.04, 48), T(0, 0.4, 0.25), "dark_grey")                     # turntable
    m.mb.add(rbox(4.0, 0.12, 2.2, 0.02), T(0, 0.4, 1.6), "signal_blue")                   # dividing wall
    for sy in (-0.65, 1.45):
        side = side_frame_path()
        path = [(x * 0.82, sy, 0.5 + z * 0.85) for (x, z) in side]
        m.mb.add(sweep(path, profile=rect_profile(0.12, 0.07), caps=True), None, "biw_steel")
        for k in np.linspace(-1.3, 1.3, 4):
            m.mb.add(rbox(0.12, 0.12, 0.42, 0.01), T(k, sy, 0.72), "signal_blue")         # nests
    cell_robots(m, [
        (2.4, -2.2, 135.0, (0.9, -0.65, 1.86), (0, 0, -1)),
        (-2.4, -2.2, 45.0, (-0.9, -0.65, 1.86), (0, 0, -1)),
    ])
    F3 = T(0.0, 3.0, 0.0) @ Rz(-90)
    F3i = np.linalg.inv(F3)
    th = solve_reach((F3i @ np.array([0.6, 1.45, 1.6, 1.0]))[:3], "gripper", 0.35,
                     F3i[:3, :3] @ np.array([0.0, -1.0, 0.0]), seed=(0, 20, 30, 0, 20, 0))
    build_robot("H", F3, th, tool="gripper", plinth=0.35, into=m)
    for cx in (-3.0, 0.2):
        robot_controller("C", T(cx, -hy - 0.55, 0.0), "BODY_SHOP", "body", into=m)
    pts = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    fence(m, pts, openings=[dict(seg=0, s0=6.5, s1=7.5, kind="gate"), dict(seg=2, s0=3.0, s1=6.0, kind="curtain")],
          post_mat="machine_grey")
    footprint(0, 0.4, 4.4, 4.4, 0, 0.35, 0.6)
    mark("frame", xa=-hx + 0.15, ya=-hy + 0.15, xb=hx - 0.15, yb=hy - 0.15, width=0.08, color=YELLOW)
    return m


def build_body_shop():
    coll = "BODY_SHOP"
    y = BODY_LINE_Y
    variants = {}
    for x, var in BODY_STATIONS:
        geo = "respot" if var == "closures" else var
        if geo not in variants:
            variants[geo] = Template(f"BODY_{geo.upper()}_CELL", lambda F, v=geo: build_line_cell(F, v))
        variants[geo].place(f"BODY_LINE_{var.upper()}_{int(abs(x))}", T(x, y, 0.0), coll,
                            label=f"Body line station: {var}", zone="body", role="cell", tags=("cell", var))
        stage = "biw"
        place_car(f"BODY_LINE_CAR_{int(abs(x))}", stage, "white", x, y, 0.40, 180.0, coll=coll)
    # entry and exit conveyor sections
    conv = env("BODYCONV", -5.0, y, coll)
    roller_conveyor(conv, -6.6, -3.2, y, z=0.5)
    roller_conveyor(conv, -54.0, -52.4, y, z=0.5)
    place_car("BODY_LINE_CAR_ENTRY", "biw", "white", -4.9, y, 0.40, 180.0, coll=coll)

    # sub-assembly cells, south-west
    sub = Template("BODY_SUB_CELL", build_sub_cell)
    for i, x in enumerate((-50.0, -40.0, -30.0)):
        sub.place(f"BODY_SUBASSEMBLY_{i + 1}", T(x, -27.0, 0.0), coll, label="Side frame sub-assembly cell",
                  zone="body", role="cell", tags=("cell", "subassembly"))
    for i, x in enumerate((-50.0, -40.0, -30.0)):
        prop_panel_rack(env("BODYRACK", x, -20.6, coll), T(x - 2.0, -20.6, 0) @ Rz(0), n=8, w=2.4, d=1.2, h=1.5)
        prop_panel_rack(env("BODYRACK", x, -20.6, coll), T(x + 1.0, -20.6, 0) @ Rz(0), n=8, w=2.4, d=1.2, h=1.5)
        footprint(x - 0.5, -20.6, 5.8, 1.6, 0, 0.35, 0.3)
    build_agv("BODY_AGV_1", -24.0, -17.0, 180.0, coll, "body", load="rack")
    build_agv("BODY_AGV_2", -44.0, -17.5, 0.0, coll, "body", load="rack")
    build_forklift("BODY_FORKLIFT_1", -36.5, -15.4, 0.0, coll, "body")

    # overhead electrified monorail: line end, north across the aisle into paint
    ems_x = -53.6
    mb = env("EMS", ems_x, -2.0, coll)
    path = [(ems_x, y, 6.2), (ems_x, 5.0, 6.2)]
    mb.add(ibeam(0.22, 0.12, 0.008, 0.012), between(path[0], path[1]), "struct_blue")
    for yy in np.arange(y, 5.1, 3.0):
        mb.add(cyl(0.02, SITE["eave"] - 6.3, 6), T(ems_x, yy, (SITE["eave"] + 6.3) / 2), "steel_dark")
    mb.add(rbox(1.2, 0.8, 4.8, 0.03), T(ems_x, y, 3.3), "signal_blue")                    # lift tower
    for k, cy in enumerate((-2.6, 1.6)):
        for dy in (-1.5, 1.5):
            mb.add(box(), T(ems_x, cy + dy, 5.2) @ S(0.06, 0.06, 2.0), "steel_dark")       # C-hanger legs
        mb.add(rbox(0.5, 0.35, 0.3, 0.02), T(ems_x, cy, 6.0), "safety_yellow")             # trolley
        mb.add(box(), T(ems_x, cy, 4.2) @ S(1.7, 3.2, 0.08), "steel_dark")
        place_car(f"BODY_EMS_CAR_{k + 1}", "biw", "white", ems_x, cy, 4.26 - 0.27, 90.0, coll=coll)
    mark("hatch", xa=ems_x - 1.3, ya=-3.0, xb=ems_x + 1.3, yb=3.0)
    zone_sign("BODY SHOP", -30.0, -2.0, 7.6, 0.0)
    prop_safety_station(env("BODYRACK", -21.0, -11.5, coll), T(-21.0, -11.45, 0) @ Rz(180))
    for i, x in enumerate((-14.0, -38.0)):
        prop_workbench(env("BODYRACK", x, -17.8, coll), T(x, -17.8, 0))


# =============================================================================
# part: 63_paint_shop.py
# =============================================================================
# =============================================================================
#  Paint shop (north-west): seven process tunnels, serpentine flow
#
#  Tunnels run north-south between the column lines, 5 m wide, 29 m long:
#    T1 pretreatment and e-coat dip  (north)   T5 base and clear coat booth (north)
#    T2 e-coat oven                  (south)   T6 topcoat oven              (south)
#    T3 sealer and underbody deck    (north)   T7 inspection light tunnel   (north)
#    T4 primer booth                 (south)
#  Bodies arrive on the monorail at T1's south end and leave T7's north end
#  for final assembly. Booths have glass walls and ceilings, so the painting
#  robots stay visible from the viewer's raised camera.
# =============================================================================

PAINT_Y0, PAINT_Y1 = 4.6, 33.4
PAINT_TUNNELS = [(-52.5, "ptd", 1), (-45.5, "edoven", -1), (-38.5, "sealer", 1), (-31.5, "primer", -1),
                 (-24.5, "topcoat", 1), (-17.5, "oven", -1), (-10.5, "inspect", 1)]
PAINT_W = 5.0
PAINT_COLOURS = ["white", "red", "blue", "silver", "black", "grey", "green", "sand"]


def skid_conveyor(mb, x, y0, y1, z=0.5):
    for sx in (-0.55, 0.55):
        mb.add(box(), T(x + sx, (y0 + y1) / 2, z) @ S(0.1, y1 - y0, 0.16), "dark_grey")
    for yy in np.arange(y0 + 0.5, y1, 2.0):
        mb.add(box(), T(x, yy, z / 2) @ S(1.3, 0.1, z), "dark_grey")


def tunnel_shell(x, y0, y1, w, h, roof="solid", windows=False, coll="PAINT_SHOP", wall_mat="cladding"):
    """Enclosure: walls with optional window band on the east side, roof, plinth."""
    get = lambda xx, yy: env("PAINTSHELL", xx, yy, coll)
    hw = w / 2
    # long walls; the east wall (facing the aisle and the camera) gets windows
    win = []
    if windows:
        for s in np.arange(1.5, (y1 - y0) - 2.0, 3.0):
            win.append((s, s + 2.2, 1.0, 2.8))
    _wall_run(get, (x + hw, y0), (x + hw, y1), 0.15, h, win, wall_mat, 0.12, 1.0)
    _wall_run(get, (x - hw, y0), (x - hw, y1), 0.15, h, [], wall_mat, 0.12, 1.0)
    for (s0, s1, z0, z1) in win:
        yy = y0 + (s0 + s1) / 2
        get(x + hw, yy).add(box(), T(x + hw, yy, (z0 + z1) / 2) @ S(0.03, s1 - s0, z1 - z0), "glass")
    # end walls with the conveyor opening
    for ye in (y0, y1):
        _wall_run(get, (x - hw, ye), (x + hw, ye), 0.15, h, [(hw - 1.4, hw + 1.4, 0.0, 2.8)], wall_mat, 0.12, 1.0)
    for ye in (y0, y1):
        get(x, ye).add(box(), T(x, ye, 0.075) @ S(w + 0.3, 0.3, 0.15), "concrete_block")
    for xe in (x - hw, x + hw):
        get(xe, (y0 + y1) / 2).add(box(), T(xe, (y0 + y1) / 2, 0.075) @ S(0.3, y1 - y0, 0.15), "concrete_block")
    # roof
    L = y1 - y0
    if roof == "glass":
        get(x, (y0 + y1) / 2).add(box(), T(x, (y0 + y1) / 2, h) @ S(w, L, 0.03), "glass")
        for yy in np.arange(y0, y1 + 0.01, 1.5):
            get(x, yy).add(box(), T(x, yy, h + 0.03) @ S(w + 0.1, 0.08, 0.08), "aluminium")
        for sx in (-hw, 0.0, hw):
            get(x, (y0 + y1) / 2).add(box(), T(x + sx, (y0 + y1) / 2, h + 0.03) @ S(0.1, L, 0.1), "aluminium")
    else:
        get(x, (y0 + y1) / 2).add(box(), T(x, (y0 + y1) / 2, h) @ S(w + 0.2, L + 0.2, 0.12), "insulation")
        for yy in np.arange(y0 + 1.2, y1, 2.4):
            get(x, yy).add(box(), T(x, yy, h + 0.07) @ S(w + 0.2, 0.04, 0.03), "duct")
    footprint(x, (y0 + y1) / 2, w + 0.4, L + 0.4, 0, 0.35, 0.6)


def booth_module(F):
    """9 m booth section: four painting robots on raised rails, both sides."""
    m = Machine("BOOTHMOD", F, "PAINT_SHOP", "paint", hero=False, template=True)
    for sx in (-1.95, 1.95):
        m.mb.add(rbox(0.5, 9.0, 0.8, 0.03), T(sx, 0, 0.4), "white_paint")                 # robot rail
        m.mb.add(box(), T(sx, 0, 0.82) @ S(0.25, 9.0, 0.04), "steel_dark")
    specs = [(-1.95, -2.2, 0.0, (-0.45, -1.4, 2.05), (0.6, 0, -1)), (-1.95, 2.2, 0.0, (-0.8, 2.6, 1.4), (1, 0, -0.2)),
             (1.95, -2.2, 180.0, (0.45, -0.6, 2.05), (-0.6, 0, -1)), (1.95, 2.2, 180.0, (0.85, 1.4, 1.35), (-1, 0, -0.2))]
    for (rx, ry, rot, target, approach) in specs:
        Fr = T(rx, ry, 0.0) @ Rz(rot)
        Fi = np.linalg.inv(Fr)
        tl = (Fi @ np.array([*target, 1.0]))[:3]
        al = Fi[:3, :3] @ _unit(np.asarray(approach, float))
        th = solve_reach(tl, "paint", 0.85, al, seed=(0, 20, 20, 0, 30, 0))
        build_robot("P", Fr, th, tool="paint", plinth=0.85, into=m, body_mat="paint_robot", base_mat="white_paint")
    for sy in (-3.0, 3.0):                                                                 # booth lights
        for sx in (-2.2, 2.2):
            m.mb.add(box(), T(sx, sy, 3.9) @ S(0.25, 2.4, 0.06), "led_white")
    return m


def build_paint_shop():
    coll = "PAINT_SHOP"
    y0, y1 = PAINT_Y0, PAINT_Y1
    L = y1 - y0
    booth = Template("PAINT_BOOTH_MODULE", booth_module)
    car_i = 0
    for ti, (x, kind, direction) in enumerate(PAINT_TUNNELS):
        heading = 90.0 if direction > 0 else -90.0
        conv = env("PAINTCONV", x, (y0 + y1) / 2, coll)
        skid_conveyor(conv, x, y0 + 0.2, y1 - 0.2)
        ys = list(np.arange(y0 + 3.0, y1 - 2.5, 6.0))
        if kind == "ptd":
            tunnel_shell(x, y0, y1, PAINT_W, 7.0, "solid", windows=True)
            tank_y0, tank_y1 = y0 + 7.0, y0 + 21.0
            mb = env("PAINTPROC", x, (tank_y0 + tank_y1) / 2, coll)
            mb.add(box(), T(x, (tank_y0 + tank_y1) / 2, 0.9) @ S(PAINT_W - 0.6, tank_y1 - tank_y0, 1.8), "steel_dark")
            mb.add(box(), T(x, (tank_y0 + tank_y1) / 2, 1.82) @ S(PAINT_W - 0.8, tank_y1 - tank_y0 - 0.2, 0.02), "water")
            # bodies on rotating dip carriers: entering nose-down, inverted mid-bath, leaving
            # nose-down into the bath, inverted mid-bath, nose-up leaving it
            stages = [("biw_closed", 0.0, y0 + 3.0, 1.0), ("biw_closed", 35.0, tank_y0 + 2.5, 1.9),
                      ("ecoat_closed", 180.0, (tank_y0 + tank_y1) / 2, 2.1), ("ecoat_closed", -30.0, tank_y1 - 2.0, 2.2),
                      ("ecoat_closed", 0.0, y1 - 4.0, 1.0)]
            for st, tilt, yy, zz in stages:
                place_car(f"PAINT_PTD_CAR_{car_i}", st, "white", x, yy, zz, heading, coll=coll,
                          matrix=T(x, yy, zz) @ Rz(heading) @ (Rx(180) if tilt == 180.0 else Ry(tilt)))
                car_i += 1
            for yy in np.arange(y0 + 1.0, y1, 4.0):
                mb.add(box(), T(x, yy, 6.4) @ S(0.3, 0.3, 0.3), "safety_yellow")             # carrier rail hangers
            mb.add(box(), T(x, (y0 + y1) / 2, 6.25) @ S(0.25, L - 1.0, 0.25), "steel_dark")
        elif kind in ("edoven", "oven"):
            tunnel_shell(x, y0, y1, PAINT_W, 5.2, "solid", windows=False, wall_mat="insulation")
            mb = env("PAINTPROC", x, (y0 + y1) / 2, coll)
            for yy in (y0 + 5.0, y0 + 14.0, y0 + 23.0):
                mb.add(rbox(2.6, 2.4, 1.6, 0.04), T(x, yy, 5.2 + 0.8), "white_paint")          # burner units
                mb.add(cyl(0.35, 1.2, 16), T(x + 0.9, yy, 7.4), "duct")
                mb.add(cyl(0.3, 16.2 - 7.4, 16), T(x - 0.6, yy + 0.6, (16.2 + 6.8) / 2), "duct")  # exhaust stack
                mb.add(cyl(0.34, 0.25, 16), T(x - 0.6, yy + 0.6, 16.3), "steel_dark")
            st = "ecoat_closed" if kind == "edoven" else "paintshell"
            for yy in (y0 + 3.0, y1 - 3.0):
                col = PAINT_COLOURS[car_i % len(PAINT_COLOURS)]
                place_car(f"PAINT_OVEN_CAR_{car_i}", st, col, x, yy, 0.62, heading, coll=coll)
                car_i += 1
        elif kind == "sealer":
            mb = env("PAINTPROC", x, (y0 + y1) / 2, coll)
            for sx in (-PAINT_W / 2, PAINT_W / 2):                                           # open deck, handrails
                mb.add(box(), T(x + sx, (y0 + y1) / 2, 0.075) @ S(0.3, L, 0.15), "concrete_block")
            sealer = Template("PAINT_SEALER_ROBOT", lambda F: _sealer_pair(F))
            for k, yy in enumerate(ys):
                place_car(f"PAINT_SEALER_CAR_{car_i}", "ecoat_closed", "white", x, yy, 0.62, heading, coll=coll)
                car_i += 1
                if k in (1, 3):
                    sealer.place(f"PAINT_SEALER_ROBOTS_{k}", T(x, yy, 0.0), coll)
            for yy in np.arange(y0 + 1.0, y1, 4.0):
                mb.add(box(), T(x + PAINT_W / 2 + 0.6, yy, 0.6) @ S(0.05, 0.05, 1.2), "safety_yellow")
            mb.add(box(), T(x + PAINT_W / 2 + 0.6, (y0 + y1) / 2, 1.2) @ S(0.05, L, 0.05), "safety_yellow")
        elif kind in ("primer", "topcoat"):
            tunnel_shell(x, y0, y1, PAINT_W, 4.4, "glass", windows=True)
            for k, yy in enumerate((y0 + 8.5, y0 + 19.5)):
                booth.place(f"PAINT_{kind.upper()}_BOOTH_{k + 1}", T(x, yy, 0.0) @ Rz(0 if direction > 0 else 180), coll,
                            label=f"{'Primer' if kind == 'primer' else 'Base and clear coat'} booth, robot zone {k + 1}",
                            zone="paint", role="cell", tags=("paint_booth",))
            for yy in ys:
                st = "primer_closed" if kind == "primer" else "paintshell"
                col = PAINT_COLOURS[car_i % len(PAINT_COLOURS)]
                place_car(f"PAINT_BOOTH_CAR_{car_i}", st, col, x, yy, 0.62, heading, coll=coll)
                car_i += 1
            mb = env("PAINTPROC", x, (y0 + y1) / 2, coll)
            mb.add(rbox(PAINT_W - 1.0, L - 2.0, 1.1, 0.05), T(x, (y0 + y1) / 2, 4.4 + 0.6), "white_paint")  # supply plenum
            for yy in (y0 + 6.0, y1 - 6.0):
                mb.add(cyl(0.45, 16.0 - 5.5, 16), T(x + 1.4, yy, (16.0 + 5.5) / 2), "duct")
                mb.add(cyl(0.5, 0.3, 16), T(x + 1.4, yy, 16.1), "steel_dark")
        elif kind == "inspect":
            mb = env("PAINTPROC", x, (y0 + y1) / 2, coll)
            for yy in np.arange(y0 + 2.0, y1 - 1.0, 1.2):                                     # light tunnel arches
                for sx in (-2.0, 2.0):
                    mb.add(box(), T(x + sx, yy, 1.4) @ S(0.08, 0.08, 2.8), "aluminium")
                mb.add(box(), T(x, yy, 2.85) @ S(4.1, 0.08, 0.08), "aluminium")
                mb.add(box(), T(x, yy, 2.78) @ S(3.6, 0.05, 0.03), "led_white")
                for sx in (-1.95, 1.95):
                    mb.add(box(), T(x + sx, yy, 1.5) @ S(0.03, 0.05, 2.2), "led_white")
            for yy in ys[::2]:
                col = PAINT_COLOURS[car_i % len(PAINT_COLOURS)]
                place_car(f"PAINT_INSPECT_CAR_{car_i}", "paintshell", col, x, yy, 0.62, heading, coll=coll)
                car_i += 1
            prop_workbench(mb, T(x + 3.6, y0 + 10.0, 0) @ Rz(90))
        # transfer between tunnels at the ends
        if ti < len(PAINT_TUNNELS) - 1:
            x2 = PAINT_TUNNELS[ti + 1][0]
            ye = y1 + 1.0 if direction > 0 else y0 - 1.0
            mb = env("PAINTPROC", (x + x2) / 2, ye, coll)
            mb.add(rbox(abs(x2 - x) + 1.6, 2.2, 3.0, 0.04), T((x + x2) / 2, ye, 1.5), "cladding", uv="box", tile=1.0)
    # exit transfer from T7 to final assembly (along the north side)
    mb = env("PAINTPROC", -5.0, y1 + 1.0, coll)
    mb.add(rbox(10.0, 2.0, 3.0, 0.04), T(-5.5, y1 + 1.0, 1.5), "cladding", uv="box", tile=1.0)
    # paint mix room and supply air units against the west wall
    mb = env("PAINTPROC", -54.0, 20.0, coll)
    zone_sign("PAINT SHOP", -16.0, 2.0, 7.6, 0.0)


def _sealer_pair(F):
    m = Machine("SEALERPAIR", F, "PAINT_SHOP", "paint", hero=False, template=True)
    for (rx, rot, target, approach) in ((-2.0, 0.0, (-0.7, 0.4, 1.0), (1, 0, -0.5)), (2.0, 180.0, (0.7, -0.4, 1.0), (-1, 0, -0.5))):
        Fr = T(rx, 0.0, 0.0) @ Rz(rot)
        Fi = np.linalg.inv(Fr)
        tl = (Fi @ np.array([*target, 1.0]))[:3]
        al = Fi[:3, :3] @ _unit(np.asarray(approach, float))
        th = solve_reach(tl, "sealer", 0.3, al, seed=(0, 30, 30, 0, 30, 0))
        build_robot("S", Fr, th, tool="sealer", plinth=0.3, into=m, body_mat="paint_robot", base_mat="white_paint")
    return m


# =============================================================================
# part: 64_assembly.py
# =============================================================================
# =============================================================================
#  Final assembly (north-east): trim, chassis with EV marriage, final, EOL
#
#    trim line     y = 28.5, eastbound   painted bodies on skillets, doors off,
#                                        cockpit, seats, glazing robot
#    chassis line  y = 18.0, westbound   bodies on overhead C-hangers; battery
#                                        pack and drive units married from an AGV
#    final line    y =  7.5, eastbound   wheels, doors back on, fluids, then
#                                        alignment, roller dyno, water test
#  Station pitch 6.4 m, the usual takt spacing for a mid-size car.
# =============================================================================

TRIM_Y, CHASSIS_Y, FINAL_Y = 28.5, 18.0, 7.5
ASM_PITCH = 6.4
ASM_COLOURS = ["white", "red", "blue", "silver", "black", "grey", "white", "green", "sand", "blue", "red", "silver"]


def skillet(mb, x, y, heading=0.0):
    M = T(x, y, 0.0) @ Rz(heading)
    mb.add(rbox(5.6, 2.9, 0.3, 0.03), M @ T(0, 0, 0.15), "dark_grey")
    mb.add(box(), M @ T(0, 0, 0.305) @ S(5.5, 2.8, 0.01), "rubber")
    for sy in (-1.45, 1.45):
        mb.add(box(), M @ T(0, sy, 0.16) @ S(5.6, 0.02, 0.3), "safety_yellow")


def c_hanger(mb, x, y, z_rail, z_car):
    """Overhead C-hanger carrying a body by its sills."""
    mb.add(rbox(0.6, 0.4, 0.35, 0.03), T(x, y, z_rail - 0.25), "safety_yellow")            # trolley
    mb.add(box(), T(x, y + 1.25, (z_rail - 0.4 + z_car) / 2) @ S(0.12, 0.12, z_rail - 0.4 - z_car), "signal_blue")
    mb.add(box(), T(x, y + 0.6, z_rail - 0.45) @ S(0.12, 1.3, 0.12), "signal_blue")
    for sx in (-1.0, 1.0):
        mb.add(box(), T(x + sx, y, z_car - 0.06) @ S(0.12, 2.6, 0.1), "signal_blue")
    mb.add(box(), T(x, y + 1.25, z_car - 0.06) @ S(2.12, 0.12, 0.1), "signal_blue")


def tool_balancer(mb, x, y, z_top=3.6):
    mb.add(box(), T(x, y, z_top) @ S(0.12, 0.12, 0.12), "safety_yellow")
    mb.add(cyl(0.004, 1.6, 4), T(x, y, z_top - 0.85), "cable")
    mb.add(fcyl(0.035, 0.28, 0.01, 10), T(x, y, z_top - 1.75), "graphite")


def build_assembly():
    coll = "ASSEMBLY"
    xs = list(np.arange(5.5, 52.0, ASM_PITCH))
    ci = 0

    # ---------------------------------------------------------------- trim line
    mb = env("ASMTRIM", 28.0, TRIM_Y, coll)
    mark("rect", xa=3.0, ya=TRIM_Y - 1.6, xb=53.5, yb=TRIM_Y + 1.6, color=rgb("#5c6066"), alpha=0.85)
    mark("line", p0=(3.0, TRIM_Y - 1.65), p1=(53.5, TRIM_Y - 1.65), width=0.1, color=YELLOW)
    mark("line", p0=(3.0, TRIM_Y + 1.65), p1=(53.5, TRIM_Y + 1.65), width=0.1, color=YELLOW)
    for i, x in enumerate(xs):
        st = "paint" if i < 3 else "trim"
        skillet(env("ASMTRIM", x, TRIM_Y, coll), x, TRIM_Y)
        place_car(f"ASM_TRIM_CAR_{i + 1}", st, ASM_COLOURS[ci % len(ASM_COLOURS)], x, TRIM_Y, 0.31, 0.0, coll=coll)
        ci += 1
        for sy in (-2.6, 2.6):
            prop_flow_rack(env("ASMTRIM", x, TRIM_Y + sy, coll), T(x - 1.6, TRIM_Y + sy * 1.15, 0) @ Rz(0 if sy > 0 else 180),
                           w=2.4, d=1.0, h=1.7, levels=3, colour="bin_blue" if i % 2 else "bin_grey")
            tool_balancer(env("ASMTRIM", x, TRIM_Y + sy, coll), x + 1.2, TRIM_Y + sy * 0.6)
    # balancer rail above the line
    for sy in (-1.6, 1.6):
        mb.add(box(), T(28.0, TRIM_Y + sy * 0.4, 3.62) @ S(48.0, 0.1, 0.1), "struct_blue")
    # glazing robot at the end of the trim line, windscreen on its gripper
    gx = xs[-1] - ASM_PITCH / 2
    Fr = T(gx, TRIM_Y - 2.9, 0.0) @ Rz(90.0)
    Fi = np.linalg.inv(Fr)
    tl = (Fi @ np.array([gx + 1.1, TRIM_Y, 1.9, 1.0]))[:3]
    al = Fi[:3, :3] @ _unit(np.array([0.5, 0.0, -1.0]))
    th = solve_reach(tl, "glazing", 0.6, al, seed=(0, 20, 20, 0, 40, 0))
    with low_detail(0.5):
        r = build_robot("ASM_GLAZING_ROBOT_", Fr, th, tool="glazing", plinth=0.6, coll=coll, zone="assembly",
                        body_mat="robot_white", base_mat="robot_base")
        Mt = Fr @ robot_fk(th, 0.6)["M6"]
        env("ASMTRIM", gx, TRIM_Y, coll).add(rbox(0.02, 1.45, 0.85, 0.01), Mt @ T(0.2, 0, 0) @ Ry(0), "glass_dark")
    mark("ring", cx=gx, cy=TRIM_Y - 2.9, r=2.4, width=0.06, color=WHITE, dash=(0.4, 0.3))

    # overhead door conveyor along the north side
    mbd = env("ASMDOOR", 28.0, 33.0, coll)
    mbd.add(ibeam(0.2, 0.1, 0.008, 0.012), between((4.0, 32.8, 4.4), (52.0, 32.8, 4.4)), "struct_blue")
    for k, x in enumerate(np.arange(5.0, 51.0, 1.5)):
        col = car_paint_key(CAR_COLOURS[ASM_COLOURS[k // 4 % len(ASM_COLOURS)]])
        mbd.add(box(), T(x, 32.8, 4.1) @ S(0.05, 0.05, 0.5), "steel_dark")
        mbd.add(rbox(1.05, 0.06, 0.95, 0.03), T(x, 32.8, 3.35), col)
        mbd.add(box(), T(x - 0.2, 32.8, 3.95) @ S(0.55, 0.04, 0.3), "glass_dark")
    for x in np.arange(6.0, 52.0, 6.0):
        mbd.add(cyl(0.02, SITE["eave"] - 4.5, 6), T(x, 32.8, (SITE["eave"] + 4.5) / 2), "steel_dark")

    # ---------------------------------------------------------------- chassis line (overhead)
    z_rail, z_car = 4.9, 1.6
    mbc = env("ASMCHAS", 28.0, CHASSIS_Y, coll)
    mbc.add(ibeam(0.3, 0.16, 0.01, 0.016), between((3.0, CHASSIS_Y + 1.25, z_rail), (53.0, CHASSIS_Y + 1.25, z_rail)), "struct_blue")
    for x in np.arange(4.0, 53.0, 4.0):
        mbc.add(cyl(0.025, SITE["eave"] - z_rail, 6), T(x, CHASSIS_Y + 1.25, (SITE["eave"] + z_rail) / 2), "steel_dark")
    marry_x = 27.5
    for i, x in enumerate(reversed(xs)):
        if abs(x - marry_x) < 1.0:
            continue
        before = x > marry_x
        st = "trim" if before else "chassis"
        c_hanger(env("ASMCHAS", x, CHASSIS_Y, coll), x, CHASSIS_Y, z_rail, z_car)
        place_car(f"ASM_CHASSIS_CAR_{i + 1}", st, ASM_COLOURS[ci % len(ASM_COLOURS)], x, CHASSIS_Y, z_car - 0.27, 180.0, coll=coll)
        ci += 1
        if before:
            for sy in (-2.3, 2.3):
                prop_flow_rack(env("ASMCHAS", x, CHASSIS_Y + sy, coll), T(x, CHASSIS_Y + sy * 1.2, 0) @ Rz(0 if sy > 0 else 180),
                               w=2.0, d=0.9, h=1.6, levels=2, colour="bin_yellow")
    # marriage station: body lowered onto battery pack carried by an AGV on a lift
    mx = min(xs, key=lambda v: abs(v - marry_x))
    c_hanger(env("ASMCHAS", mx, CHASSIS_Y, coll), mx, CHASSIS_Y, z_rail, 1.05)
    place_car("ASM_MARRIAGE_CAR", "trim", "red", mx, CHASSIS_Y, 1.05 - 0.27, 180.0, coll=coll,
              label="EV marriage station: body over battery pack", zone="assembly")
    mbm = env("ASMCHAS", mx, CHASSIS_Y, coll)
    mbm.add(rbox(3.2, 2.0, 0.35, 0.03), T(mx, CHASSIS_Y, 0.18), "signal_blue")              # lift table
    for sx in (-1.2, 1.2):
        mbm.add(box(), T(mx + sx, CHASSIS_Y, 0.45) @ S(0.12, 1.6, 0.25), "chrome")
    mbm.add(rbox(2.6, 1.55, 0.16, 0.02), T(mx, CHASSIS_Y, 0.65), "graphite")                 # battery pack
    mbm.add(box(), T(mx, CHASSIS_Y, 0.74) @ S(2.3, 1.3, 0.02), "safety_red")
    for sx in (-1.41, 1.41):                                                                  # drive units
        mbm.add(rbox(0.5, 1.3, 0.35, 0.05), T(mx + sx, CHASSIS_Y, 0.62), "aluminium")
    for sx, sy in ((-1.7, -1.6), (1.7, -1.6), (-1.7, 1.6), (1.7, 1.6)):
        mbm.add(rbox(0.5, 0.5, 1.2, 0.03), T(mx + sx, CHASSIS_Y + sy, 0.6), "machine_grey")   # screwdriver towers
        mbm.add(fcyl(0.06, 0.4, 0.01, 12), T(mx + sx * 0.8, CHASSIS_Y + sy * 0.8, 1.35), "graphite")
    mark("hatch", xa=mx - 2.2, ya=CHASSIS_Y - 2.2, xb=mx + 2.2, yb=CHASSIS_Y - 1.9)
    mark("hatch", xa=mx - 2.2, ya=CHASSIS_Y + 1.9, xb=mx + 2.2, yb=CHASSIS_Y + 2.2)
    for k, ax in enumerate((mx - 9.0, mx - 13.0)):
        build_agv(f"ASM_BATTERY_AGV_{k + 1}", ax, CHASSIS_Y - 4.6, 0.0, coll, "assembly", load="battery")
    # battery buffer racks between the lines
    for x in (12.0, 16.5):
        mbr = env("ASMBAT", x, 13.6, coll)
        for lev in range(3):
            mbr.add(box(), T(x, 13.6, 0.4 + lev * 0.75) @ S(3.6, 1.8, 0.04), "steel_dark")
            mbr.add(rbox(2.4, 1.5, 0.15, 0.02), T(x, 13.6, 0.5 + lev * 0.75), "graphite")
        for sx in (-1.75, 1.75):
            for sy in (-0.85, 0.85):
                mbr.add(box(), T(x + sx, 13.6 + sy, 1.15) @ S(0.06, 0.06, 2.3), "safety_yellow")
        footprint(x, 13.6, 3.7, 1.9, 0, 0.45, 0.35)

    # ---------------------------------------------------------------- final line and EOL
    mark("rect", xa=3.0, ya=FINAL_Y - 1.6, xb=44.0, yb=FINAL_Y + 1.6, color=rgb("#5c6066"), alpha=0.85)
    mark("line", p0=(3.0, FINAL_Y - 1.65), p1=(44.0, FINAL_Y - 1.65), width=0.1, color=YELLOW)
    mark("line", p0=(3.0, FINAL_Y + 1.65), p1=(44.0, FINAL_Y + 1.65), width=0.1, color=YELLOW)
    fxs = [x for x in xs if x < 44.0]
    for i, x in enumerate(fxs):
        st = "chassis" if i < 2 else "final"
        skillet(env("ASMFINAL", x, FINAL_Y, coll), x, FINAL_Y)
        place_car(f"ASM_FINAL_CAR_{i + 1}", st, ASM_COLOURS[ci % len(ASM_COLOURS)], x, FINAL_Y, 0.31, 0.0, coll=coll)
        ci += 1
        prop_flow_rack(env("ASMFINAL", x, FINAL_Y + 2.7, coll), T(x - 1.4, FINAL_Y + 3.0, 0), w=2.0, d=0.9, h=1.6,
                       levels=2, colour="bin_blue")
        tool_balancer(env("ASMFINAL", x, FINAL_Y, coll), x + 1.0, FINAL_Y + 1.3)
    # wheel-mounting robot between the first two final-line stations
    wx = (fxs[0] + fxs[1]) / 2
    Fw = T(wx, FINAL_Y - 3.0, 0.0) @ Rz(90.0)
    Fwi = np.linalg.inv(Fw)
    tl = (Fwi @ np.array([wx + 0.6, FINAL_Y - 1.3, 0.68, 1.0]))[:3]
    al = Fwi[:3, :3] @ np.array([0.0, 1.0, 0.0])
    th = solve_reach(tl, "gripper", 0.3, al, seed=(0, 30, 50, 0, 10, 0))
    with low_detail(0.5):
        build_robot("ASM_WHEEL_ROBOT_", Fw, th, tool="gripper", plinth=0.3, coll=coll, zone="assembly")
        for k in range(4):                                                                    # wheel rack
            car_wheel(env("ASMFINAL", wx, FINAL_Y - 4.4, coll), T(wx - 1.2 + k * 0.8, FINAL_Y - 4.6, 0.37))
    # EOL: alignment rig, roller dyno with pit, water test booth
    mbe = env("ASMEOL", 49.0, FINAL_Y, coll)
    ex = 46.6
    mbe.add(rbox(5.4, 3.2, 0.35, 0.03), T(ex, FINAL_Y, 0.17), "dark_grey")                    # alignment rig
    for sx in (-1.41, 1.41):
        for sy in (-0.8, 0.8):
            mbe.add(fcyl(0.38, 0.06, 0.01, 20), T(ex + sx, FINAL_Y + sy, 0.38), "steel")
            mbe.add(rbox(0.3, 0.2, 0.5, 0.02), T(ex + sx, FINAL_Y + sy * 1.55, 0.6), "graphite")
    place_car("ASM_EOL_ALIGNMENT_CAR", "final", "blue", ex, FINAL_Y, 0.36, 0.0, coll=coll,
              label="Wheel alignment rig", zone="assembly")
    dx = 52.0
    mbe.add(box(), T(dx, FINAL_Y, -0.01) @ S(4.0, 2.6, 0.02), "graphite")                     # dyno pit cover
    for sx in (-1.41, 1.41):
        for sy in (-0.8, 0.8):
            mbe.add(cyl(0.2, 0.7, 20), T(dx + sx, FINAL_Y + sy, 0.02) @ Rx(90), "chrome")
    place_car("ASM_EOL_DYNO_CAR", "final", "white", dx, FINAL_Y, 0.04, 0.0, coll=coll, label="Roller test bench", zone="assembly")
    mbe.add(rbox(3.2, 0.6, 2.2, 0.03), T(dx, FINAL_Y - 2.8, 1.1), "cabinet_grey")             # dyno control desk
    mbe.add(box(), T(dx, FINAL_Y - 2.49, 1.6) @ S(1.6, 0.02, 0.8), "screen")
    # water test booth beside the final line exit
    wbx, wby = 49.5, 13.6
    tunnel = env("ASMEOL", wbx, wby, coll)
    for sx in (-3.5, 3.5):
        tunnel.add(box(), T(wbx + sx, wby, 1.8) @ S(0.15, 3.4, 3.6), "panel_white")
    tunnel.add(box(), T(wbx, wby, 3.65) @ S(7.15, 3.4, 0.12), "panel_white")
    tunnel.add(box(), T(wbx, wby - 1.68, 1.8) @ S(7.0, 0.04, 3.4), "glass")
    for k in np.linspace(-3.0, 3.0, 9):
        tunnel.add(cyl(0.03, 3.2, 8), T(wbx + k, wby, 3.2) @ Rx(90), "chrome")
    place_car("ASM_EOL_WATER_CAR", "final", "silver", wbx, wby, 0.0, 0.0, coll=coll, label="Water test booth", zone="assembly")

    # parts supermarket (pallet racking) against the north wall, east end
    for k in range(5):
        rx = 38.5 + k * 3.0
        rmb = env("ASMRACK", rx, 34.2, coll)
        for sx in (-1.4, 1.4):
            for sy in (-0.5, 0.5):
                rmb.add(box(), T(rx + sx, 34.2 + sy, 3.0) @ S(0.08, 0.08, 6.0), "signal_blue")
        for lev, z in enumerate((0.0, 1.9, 3.8)):
            if lev:
                for sy in (-0.5, 0.5):
                    rmb.add(box(), T(rx, 34.2 + sy, z) @ S(2.8, 0.06, 0.14), "safety_red")
            for px in (-0.68, 0.68):
                prop_pallet(rmb, T(rx + px, 34.2, z + 0.08) @ Rz(90), load="boxes" if (k + lev) % 2 else "bins",
                            colour="cardboard" if (k + lev) % 2 else "bin_grey")
        footprint(rx, 34.2, 3.0, 1.2, 0, 0.35, 0.3)
    build_tugger_train("ASM_TUGGER_1", 26.0, 23.4, 0.0, coll, "assembly", carts=3)
    build_forklift("ASM_FORKLIFT_1", 41.0, 31.5, 90.0, coll, "assembly")
    build_agv("ASM_AGV_KLT_1", 20.0, 11.0, 0.0, coll, "assembly", load="klt")
    prop_safety_station(env("ASMRACK", 21.0, 12.4, coll), T(21.0, 12.45, 0))
    zone_sign("FINAL ASSEMBLY", 30.0, 2.2, 7.6, 0.0)


# =============================================================================
# part: 65_outside.py
# =============================================================================
# =============================================================================
#  Outside: logistics yard, dispatch, utilities; plus aisle traffic inside
# =============================================================================

def truck_template(F, trailer="box", tractor=True):
    """Articulated truck backed onto a dock: trailer rear at the origin, along +X."""
    m = Machine("TRUCK", F, "LOGISTICS", "logistics", hero=False, template=True)
    L = 13.6
    if trailer == "box":
        m.mb.add(rbox(L, 2.55, 2.75, 0.04), T(L / 2, 0, 1.3 + 1.375), "white_paint")
        m.mb.add(box(), T(L / 2, 0, 1.22) @ S(L - 0.4, 2.3, 0.14), "steel_dark")
        for k in np.linspace(0.4, L - 0.4, 12):
            m.mb.add(box(), T(k, 1.28, 2.68) @ S(0.04, 0.012, 2.6), "panel_white")
            m.mb.add(box(), T(k, -1.28, 2.68) @ S(0.04, 0.012, 2.6), "panel_white")
    elif trailer == "flat":
        m.mb.add(box(), T(L / 2, 0, 1.3) @ S(L, 2.55, 0.16), "steel_dark")
    elif trailer == "carrier":
        for z in (1.0, 2.6):
            m.mb.add(box(), T(L / 2, 0, z) @ S(L, 2.5, 0.08), "steel_dark")
        for k in np.linspace(0.3, L - 0.3, 7):
            for sy in (-1.22, 1.22):
                m.mb.add(box(), T(k, sy, 1.8) @ S(0.1, 0.1, 1.8), "safety_red")
        m.mb.add(box(), T(L / 2, -1.22, 3.3) @ S(L, 0.06, 0.06), "safety_red")
        m.mb.add(box(), T(L / 2, 1.22, 3.3) @ S(L, 0.06, 0.06), "safety_red")
    for ax in (1.2, 2.5, 3.8):                                                    # trailer axles
        for sy in (-1.0, 1.0):
            m.mb.add(cyl(0.5, 0.6, 20), T(ax, sy, 0.5) @ Rx(90), "tire")
            m.mb.add(cyl(0.3, 0.62, 16), T(ax, sy, 0.5) @ Rx(90), "rim")
    for sy in (-0.9, 0.9):
        m.mb.add(box(), T(L - 2.8, sy, 0.6) @ S(0.12, 0.12, 0.9), "steel_dark")            # landing legs
    if tractor:
        tx = L + 1.0
        m.mb.add(box(), T(tx + 1.4, 0, 0.9) @ S(5.6, 1.1, 0.35), "steel_dark")          # chassis
        m.mb.add(rbox(2.3, 2.5, 2.7, 0.12, 2), T(tx + 3.2, 0, 1.15 + 1.35), "signal_blue")  # cab
        m.mb.add(rbox(0.04, 2.2, 1.0, 0.03), T(tx + 4.36, 0, 3.0), "glass_dark")
        m.mb.add(rbox(1.7, 2.3, 0.6, 0.1), T(tx + 3.1, 0, 4.05), "signal_blue")            # roof fairing
        for ax, r in ((tx + 3.6, 0.5), (tx, 0.5), (tx - 1.3, 0.5)):
            for sy in (-1.0, 1.0):
                m.mb.add(cyl(r, 0.5, 20), T(ax, sy, r) @ Rx(90), "tire")
        m.mb.add(rbox(0.35, 2.5, 0.35, 0.05), T(tx + 4.45, 0, 0.6), "graphite")              # bumper
    return m


def build_logistics():
    coll = "LOGISTICS"
    y1 = SITE["y1"]
    box_truck = Template("TRUCK_BOX", lambda F: truck_template(F, "box", True))
    trailer_only = Template("TRAILER_BOX", lambda F: truck_template(F, "box", False))
    for k, x in enumerate((12.0, 19.0, 26.0, 33.0)):
        tpl = trailer_only if k == 2 else box_truck
        tpl.place(f"YARD_TRUCK_DOCK_{k + 1}", T(x, y1 + 0.75, 0.0) @ Rz(90.0), coll,
                  label=f"Inbound truck at dock {k + 1}", zone="logistics", role="vehicle", tags=("truck",))
        footprint(x, y1 + 8.0, 2.8, 14.0, 0, 0.45, 0.5)
    # coil delivery at the press-shop coil dock (east)
    flat = Template("TRUCK_FLAT", lambda F: truck_template(F, "flat", True))
    flat.place("YARD_COIL_TRUCK", T(SITE["x1"] + 0.8, -18.0, 0.0), coll, label="Coil delivery truck", zone="logistics",
               role="vehicle", tags=("truck",))
    for k, cx in enumerate((SITE["x1"] + 4.0, SITE["x1"] + 7.5)):
        prop_coil(env("YARD", cx, -18.0, coll), T(cx, -18.0, 1.38) @ Rz(0), r=0.8, w=1.3)
    footprint(SITE["x1"] + 9.0, -18.0, 18.0, 2.8, 0, 0.4, 0.5)

    # dispatch yard: finished cars, car transporter
    for i, y in enumerate(np.arange(4.5, 33.0, 3.0)):
        place_car(f"YARD_FINISHED_CAR_{i + 1}", "final", ASM_COLOURS[(i * 5) % len(ASM_COLOURS)], SITE["x1"] + 6.2, y,
                  -0.15, 180.0, coll=coll)
    carrier = Template("TRUCK_CAR_CARRIER", lambda F: truck_template(F, "carrier", True))
    cx0 = SITE["x1"] + 13.5
    carrier.place("YARD_CAR_TRANSPORTER", T(cx0, 6.0, 0.0) @ Rz(90.0), coll, label="Car transporter", zone="logistics",
                  role="vehicle", tags=("truck",))
    for deck, z in enumerate((1.04, 2.64)):
        for j, off in enumerate((2.5, 7.4, 12.0)):
            col = ASM_COLOURS[(deck * 3 + j * 2) % len(ASM_COLOURS)]
            place_car(f"YARD_TRANSPORTER_CAR_{deck}_{j}", "final", col, cx0, 6.0 + off, z, 90.0, coll=coll)
    footprint(cx0, 6.0 + 8.5, 2.8, 19.0, 0, 0.45, 0.5)

    # aisle traffic inside the hall
    build_tugger_train("AISLE_TUGGER_1", -18.0, 1.3, 0.0, coll, "logistics", carts=3)
    build_agv("AISLE_AGV_1", 10.0, -1.4, 180.0, coll, "logistics", load="rack")
    build_forklift("AISLE_FORKLIFT_1", -44.0, 1.2, 0.0, coll, "logistics")
    build_forklift("YARD_FORKLIFT_1", 40.0, y1 + 6.0, 200.0, coll, "logistics")
    # skips for press-shop scrap, south apron
    for k, sx in enumerate((40.0, 44.0)):
        mb = env("YARD", sx, SITE["y0"] - 5.0, coll)
        mb.add(prism([(-1.9, -1.0), (1.9, -1.0), (2.3, 1.0), (-2.3, 1.0)], 1.6), T(sx, SITE["y0"] - 5.0, -0.15) @ Rx(90) @ T(0, 1.0, -0.9), "door_green")
        footprint(sx, SITE["y0"] - 5.0, 4.6, 1.9, 0, 0.45, 0.4)


def build_utilities():
    coll = "UTILITIES"
    xw = SITE["x0"] - 7.0
    gz = -0.15
    mb = env("UTIL", xw, 20.0, coll)
    # cooling towers
    for y in (27.5, 21.0):
        mb.add(rbox(5.2, 5.2, 4.4, 0.05), T(xw, y, gz + 2.2), "panel_white")
        for k in np.linspace(-2.2, 2.2, 10):
            mb.add(box(), T(xw + 2.62, y + k, gz + 1.4) @ S(0.03, 0.25, 2.2), "galvanized")
        mb.add(cyl(1.9, 1.3, 32, r_top=2.1, caps=False), T(xw, y, gz + 5.05), "galvanized")
        mb.add(cyl(1.85, 0.02, 32), T(xw, y, gz + 4.75), "graphite")
        footprint(xw, y, 5.6, 5.6, 0, 0.5, 0.6)
    # air-cooled chillers
    for y in (13.5, 9.5):
        mb.add(rbox(6.0, 2.4, 2.3, 0.04), T(xw, y, gz + 1.15), "panel_white")
        for k in (-2.0, 0.0, 2.0):
            mb.add(cyl(0.75, 0.25, 24), T(xw + k, y, gz + 2.42), "graphite")
            mb.add(torus(0.75, 0.03, 24, 4), T(xw + k, y, gz + 2.55), "galvanized")
        footprint(xw, y, 6.2, 2.6, 0, 0.45, 0.4)
    # water tank
    mb.add(cyl(2.8, 7.5, 40), T(xw, 2.0, gz + 3.75), "galvanized")
    mb.add(dome(2.8, 0.6, 40, 4), T(xw, 2.0, gz + 7.5), "galvanized")
    for k in np.arange(0.6, 7.5, 1.0):
        mb.add(torus(2.81, 0.02, 40, 4), T(xw, 2.0, gz + k), "steel_dark")
    footprint(xw, 2.0, 5.8, 5.8, 0, 0.5, 0.6)
    # compressor house with vertical air receiver
    mb.add(rbox(7.5, 6.0, 4.4, 0.05), T(xw - 0.5, -9.0, gz + 2.2), "cladding", uv="box", tile=1.0)
    mb.add(box(), T(xw - 0.5, -9.0, gz + 4.45) @ S(7.7, 6.2, 0.15), "steel_dark")
    for k in np.linspace(-2.5, 2.5, 6):
        mb.add(box(), T(xw + 3.27, -9.0 + k * 0.8, gz + 2.8) @ S(0.04, 0.6, 1.1), "graphite")   # louvres
    mb.add(cyl(0.7, 3.6, 24), T(xw + 3.6, -4.6, gz + 1.9), "white_paint")
    mb.add(dome(0.7, 0.35, 24, 4), T(xw + 3.6, -4.6, gz + 3.7), "white_paint")
    footprint(xw - 0.5, -9.0, 7.8, 6.3, 0, 0.5, 0.6)
    # transformers in a fenced compound
    for k, y in enumerate((-22.0, -28.0)):
        mb.add(rbox(2.4, 1.6, 2.2, 0.03), T(xw, y, gz + 1.1), "door_green")
        for f in np.linspace(-1.0, 1.0, 11):
            mb.add(box(), T(xw + f, y + 0.95, gz + 1.05) @ S(0.03, 0.3, 1.7), "door_green")
            mb.add(box(), T(xw + f, y - 0.95, gz + 1.05) @ S(0.03, 0.3, 1.7), "door_green")
        for b in (-0.6, 0.0, 0.6):
            mb.add(cyl(0.07, 0.5, 10), T(xw + b, y, gz + 2.45), "white_paint")
        footprint(xw, y, 3.0, 2.4, 0, 0.5, 0.4)
    um = Machine("UTILITY_COMPOUND", np.eye(4), coll, "utilities", hero=False)
    parts = fence(um, [(xw - 2.6, -31.0), (xw + 2.6, -31.0), (xw + 2.6, -19.0), (xw - 2.6, -19.0)],
                  openings=[dict(seg=1, s0=5.0, s1=6.2, kind="gate")], post_mat="door_green")
    um.finish()
    # paint-shop exhaust: regenerative thermal oxidiser and tall stack
    mb.add(rbox(6.0, 3.0, 3.2, 0.04), T(xw, 33.0 + 0.2, gz + 1.6), "machine_grey")
    mb.add(cyl(0.9, 24.0, 32), T(xw + 2.2, 33.2, gz + 12.0), "galvanized")
    for k in (6.0, 12.0, 18.0, 23.6):
        mb.add(torus(0.92, 0.04, 32, 4), T(xw + 2.2, 33.2, gz + k), "steel_dark")
    footprint(xw, 33.2, 6.4, 3.4, 0, 0.5, 0.5)
    # pipe bridge from the utilities into the hall along the west wall
    for y in np.arange(-24.0, 30.0, 6.0):
        mb.add(box(), T(SITE["x0"] - 2.0, y, gz + 2.6) @ S(0.25, 0.25, 5.2), "steel_dark")
        mb.add(box(), T(SITE["x0"] - 2.0, y, gz + 5.25) @ S(1.6, 0.25, 0.2), "steel_dark")
    for k, (dx, r, mat) in enumerate(((-0.5, 0.16, "galvanized"), (-0.1, 0.12, "safety_red"), (0.3, 0.12, "signal_green"), (0.6, 0.08, "safety_yellow"))):
        mb.add(cyl(r, 54.0, 16, caps=False), T(SITE["x0"] - 2.0 + dx, 3.0, gz + 5.35 + r) @ Rx(90), mat)


# =============================================================================
# part: 66_people.py
# =============================================================================
# =============================================================================
#  People, for scale: simple standing operators in shop-appropriate PPE
#
#  1.75 m tall, low-poly, built once per uniform and instanced. A person beside
#  a 6.6 m press is the quickest way for the eye to read the plant's real size.
# =============================================================================

WORKER_STYLES = {
    "assembly": dict(top="signal_blue", hat="white_paint", vest=None),
    "press": dict(top="dark_grey", hat="safety_yellow", vest="hivis"),
    "body": dict(top="machine_grey", hat="white_paint", vest="hivis"),
    "paint": dict(top="white_paint", hat="white_paint", vest=None),
}


def worker_template(style):
    def build(F):
        st = WORKER_STYLES[style]
        m = Machine("WORKER", F, "PEOPLE", "site", hero=False, template=True)
        for sy in (-0.1, 0.1):
            m.mb.add(fcyl(0.075, 0.84, 0.03, 10), T(0.0, sy, 0.47), "graphite")            # legs
            m.mb.add(rbox(0.26, 0.11, 0.08, 0.03), T(0.05, sy, 0.04), "rubber")            # boots
        m.mb.add(rbox(0.26, 0.42, 0.62, 0.08, 1), T(0.0, 0.0, 1.17), st["top"])           # torso
        if st["vest"]:
            m.mb.add(rbox(0.275, 0.43, 0.36, 0.08, 1), T(0.0, 0.0, 1.2), "safety_yellow")
            m.mb.add(box(), T(0.14, 0.0, 1.12) @ S(0.01, 0.38, 0.04), "lens_clear")        # reflective band
        for sy in (-0.255, 0.255):
            m.mb.add(fcyl(0.055, 0.62, 0.03, 10), T(0.06, sy, 1.12) @ Ry(-14), st["top"])  # arms
            m.mb.add(sphere(0.05, 8, 4), T(0.14, sy, 0.82), "skin")                       # hands
        m.mb.add(cyl(0.05, 0.08, 10), T(0.0, 0.0, 1.5), "skin")                           # neck
        m.mb.add(sphere(0.105, 14, 8), T(0.0, 0.0, 1.62), "skin")                        # head
        m.mb.add(dome(0.125, 0.11, 14, 3), T(0.0, 0.0, 1.66), st["hat"])                  # helmet / cap
        m.mb.add(box(), T(0.11, 0.0, 1.665) @ S(0.08, 0.2, 0.012), st["hat"])            # brim
        return m
    return build


_WORKERS = {}


def place_worker(style, x, y, heading, name=None):
    tpl = _WORKERS.get(style)
    if tpl is None:
        tpl = _WORKERS[style] = Template(f"WORKER_{style.upper()}", worker_template(style), detail=1.0)
    n = name or f"PERSON_{style.upper()}"
    tpl.place(n, T(x, y, 0.0) @ Rz(heading), "PEOPLE")
    footprint(x, y, 0.45, 0.5, heading, 0.35, 0.18)


def build_people():
    # press shop: the operator at PRESS-STAMP-01's HMI, a die setter by the tandem line
    p = LAYOUT["press"]
    place_worker("press", p["x"] + 4.1, p["y"] + 2.4, 180.0)
    place_worker("press", 33.0, -29.8, 90.0)
    place_worker("press", 47.0, -14.6, 200.0)
    # body shop: at the panel racks and the robot cell gate
    c = LAYOUT["robot_cell"]
    place_worker("body", c["x1"] + 1.8, c["y1"] - 1.0, 180.0)
    place_worker("body", -41.0, -19.4, 270.0)
    place_worker("body", -28.0, -17.6, 90.0)
    # paint shop: inspectors at the light tunnel
    place_worker("paint", -13.6, 16.0, 0.0)
    place_worker("paint", -7.4, 22.0, 180.0)
    # final assembly: one operator beside every other trim and final-line car
    xs = list(np.arange(5.5, 52.0, ASM_PITCH))
    for i, x in enumerate(xs):
        if i % 2 == 0:
            place_worker("assembly", x + 0.6, TRIM_Y - 1.95, 90.0)
        else:
            place_worker("assembly", x - 0.8, TRIM_Y + 1.95, 270.0)
    for i, x in enumerate([v for v in xs if v < 44.0][1:]):
        if i % 2 == 0:
            place_worker("assembly", x + 0.4, FINAL_Y + 1.95, 270.0)
    for x in (24.0, 32.0):
        place_worker("assembly", x, CHASSIS_Y - 1.0, 90.0)
    # end of line and dispatch
    place_worker("assembly", 52.0, FINAL_Y - 3.6, 90.0)
    place_worker("assembly", SITE["x1"] + 9.5, 8.0, 180.0)


# =============================================================================
# part: 70_user_assets.py
# =============================================================================
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


# =============================================================================
# part: 80_bake.py
# =============================================================================
# =============================================================================
#  Bake: ambient occlusion from the finished plant into the floor textures
#
#  The twin viewer draws no real-time shadows, so contact shadows are baked:
#  Cycles traces the whole scene from every floor texel (4 m occlusion
#  distance) and the result darkens the painted floor under and around
#  machines, racks and vehicles. Runs on the GPU when one is available.
# =============================================================================

def _cycles_gpu(scene):
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
    except KeyError:
        return "CPU"
    for dev_type in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
        try:
            prefs.compute_device_type = dev_type
            prefs.refresh_devices()
            gpus = [d for d in prefs.devices if d.type == dev_type]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == dev_type
                scene.cycles.device = "GPU"
                return dev_type
        except (TypeError, AttributeError, ValueError):
            continue
    scene.cycles.device = "CPU"
    return "CPU"


def bake_floor_ao(distance=4.0, samples=96, scale=0.5):
    scene = bpy.context.scene
    try:
        scene.render.engine = "CYCLES"
    except TypeError:
        log("Cycles not available: floor bake skipped")
        return
    device = _cycles_gpu(scene)
    scene.cycles.samples = samples
    scene.render.bake.margin = 2
    if scene.world is None:
        scene.world = bpy.data.worlds.new("BakeWorld")
    scene.world.light_settings.distance = distance
    t = time.time()
    # the painted footprints were a stand-in for this: keep a little of them
    for tile in FLOOR_TILES.values():
        tile.shade = 1.0 - (1.0 - tile.shade) * 0.35
    for zone, tile in FLOOR_TILES.items():
        w, h = max(8, int(tile.w * scale)), max(8, int(tile.h * scale))
        img = bpy.data.images.new(f"_bake_{zone}", w, h, alpha=False, float_buffer=True)
        mat = bpy.data.materials.new(f"_bake_{zone}")
        if mat.node_tree is None:
            mat.use_nodes = True
        node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = img
        mat.node_tree.nodes.active = node
        pr = plane(tile.x1 - tile.x0, tile.y1 - tile.y0)
        V = pr.V + np.array([(tile.x0 + tile.x1) / 2, (tile.y0 + tile.y1) / 2, 0.003])
        me = mesh_data(f"_bake_{zone}", V, pr.N, pr.F, pr.UV, mat)
        ob = bpy.data.objects.new(f"_bake_{zone}", me)
        scene.collection.objects.link(ob)
        for o in scene.objects:
            o.select_set(False)
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        try:
            bpy.ops.object.bake(type="AO", margin=2, use_clear=True)
        except RuntimeError as exc:
            log(f"floor bake failed for {zone}: {exc}")
            bpy.data.objects.remove(ob, do_unlink=True)
            continue
        px = np.empty(w * h * 4, np.float32)
        img.pixels.foreach_get(px)
        ao = np.flipud(px.reshape(h, w, 4)[..., 0])
        # back to the floor tile's resolution
        yi = np.clip((np.arange(tile.h) * h / tile.h).astype(int), 0, h - 1)
        xi = np.clip((np.arange(tile.w) * w / tile.w).astype(int), 0, w - 1)
        ao = blur(ao[yi][:, xi], 1.2)
        tile.shade *= np.clip(0.28 + 0.72 * np.clip(ao, 0, 1) ** 1.25, 0, 1).astype(np.float32)
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.meshes.remove(me)
        bpy.data.materials.remove(mat)
        bpy.data.images.remove(img)
    log(f"floor ambient occlusion baked on {device} in {time.time() - t:.1f}s")


# =============================================================================
# part: 90_export.py
# =============================================================================
# =============================================================================
#  Export: one .glb plus a registry of the named meshes
# =============================================================================

def export_glb(path):
    """Export every object as a single binary glTF, Y-up, no compression.

    No Draco or meshopt: the twin viewer's loader would fetch decoders from a
    CDN, and a plant-floor tool must open offline.
    """
    wanted = dict(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_animations=False,
        export_draco_mesh_compression_enable=False,
        use_selection=False,
        use_visible=False,
    )
    props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    kwargs = {k: v for k, v in wanted.items() if k in props}
    bpy.ops.export_scene.gltf(**kwargs)
    return path


def write_registry(path, glb_path=None):
    data = {
        "file": GLB_NAME,
        "units": "metres; Blender Z-up, glTF/three.js Y-up: three (x, y, z) = blender (x, z, -y)",
        "generatedBy": "blender/build_car_factory.py",
        "blenderVersion": bpy.app.version_string,
        "layout": {
            "hall": {k: SITE[k] for k in ("x0", "x1", "y0", "y1", "eave")},
            "zones": ZONES,
            "instrumentedMachines": {
                "press-stamp-01": LAYOUT["press"],
                "robot-weld-01": LAYOUT["robot"],
            },
        },
        "stats": dict(STATS),
        "meshes": sorted(REGISTRY, key=lambda r: r["meshName"]),
    }
    if glb_path and os.path.exists(glb_path):
        data["stats"]["glbBytes"] = os.path.getsize(glb_path)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    return path


# =============================================================================
# part: 99_main.py
# =============================================================================
# =============================================================================
#  Main
# =============================================================================

def build_zone(name, fn):
    if not zone_enabled(name):
        return
    t = time.time()
    tri0 = STATS["triangles"]
    fn()
    log(f"zone {name:<10} {time.time() - t:5.1f}s  +{STATS['triangles'] - tri0:,} triangles")


def build_hero_press():
    p = LAYOUT["press"]
    if user_asset("press"):
        # your model, front assumed to face -Y like the procedural press
        place_user_asset("press", (p["x"], p["y"], 0.0), p["rot"], collection("HERO_PRESS"))
        press_floor_marks(T(p["x"], p["y"], 0.0) @ Rz(p["rot"]), 8.2, 5.4)
        return
    build_press("PRESS_", p["x"], p["y"], p["rot"], hero=True, k=1.0, machine_id="press-stamp-01",
                plate_text="PRESS-STAMP-01")


# Camera presets carried in the .glb as empty nodes (no geometry). The twin
# viewer starts at VIEW_HOME looking at VIEW_HOME_TARGET when both exist; the
# others are named spots the operator or the agent can fly to.
VIEW_MARKERS = {
    "HOME": ((27.0, -64.0, 34.0), (-0.5, -22.0, 0.0)),
    "PRESS_STAMP_01": ((18.5, -40.5, 8.5), (11.5, -24.0, 3.0)),
    "ROBOT_WELD_01": ((-2.5, -40.0, 7.0), (-13.0, -25.3, 1.4)),
    "PLANT": ((80.0, -95.0, 70.0), (0.0, 0.0, 0.0)),
}


def add_view_markers():
    coll = collection("SITE_VIEWS")
    for key, (eye, target) in VIEW_MARKERS.items():
        for suffix, loc in (("", eye), ("_TARGET", target)):
            ob = bpy.data.objects.new(f"VIEW_{key}{suffix}", None)
            ob.location = loc
            ob.empty_display_size = 0.6
            coll.objects.link(ob)


def main():
    log(f"Blender {bpy.app.version_string}; output {OUT_DIR}; quality {ARGS.quality}")
    clear_scene()
    setup_scene()
    standard_markings()

    build_zone("site", build_site)
    build_zone("press", build_hero_press)
    for fn_name, zone in (("build_hero_robot", "robot"), ("build_press_line", "pressline"),
                          ("build_body_shop", "body"), ("build_paint_shop", "paint"),
                          ("build_assembly", "assembly"), ("build_logistics", "logistics"),
                          ("build_utilities", "utilities"), ("build_people", "people")):
        fn = globals().get(fn_name)
        if fn is not None:
            build_zone(zone, fn)

    add_view_markers()
    made = ENV.flush(collection("SITE_MISC"))
    log(f"scenery merged into {len(made)} meshes")

    paint_floor()
    if not (DRAFT or ARGS.no_bake) and "bake_floor_ao" in globals():
        globals()["bake_floor_ao"]()
    build_floor_meshes()

    log(f"objects {STATS['objects']:,} (instances {STATS['instances']:,}), triangles {STATS['triangles']:,}")
    glb = os.path.join(OUT_DIR, GLB_NAME)
    if not ARGS.no_export:
        export_glb(glb)
        log(f"exported {glb} ({os.path.getsize(glb) / 1e6:.1f} MB)")
    write_registry(os.path.join(OUT_DIR, GLB_NAME.replace(".glb", ".registry.json")), glb)
    if ARGS.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, GLB_NAME.replace(".glb", ".blend")))
    log("done")


main()
