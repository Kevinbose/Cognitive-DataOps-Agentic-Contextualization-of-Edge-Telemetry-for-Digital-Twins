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
