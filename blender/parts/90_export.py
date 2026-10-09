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
