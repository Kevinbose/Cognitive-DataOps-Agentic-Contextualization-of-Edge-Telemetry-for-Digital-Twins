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
