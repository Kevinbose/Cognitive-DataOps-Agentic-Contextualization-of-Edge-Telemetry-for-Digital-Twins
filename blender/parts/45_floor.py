# =============================================================================
#  Floor: one textured slab per department, with the paint baked into pixels
#
#  Floor paint is rasterised into the texture rather than modelled as thin
#  decals: at the viewer's default distance a few millimetres of offset z-fight,
#  and pixels cannot. Contact shadows under machines are painted the same way
#  (and refined by the ambient-occlusion bake when it runs).
# =============================================================================

FLOOR_FINISH = {
    # zone: base colour (sRGB), mottling strength, roughness
    "press":    ("#8b8c87", 0.10, 0.82),   # power-floated concrete, oiled
    "body":     ("#a2a6a4", 0.06, 0.62),   # sealed concrete
    "paint":    ("#b5b9b6", 0.04, 0.5),    # clean-room epoxy
    "assembly": ("#a9adac", 0.05, 0.55),   # epoxy
}

YELLOW = rgb("#e9b513")
WHITE = rgb("#e9eae4")
GREEN = rgb("#3f8d55")
BLACK = rgb("#1c1c1c")
RED = rgb("#b8312a")
BLUE = rgb("#2d64ad")


class FloorTile:
    def __init__(self, zone):
        z = ZONES[zone]
        self.zone = zone
        self.x0, self.x1, self.y0, self.y1 = z["x0"], z["x1"], z["y0"], z["y1"]
        self.ppm = 14.0 if DRAFT else 36.0
        self.w = int(round((self.x1 - self.x0) * self.ppm))
        self.h = int(round((self.y1 - self.y0) * self.ppm))
        self.img = None
        self.shade = np.ones((self.h, self.w), np.float32)
        self._base()

    # pixel window covering world box, with coordinate grids
    def window(self, xa, ya, xb, yb, pad=0.0):
        j0 = int(math.floor((min(xa, xb) - pad - self.x0) * self.ppm))
        j1 = int(math.ceil((max(xa, xb) + pad - self.x0) * self.ppm))
        i0 = int(math.floor((self.y1 - max(ya, yb) - pad) * self.ppm))
        i1 = int(math.ceil((self.y1 - min(ya, yb) + pad) * self.ppm))
        j0, j1 = max(j0, 0), min(j1, self.w)
        i0, i1 = max(i0, 0), min(i1, self.h)
        if j1 <= j0 or i1 <= i0:
            return None
        X = self.x0 + (np.arange(j0, j1) + 0.5) / self.ppm
        Y = self.y1 - (np.arange(i0, i1) + 0.5) / self.ppm
        GX, GY = np.meshgrid(X, Y)
        return (slice(i0, i1), slice(j0, j1), GX, GY)

    def _base(self):
        col, mot, _ = FLOOR_FINISH[self.zone]
        h, w = self.h, self.w
        seed = {"press": 1, "body": 2, "paint": 3, "assembly": 4}[self.zone]
        big = fft_noise(h, w, 2.6, seed=100 + seed)
        mid = fft_noise(h, w, 1.8, seed=200 + seed)
        fine = fft_noise(h, w, 0.8, seed=300 + seed)
        v = 1.0 + mot * (big - 0.5) * 1.6 + mot * 0.8 * (mid - 0.5) + 0.035 * (fine - 0.5)
        self.rgb = np.clip(rgb(col)[None, None, :] * v[..., None], 0, 1).astype(np.float32)
        # saw-cut contraction joints every 6 m
        GX = self.x0 + (np.arange(w) + 0.5) / self.ppm
        GY = self.y1 - (np.arange(h) + 0.5) / self.ppm
        jx = np.abs(((GX + 3.0) % 6.0) - 3.0)
        jy = np.abs(((GY + 3.0) % 6.0) - 3.0)
        lx = np.clip(1.0 - jx * self.ppm / 1.2, 0, 1)[None, :]
        ly = np.clip(1.0 - jy * self.ppm / 1.2, 0, 1)[:, None]
        joint = np.maximum(lx, ly)
        self.rgb *= (1.0 - 0.28 * joint)[..., None]

    # ---- painting primitives (alpha-blended) ---------------------------------
    def _blend(self, win, cov, color):
        si, sj = win[0], win[1]
        wear = 0.82 + 0.18 * fft_noise_cached(self, cov.shape)
        a = np.clip(cov * wear, 0, 1)[..., None]
        self.rgb[si, sj] = self.rgb[si, sj] * (1 - a) + color[None, None, :] * a * (0.9 + 0.1 * self.rgb[si, sj] / max(self.rgb.mean(), 1e-3))

    def rect(self, xa, ya, xb, yb, color, alpha=1.0, rot=0.0):
        cx, cy = (xa + xb) / 2, (ya + yb) / 2
        hx, hy = abs(xb - xa) / 2, abs(yb - ya) / 2
        r = math.hypot(hx, hy)
        win = self.window(cx - r, cy - r, cx + r, cy + r, 0.1)
        if win is None:
            return
        _, _, GX, GY = win
        c, s = math.cos(math.radians(-rot)), math.sin(math.radians(-rot))
        lx = (GX - cx) * c - (GY - cy) * s
        ly = (GX - cx) * s + (GY - cy) * c
        d = np.maximum(np.abs(lx) - hx, np.abs(ly) - hy)
        self._blend(win, np.clip(0.5 - d * self.ppm, 0, 1) * alpha, color)

    def frame(self, xa, ya, xb, yb, width, color):
        self.line((xa, ya), (xb, ya), width, color)
        self.line((xb, ya), (xb, yb), width, color)
        self.line((xb, yb), (xa, yb), width, color)
        self.line((xa, yb), (xa, ya), width, color)

    def line(self, p0, p1, width, color, dash=None, alpha=1.0):
        (xa, ya), (xb, yb) = p0, p1
        win = self.window(xa, ya, xb, yb, width)
        if win is None:
            return
        _, _, GX, GY = win
        dx, dy = xb - xa, yb - ya
        L2 = dx * dx + dy * dy
        t = np.clip(((GX - xa) * dx + (GY - ya) * dy) / max(L2, 1e-9), 0, 1)
        d = np.hypot(GX - (xa + t * dx), GY - (ya + t * dy))
        cov = np.clip((width / 2 - d) * self.ppm + 0.5, 0, 1)
        if dash:
            L = math.sqrt(L2)
            ph = (t * L) % (dash[0] + dash[1])
            cov *= np.clip((dash[0] - ph) * self.ppm + 0.5, 0, 1)
        self._blend(win, cov * alpha, color)

    def disc(self, cx, cy, r, color, alpha=1.0):
        win = self.window(cx - r, cy - r, cx + r, cy + r, 0.1)
        if win is None:
            return
        _, _, GX, GY = win
        d = np.hypot(GX - cx, GY - cy) - r
        self._blend(win, np.clip(0.5 - d * self.ppm, 0, 1) * alpha, color)

    def ring(self, cx, cy, r, width, color, dash=None):
        win = self.window(cx - r - width, cy - r - width, cx + r + width, cy + r + width)
        if win is None:
            return
        _, _, GX, GY = win
        d = np.abs(np.hypot(GX - cx, GY - cy) - r)
        cov = np.clip((width / 2 - d) * self.ppm + 0.5, 0, 1)
        if dash:
            s = (np.arctan2(GY - cy, GX - cx) + math.pi) * r
            ph = s % (dash[0] + dash[1])
            cov *= np.clip((dash[0] - ph) * self.ppm + 0.5, 0, 1)
        self._blend(win, cov, color)

    def hatch(self, xa, ya, xb, yb, period=0.4, colors=(YELLOW, BLACK)):
        win = self.window(xa, ya, xb, yb, 0.05)
        if win is None:
            return
        _, _, GX, GY = win
        inside = np.clip(0.5 - np.maximum(np.maximum(xa - GX, GX - xb), np.maximum(ya - GY, GY - yb)) * self.ppm, 0, 1)
        band = ((GX + GY) / period) % 1.0
        stripe = np.clip((np.abs(band - 0.5) - 0.25) * self.ppm * period * 2 + 0.5, 0, 1)
        self._blend(win, inside * stripe, colors[1])
        self._blend(win, inside * (1 - stripe), colors[0])

    def arrow(self, x, y, ang, length=2.4, width=0.35, color=WHITE):
        a = math.radians(ang)
        d = np.array([math.cos(a), math.sin(a)])
        p = np.array([x, y])
        self.line(tuple(p - d * length / 2), tuple(p + d * (length / 2 - 0.5)), width, color)
        n = np.array([-d[1], d[0]])
        tip = p + d * length / 2
        for sgn in (-1, 1):
            self.line(tuple(tip), tuple(tip - d * 0.7 + n * sgn * 0.45), width * 0.9, color)

    def stain(self, cx, cy, r, strength=0.35):
        win = self.window(cx - r * 1.5, cy - r * 1.5, cx + r * 1.5, cy + r * 1.5)
        if win is None:
            return
        si, sj, GX, GY = win
        n = fft_noise(GX.shape[0], GX.shape[1], 2.2, seed=int(abs(cx * 13 + cy * 7)) % 9999)
        d = np.hypot(GX - cx, GY - cy) / r
        m = np.clip(1.2 - d + 0.5 * (n - 0.5), 0, 1) ** 1.5 * strength
        self.rgb[si, sj] *= (1 - m)[..., None] * np.array([1.0, 0.98, 0.94])[None, None, :] + m[..., None] * 0.35

    def shadow(self, kind, cx, cy, sx, sy, rot, strength, soft):
        pad = soft * 3 + 0.2
        r = math.hypot(sx, sy) / 2 + pad
        win = self.window(cx - r, cy - r, cx + r, cy + r)
        if win is None:
            return
        si, sj, GX, GY = win
        if kind == "disc":
            d = np.hypot(GX - cx, GY - cy) - sx
        else:
            c, s = math.cos(math.radians(-rot)), math.sin(math.radians(-rot))
            lx = (GX - cx) * c - (GY - cy) * s
            ly = (GX - cx) * s + (GY - cy) * c
            q = np.stack([np.abs(lx) - sx / 2, np.abs(ly) - sy / 2], -1)
            outside = np.linalg.norm(np.maximum(q, 0), axis=-1)
            inside = np.minimum(np.maximum(q[..., 0], q[..., 1]), 0)
            d = outside + inside
        occ = 1.0 / (1.0 + np.exp(d / max(soft * 0.45, 1e-3)))      # soft edge
        self.shade[si, sj] *= (1.0 - strength * occ)

    def finish(self):
        """Apply shading and write the texture."""
        col = self.rgb * self.shade[..., None]
        self.img = save_image(f"floor_{self.zone}", col, quality=90)
        return self.img


