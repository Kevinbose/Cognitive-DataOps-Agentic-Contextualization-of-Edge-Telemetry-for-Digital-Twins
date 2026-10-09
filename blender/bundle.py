"""Join blender/parts/*.py into the single-file script build_car_factory.py.

    python blender/bundle.py

The parts share one namespace, so the bundle is a plain concatenation in file
order. The result is what you open in Blender's Scripting workspace.
"""
import glob
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "build_car_factory.py")

chunks = []
for part in sorted(glob.glob(os.path.join(HERE, "parts", "*.py"))):
    with open(part, encoding="utf-8") as fh:
        body = fh.read().rstrip() + "\n"
    name = os.path.basename(part)
    if chunks:
        chunks.append(f"\n\n# {'=' * 77}\n# part: {name}\n# {'=' * 77}\n")
    chunks.append(body)

with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
    fh.write("".join(chunks))

lines = sum(c.count("\n") for c in chunks)
print(f"wrote {OUT} ({lines} lines)")
