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
