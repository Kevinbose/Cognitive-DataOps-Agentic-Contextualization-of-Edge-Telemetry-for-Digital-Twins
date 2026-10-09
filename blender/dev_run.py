"""Run the builder straight from blender/parts (tracebacks name the part file).

    blender -b --factory-startup -P blender/dev_run.py -- --quality draft

Produces exactly what build_car_factory.py (the bundled single file) produces.
"""
import glob
import os

HERE = os.path.dirname(os.path.abspath(__file__))
namespace = {"__name__": "__main__", "__file__": os.path.join(HERE, "build_car_factory.py")}
for part in sorted(glob.glob(os.path.join(HERE, "parts", "*.py"))):
    with open(part, encoding="utf-8") as fh:
        exec(compile(fh.read(), part, "exec"), namespace)
