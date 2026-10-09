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