_NOISE_CACHE = {}


def fft_noise_cached(tile, shape):
    key = shape
    n = _NOISE_CACHE.get(key)
    if n is None:
        h, w = shape
        n = fft_noise(max(h, 8), max(w, 8), 1.2, seed=(h * 31 + w) % 997)[:h, :w]
        _NOISE_CACHE[key] = n
    return n


FLOOR_TILES = {}


def paint_floor():
    """Rasterise every marking and footprint into the four department tiles."""
    tiles = {z: FloorTile(z) for z in ZONES}
    FLOOR_TILES.update(tiles)
    for kind, kw in MARKINGS:
        for t in tiles.values():
            getattr(t, kind)(**kw)
    for fp in FOOTPRINTS:
        for t in tiles.values():
            t.shadow(*fp)
    return tiles


def build_floor_meshes():
    coll = collection("SITE_GROUND")
    objs = []
    for zone, tile in FLOOR_TILES.items():
        img = tile.finish()
        _, _, rough = FLOOR_FINISH[zone]
        mat = image_material(f"floor_{zone}", img, rough=rough)
        w, h = tile.x1 - tile.x0, tile.y1 - tile.y0
        pr = plane(w, h)
        name = f"FLOOR_{zone.upper()}"
        V = pr.V + np.array([(tile.x0 + tile.x1) / 2, (tile.y0 + tile.y1) / 2, 0.0])
        ob = mesh_object(name, V, pr.N, pr.F, pr.UV, mat, coll)
        register(ob, f"{ZONES[zone]['title'].capitalize()} floor", zone, role="floor")
        objs.append(ob)
    return objs


