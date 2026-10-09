"""Render review images of an exported .glb (what ships, not the build scene).

    blender -b --factory-startup -P blender/qa_render.py -- --glb out/car_factory_updated.glb
        --out out/qa --views viewer,press,robot --res 1280x720 --samples 64

Views are named presets (see VIEWS) or "x,y,z>tx,ty,tz[@lens]" in Blender
coordinates. Lighting is a soft sky plus a sun from the south-east, which is
how the open-roof cut-away reads in daylight.
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--glb", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--views", default="viewer,press,robot")
ap.add_argument("--res", default="1280x720")
ap.add_argument("--samples", type=int, default=64)
ap.add_argument("--prefix", default="")
ap.add_argument("--engine", default="CYCLES")
ap.add_argument("--format", default="PNG", choices=["PNG", "JPEG"])
args = ap.parse_args(argv)
args.out = os.path.abspath(args.out)
os.makedirs(args.out, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.abspath(args.glb))
scene = bpy.context.scene
meshes = [o for o in scene.objects if o.type == "MESH"]

# bounds, for the viewer-default framing
lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
centre = (lo + hi) / 2
radius = (hi - lo).length / 2

# world and sun
world = bpy.data.worlds.new("QA")
scene.world = world
if world.node_tree is None:
    world.use_nodes = True
bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs[0].default_value = (0.62, 0.68, 0.76, 1.0)
bg.inputs[1].default_value = 0.9
sun = bpy.data.objects.new("QA_SUN", bpy.data.lights.new("QA_SUN", "SUN"))
sun.data.energy = 3.2
sun.data.angle = math.radians(3.0)
sun.rotation_euler = (math.radians(42), 0.0, math.radians(35))
scene.collection.objects.link(sun)

try:
    scene.render.engine = args.engine
except TypeError:
    scene.render.engine = "CYCLES"
if scene.render.engine == "CYCLES":
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for dev_type in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = dev_type
            prefs.refresh_devices()
            gpus = [d for d in prefs.devices if d.type == dev_type]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == dev_type
                scene.cycles.device = "GPU"
                break
        except (TypeError, AttributeError):
            continue
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
rx, ry = (int(v) for v in args.res.split("x"))
scene.render.resolution_x, scene.render.resolution_y = rx, ry
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = args.format
if args.format == "JPEG":
    scene.render.image_settings.quality = 88

# the twin viewer frames the model's bounding sphere at 45 degrees vertical FOV,
# 1.6x padding, from three.js direction (1, 0.55, 1) = Blender (1, -1, 0.55)
fov = math.radians(45)
d_view = radius / math.sin(fov / 2) * 1.6
dir_view = Vector((1, -1, 0.55)).normalized()

VIEWS = {
    "viewer": (centre + dir_view * d_view, centre, None),
    "home": (Vector((27.0, -64.0, 34.0)), Vector((-0.5, -22.0, 0.0)), None),
    "press_hero": (Vector((17.5, -33.0, 5.5)), Vector((11.5, -24.2, 3.0)), 24),
    "paint_sw": (Vector((-66.0, -6.0, 26.0)), Vector((-30.0, 18.0, 1.0)), 24),
    "overview": (centre + dir_view * d_view * 0.42, centre + Vector((0, 0, -4)), None),
    "south": (Vector((5, -95, 38)), Vector((5, -8, 0)), 30),
    "press": (Vector((60, -42, 11)), Vector((43.5, -24, 3.0)), 28),
    "press_close": (Vector((52.5, -32.5, 5.0)), Vector((44, -24.5, 3.4)), 30),
    "press_line": (Vector((52, -6, 9)), Vector((22, -26, 2.5)), 26),
    "robot": (Vector((-3, -39.5, 6.5)), Vector((-13, -25.2, 1.3)), 30),
    "robot_close": (Vector((-6.5, -31.5, 3.0)), Vector((-12.0, -25.4, 1.6)), 32),
    "body": (Vector((-8, -44, 16)), Vector((-30, -18, 0)), 24),
    "paint": (Vector((-62, -4, 20)), Vector((-28, 18, 2)), 24),
    "assembly": (Vector((62, -2, 16)), Vector((28, 20, 1)), 24),
    "aisle": (Vector((30, -1.2, 1.7)), Vector((-20, 0.0, 2.0)), 22),
    "top": (Vector((3.5, -1.0, 300)), Vector((3.5, -0.999, 0)), "ORTHO"),
}


def view_from_spec(spec):
    if spec in VIEWS:
        return VIEWS[spec]
    lens = None
    if "@" in spec:
        spec, lens = spec.split("@")
        lens = float(lens)
    a, b = spec.split(">")
    return Vector(tuple(map(float, a.split(",")))), Vector(tuple(map(float, b.split(",")))), lens


cam_data = bpy.data.cameras.new("QA_CAM")
cam = bpy.data.objects.new("QA_CAM", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_data.clip_start = 0.1
cam_data.clip_end = 3000

for idx, name in enumerate([v.strip() for v in (args.views.split(";") if (";" in args.views or ">" in args.views) else args.views.split(",")) if v.strip()]):
    loc, tgt, lens = view_from_spec(name)
    cam.location = loc
    cam.rotation_euler = (tgt - loc).to_track_quat("-Z", "Y").to_euler()
    if lens == "ORTHO":
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = 150.0          # the site (hall plus yards) is 144 m x 104 m
    else:
        cam_data.type = "PERSP"
        if lens is None:
            cam_data.sensor_fit = "VERTICAL"
            cam_data.angle_y = fov
        else:
            cam_data.sensor_fit = "AUTO"
            cam_data.lens = lens
    label = name if name in VIEWS else f"custom{idx}"
    ext = ".jpg" if args.format == "JPEG" else ".png"
    scene.render.filepath = os.path.join(args.out, f"{args.prefix}{label}{ext}")
    bpy.ops.render.render(write_still=True)
    print("QA_RENDERED", scene.render.filepath)
