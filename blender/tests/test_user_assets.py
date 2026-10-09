"""Check that downloaded models are placed, scaled and renamed correctly.

    blender -b --factory-startup -P blender/tests/test_user_assets.py

Writes three deliberately awkward stand-in models (centimetre units, origins
far from the geometry, rotated, nested under parent empties, an OBJ), runs
the builder with --robot/--press/--fence pointing at them, and asserts the
results. Exits 1 on failure.
"""
import glob
import math
import os
import sys
import tempfile

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TMP = tempfile.mkdtemp(prefix="cdo_assets_")


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def cube(name, size, loc, parent=None):
    me = bpy.data.meshes.new(name)
    sx, sy, sz = size
    v = [(x * sx / 2, y * sy / 2, z * sz / 2) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me.from_pydata(v, [], f)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    if parent:
        ob.parent = parent
    return ob


def standins():
    # a "press" in centimetres, origin 5 m away from the geometry, inside a parent
    reset()
    root = bpy.data.objects.new("PressAssembly", None)
    bpy.context.scene.collection.objects.link(root)
    root.rotation_euler = (0, 0, math.radians(30))
    base = cube("press_bed_base", (680, 400, 100), (0, 0, 50), root)
    cube("main_motor_unit", (150, 90, 90), (-250, 120, 600), root)
    cube("Lubrication_tank", (100, 120, 80), (-480, 220, 40), root)
    cube("crown_box", (680, 360, 110), (0, 0, 495), root)
    for o in list(bpy.context.scene.objects):
        if o.type == "MESH":
            o.data.transform(Matrix.Translation(Vector((500, 0, 0))))     # origin far from geometry
            o.location.x -= 500
    press = os.path.join(TMP, "press.glb")
    bpy.ops.export_scene.gltf(filepath=press, export_format="GLB")

    # a "robot", already metres but yawed and floating well away from the origin
    reset()
    r = bpy.data.objects.new("KR210", None)
    bpy.context.scene.collection.objects.link(r)
    r.location = (12, -7, 3)
    r.rotation_euler = (0, 0, math.radians(-75))
    cube("A1_base", (0.8, 0.8, 0.5), (0, 0, 0.25), r)
    cube("axis2_lower_arm", (0.35, 0.35, 1.2), (0.3, 0, 1.1), r)
    cube("weld_gun", (0.4, 0.3, 0.4), (1.5, 0, 1.8), r)
    robot = os.path.join(TMP, "robot.glb")
    bpy.ops.export_scene.gltf(filepath=robot, export_format="GLB")

    # a fence panel as OBJ, 1.4 m wide (along Y), 2 m high
    reset()
    cube("mesh_panel", (0.03, 1.4, 2.0), (0, 0, 1.0))
    fence = os.path.join(TMP, "fence.obj")
    bpy.ops.wm.obj_export(filepath=fence)
    return press, robot, fence


press, robot, fence = standins()
sys.argv = ["blender", "--", "--quality", "draft", "--only", "site,press,robot", "--no-export",
            "--out", TMP, "--press", press, "--robot", robot, "--fence", fence]
ns = {"__name__": "__main__", "__file__": os.path.join(ROOT, "build_car_factory.py")}
for part in sorted(glob.glob(os.path.join(ROOT, "parts", "*.py"))):
    with open(part, encoding="utf-8") as fh:
        exec(compile(fh.read(), part, "exec"), ns)

failures = []


def bbox(objs):
    lo = Vector((1e9, 1e9, 1e9)); hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    return lo, hi


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        failures.append(msg)


names = {o.name for o in bpy.data.objects}
press_objs = [o for o in bpy.data.objects if o.type == "MESH" and o.users_collection and o.users_collection[0].name == "HERO_PRESS"]
check(len(press_objs) == 4, f"press: 4 imported meshes (got {len(press_objs)})")
lo, hi = bbox(press_objs)
check(abs((hi.z - lo.z) - 6.4) < 0.01, f"press scaled to 6.4 m tall (got {hi.z - lo.z:.3f})")
check(abs(lo.z) < 0.01, f"press stands on the floor (min z {lo.z:.3f})")
P = ns["LAYOUT"]["press"]
c = (lo + hi) / 2
check(abs(c.x - P["x"]) < 1.5 and abs(c.y - P["y"]) < 1.5, f"press centred near its planned spot ({c.x:.2f}, {c.y:.2f})")
check("PRESS_MAIN_MOTOR" in names, "press motor renamed PRESS_MAIN_MOTOR")
check("PRESS_LUBE_UNIT" in names, "press lubrication tank renamed PRESS_LUBE_UNIT")
check(all(o.parent is None for o in press_objs), "press flattened (no parents)")
check(all(n.isupper() or not n[0].isalpha() for n in names if n.startswith("PRESS_")), "press names upper case")

robot_objs = [bpy.data.objects[n] for n in ("ROBOT_BASE", "ROBOT_A2_LOWER_ARM", "ROBOT_WELD_GUN") if n in bpy.data.objects]
lo, hi = bbox(robot_objs)
check(abs((hi.z - lo.z) - 2.6) < 0.01, f"robot scaled to 2.6 m tall (got {hi.z - lo.z:.3f})")
check(abs(lo.z - 0.35) < 0.01, f"robot stands on its 0.35 m pedestal (min z {lo.z:.3f})")
check({"ROBOT_BASE", "ROBOT_A2_LOWER_ARM", "ROBOT_WELD_GUN"} <= names, "robot parts renamed by rule")

fence_objs = [o for o in bpy.data.objects if o.name.startswith("CELL_FENCE_PANEL_")]
check(len(fence_objs) >= 25, f"fence panels arrayed round the cell (got {len(fence_objs)})")
lo, hi = bbox(fence_objs)
check(abs((hi.z - lo.z) - ns["FENCE_H"]) < 0.01, f"fence panels {ns['FENCE_H']} m high (got {hi.z - lo.z:.3f})")
cell = ns["LAYOUT"]["robot_cell"]
check(abs(lo.x - cell["x0"]) < 0.2 and abs(hi.x - cell["x1"]) < 0.2, f"fence spans the cell in X ({lo.x:.2f}..{hi.x:.2f})")

print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