def standard_markings():
    """Aisles, walkways and zone borders common to the whole hall."""
    x0, x1, y0, y1 = SITE["x0"], SITE["x1"], SITE["y0"], SITE["y1"]
    # main east-west transport aisle, 6 m, yellow edge lines, dashed centre
    for y in (-3.0, 3.0):
        mark("line", p0=(x0 + 0.5, y), p1=(x1 - 0.5, y), width=0.1, color=YELLOW)
    mark("line", p0=(x0 + 2, 0.0), p1=(x1 - 2, 0.0), width=0.1, color=WHITE, dash=(2.0, 2.0))
    # north-south aisle, 5 m
    for x in (-2.5, 2.5):
        mark("line", p0=(x, y0 + 0.5), p1=(x, -3.0), width=0.1, color=YELLOW)
        mark("line", p0=(x, 3.0), p1=(x, y1 - 0.5), width=0.1, color=YELLOW)
    mark("line", p0=(0.0, y0 + 1), p1=(0.0, -3.5), width=0.1, color=WHITE, dash=(2.0, 2.0))
    mark("line", p0=(0.0, 3.5), p1=(0.0, y1 - 1), width=0.1, color=WHITE, dash=(2.0, 2.0))
    # pedestrian walkway, green with white edges, along the south of the main aisle
    for (xa, xb) in ((x0 + 1.0, -3.0), (3.0, x1 - 1.0)):
        mark("rect", xa=xa, ya=-4.6, xb=xb, yb=-3.3, color=GREEN, alpha=0.9)
        mark("line", p0=(xa, -4.6), p1=(xb, -4.6), width=0.08, color=WHITE)
    # zebra crossings where the walkway crosses the N-S aisle
    for i in range(6):
        xx = -2.2 + i * 0.85
        mark("rect", xa=xx, ya=-4.6, xb=xx + 0.45, yb=-3.3, color=WHITE)
    # flow arrows in the aisles
    for x in (-40.0, -20.0, 20.0, 40.0):
        mark("arrow", x=x, y=-1.5, ang=180.0)
        mark("arrow", x=x, y=1.5, ang=0.0)
    # perimeter safety line 1 m inside the walls
    mark("line", p0=(x0 + 1.0, y1 - 1.0), p1=(x1 - 1.0, y1 - 1.0), width=0.1, color=YELLOW)
    mark("line", p0=(x0 + 1.0, y0 + 1.0), p1=(x0 + 1.0, y1 - 1.0), width=0.1, color=YELLOW)
