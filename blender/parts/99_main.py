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
