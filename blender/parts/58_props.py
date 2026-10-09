# =============================================================================
#  Props: the things that make a plant look worked in
#
#  Every function adds to an MB in world coordinates via a matrix M, so props
#  merge into the per-bay scenery batches. Sizes are real: Euro pallet
#  1.2 x 0.8 m, small load carrier 0.6 x 0.4 m, steel coil up to 1.8 m across.
# =============================================================================

def prop_pallet(mb, M, load=None, h_load=0.9, colour="cardboard"):
    for sx in (-0.55, 0.0, 0.55):
        mb.add(box(), M @ T(sx, 0, 0.055) @ S(0.1, 0.8, 0.07), "wood")
    for sy in (-0.35, 0.0, 0.35):
        mb.add(box(), M @ T(0, sy, 0.125) @ S(1.2, 0.1, 0.022), "wood")
        mb.add(box(), M @ T(0, sy, 0.012) @ S(1.2, 0.1, 0.022), "wood")
    if load == "boxes":
        for ix in (-0.3, 0.3):
            for iy in (-0.2, 0.2):
                hh = h_load * (0.75 + 0.25 * ((ix + iy + 1) % 1.0))
                mb.add(rbox(0.58, 0.38, hh, 0.01), M @ T(ix, iy, 0.136 + hh / 2), colour)
    elif load == "bins":
        for ix in (-0.3, 0.3):
            for iy in (-0.2, 0.2):
                for lev in range(3):
                    mb.add(rbox(0.58, 0.38, 0.27, 0.01), M @ T(ix, iy, 0.136 + 0.135 + lev * 0.28), colour)
    elif load == "block":
        mb.add(rbox(1.18, 0.78, h_load, 0.02), M @ T(0, 0, 0.136 + h_load / 2), colour)


def prop_klt(mb, M, colour="bin_blue"):
    """Small load carrier, 600 x 400 x 280 mm, open top."""
    mb.add(rbox(0.6, 0.4, 0.02, 0.005), M @ T(0, 0, 0.01), colour)
    for (cx, cy, sx, sy) in ((0, -0.19, 0.6, 0.02), (0, 0.19, 0.6, 0.02), (-0.29, 0, 0.02, 0.4), (0.29, 0, 0.02, 0.4)):
        mb.add(box(), M @ T(cx, cy, 0.14) @ S(sx, sy, 0.28), colour)


def prop_flow_rack(mb, M, w=2.4, d=1.2, h=1.9, levels=3, colour="bin_blue"):
    """Gravity flow rack at the line side, with small load carriers."""
    for sx in (-w / 2, w / 2):
        for sy in (-d / 2, d / 2):
            mb.add(box(), M @ T(sx, sy, h / 2) @ S(0.04, 0.04, h), "aluminium")
    for lev in range(levels):
        z = 0.45 + lev * (h - 0.5) / levels
        tilt = Rx(-8)
        mb.add(box(), M @ T(0, 0, z) @ tilt @ S(w, d, 0.02), "aluminium")
        for k in range(int(w / 0.62)):
            prop_klt(mb, M @ T(-w / 2 + 0.33 + k * 0.62, -0.1, z + 0.02) @ tilt, colour)


def prop_coil(mb, M, r=0.85, w=1.4, bore=0.31):
    """Steel coil on a cradle, axis along local X."""
    mb.add(tube(r, bore, w, 48), M @ T(0, 0, r + 0.05) @ Ry(90), "steel_coil")
    for k in np.linspace(-w / 2 + 0.15, w / 2 - 0.15, 3):
        mb.add(box(), M @ T(k, 0, r * 0.62) @ Rx(0) @ S(0.06, r * 1.1, 0.03), "steel_dark")      # straps
    for sy in (-0.45, 0.45):
        mb.add(box(), M @ T(0, sy, 0.12) @ S(w * 0.9, 0.35, 0.24), "wood")


def prop_die(mb, M, sx=3.4, sy=2.0, sz=1.15, colour="die_steel"):
    mb.add(rbox(sx, sy, sz * 0.45, 0.03), M @ T(0, 0, sz * 0.225), colour)
    mb.add(rbox(sx, sy, sz * 0.45, 0.03), M @ T(0, 0, sz * 0.55 + sz * 0.225), colour)
    for ix in (-1, 1):
        for iy in (-1, 1):
            mb.add(cyl(0.06, sz * 0.15, 12), M @ T(ix * (sx / 2 - 0.25), iy * (sy / 2 - 0.25), sz * 0.475), "chrome")
    mb.add(box(), M @ T(0, -sy / 2 - 0.005, sz * 0.75) @ S(0.6, 0.012, 0.2), "safety_yellow")


def prop_panel_rack(mb, M, n=10, colour="sheet_steel", w=2.6, d=1.4, h=1.6):
    """Steel stillage holding stamped panels on edge."""
    for sx in (-w / 2, w / 2):
        for sy in (-d / 2, d / 2):
            mb.add(box(), M @ T(sx, sy, h / 2) @ S(0.08, 0.08, h), "safety_yellow")
        mb.add(box(), M @ T(sx, 0, 0.12) @ S(0.08, d, 0.1), "safety_yellow")
    for sy in (-d / 2, d / 2):
        mb.add(box(), M @ T(0, sy, 0.12) @ S(w, 0.08, 0.1), "safety_yellow")
        mb.add(box(), M @ T(0, sy, h - 0.04) @ S(w, 0.08, 0.08), "safety_yellow")
    for k in range(n):
        x = -w / 2 + 0.3 + k * (w - 0.6) / max(n - 1, 1)
        mb.add(rbox(0.012, d - 0.25, h - 0.45, 0.004), M @ T(x, 0, 0.2 + (h - 0.45) / 2) @ Ry(8), colour)


def prop_barrel(mb, M, colour="signal_blue"):
    mb.add(fcyl(0.29, 0.88, 0.02, 20), M @ T(0, 0, 0.44), colour)
    for z in (0.3, 0.6):
        mb.add(torus(0.292, 0.012, 20, 4), M @ T(0, 0, z), colour)


def prop_workbench(mb, M, w=1.8, d=0.8):
    mb.add(rbox(w, d, 0.05, 0.01), M @ T(0, 0, 0.9), "wood")
    for sx in (-w / 2 + 0.05, w / 2 - 0.05):
        for sy in (-d / 2 + 0.05, d / 2 - 0.05):
            mb.add(box(), M @ T(sx, sy, 0.45) @ S(0.05, 0.05, 0.88), "signal_blue")
    mb.add(box(), M @ T(0, 0, 0.15) @ S(w - 0.1, d - 0.1, 0.02), "steel_dark")
    mb.add(box(), M @ T(0, d / 2 - 0.02, 1.35) @ S(w, 0.02, 0.85), "steel_dark")       # tool wall
    for k in range(6):
        mb.add(box(), M @ T(-w / 2 + 0.2 + k * 0.28, d / 2 - 0.05, 1.4) @ S(0.04, 0.04, 0.2), "safety_red")


def prop_safety_station(mb, M):
    """Fire extinguisher, eye wash and first aid board on a post."""
    mb.add(box(), M @ T(0, 0, 1.0) @ S(0.08, 0.08, 2.0), "safety_red")
    mb.add(rbox(0.5, 0.03, 0.6, 0.01), M @ T(0, -0.06, 1.7), "signal_green")
    mb.add(fcyl(0.08, 0.5, 0.02, 16), M @ T(0.18, -0.1, 0.55), "safety_red")
    mb.add(dome(0.08, 0.05, 16, 3), M @ T(0.18, -0.1, 0.8), "safety_red")


def prop_cabinet(mb, M, w=1.0, d=0.5, h=1.95, colour="signal_blue"):
    mb.add(rbox(w, d, h, 0.015), M @ T(0, 0, h / 2), colour)
    mb.add(box(), M @ T(0, -d / 2 - 0.005, h * 0.55) @ S(0.01, 0.01, 0.2), "chrome")


# ---------------------------------------------------------------- vehicles (machines, merged)
def build_forklift(prefix, x, y, heading, coll, zone, colour="safety_yellow", fork_h=0.15):
    m = Machine(prefix, T(x, y, 0) @ Rz(heading), coll, zone, hero=False)
    b = m.part("BODY", colour)
    b.add(rbox(1.9, 1.1, 0.75, 0.08, 2), T(-0.2, 0, 0.55))
    b.add(rbox(0.6, 1.1, 0.7, 0.1), T(-0.95, 0, 0.95))                              # counterweight
    b.add(rbox(0.7, 0.9, 0.25, 0.05), T(-0.1, 0, 1.05))                              # seat base
    b.done()
    g = m.part("GUARD", "graphite")
    for sx in (0.35, -0.75):
        for sy in (-0.5, 0.5):
            g.add(box(), T(sx, sy, 1.5) @ S(0.06, 0.06, 1.1))
    g.add(box(), T(-0.2, 0, 2.08) @ S(1.25, 1.06, 0.06))
    for k in np.linspace(-0.7, 0.3, 6):
        g.add(box(), T(k, 0, 2.1) @ S(0.03, 1.0, 0.03))
    g.add(rbox(0.45, 0.45, 0.5, 0.05), T(-0.25, 0, 1.37), )
    g.done()
    w = m.part("WHEELS", "tire")
    for (wx, r) in ((0.45, 0.32), (-0.85, 0.26)):
        for sy in (-0.47, 0.47):
            w.add(cyl(r, 0.22, 20), T(wx, sy, r) @ Rx(90))
    w.done()
    mast = m.part("MAST", "graphite")
    for sy in (-0.32, 0.32):
        mast.add(box(), T(0.85, sy, 1.25) @ S(0.1, 0.08, 2.4))
    mast.add(box(), T(0.86, 0, 2.4) @ S(0.1, 0.72, 0.08))
    mast.add(box(), T(0.95, 0, fork_h + 0.45) @ S(0.06, 0.8, 0.5))
    mast.done()
    f = m.part("FORKS", "steel_dark")
    for sy in (-0.25, 0.25):
        f.add(box(), T(1.5, sy, fork_h) @ S(1.15, 0.12, 0.045))
        f.add(box(), T(0.97, sy, fork_h + 0.35) @ S(0.045, 0.12, 0.7))
    f.done()
    footprint(x, y, 3.0, 1.2, heading, 0.45, 0.35)
    return m.finish()


def build_agv(prefix, x, y, heading, coll, zone, load=None, colour="signal_blue"):
    """Low automated guided vehicle (1.6 x 0.9 m) with optional load."""
    m = Machine(prefix, T(x, y, 0) @ Rz(heading), coll, zone, hero=False)
    b = m.part("BODY", "graphite")
    b.add(rbox(1.6, 0.9, 0.28, 0.04, 2), T(0, 0, 0.17))
    b.done()
    t = m.part("TRIM", colour)
    t.add(box(), T(0, 0, 0.31) @ S(1.5, 0.82, 0.02))
    t.done()
    s = m.part("SCANNERS", "safety_yellow")
    for sx in (-0.82, 0.82):
        s.add(fcyl(0.06, 0.1, 0.01, 12), T(sx, 0, 0.3))
    s.done()
    l = m.part("LIGHTS", "led_blue")
    l.add(box(), T(0.805, 0, 0.18) @ S(0.01, 0.6, 0.03))
    l.done()
    if load == "rack":
        prop_panel_rack(m.mb, m.frame @ T(0, 0, 0.32), n=8, w=1.5, d=0.85, h=1.2)
    elif load == "battery":
        m.mb.add(rbox(1.5, 0.85, 0.16, 0.02), m.frame @ T(0, 0, 0.4), "graphite")
        m.mb.add(box(), m.frame @ T(0, 0, 0.49) @ S(1.3, 0.7, 0.02), "safety_red")
    elif load == "klt":
        for ix in (-0.45, 0.15):
            for iy in (-0.2, 0.2):
                prop_klt(m.mb, m.frame @ T(ix + 0.15, iy, 0.32))
    footprint(x, y, 1.7, 1.0, heading, 0.4, 0.25)
    return m.finish()


def build_tugger_train(prefix, x, y, heading, coll, zone, carts=3):
    m = Machine(prefix, T(x, y, 0) @ Rz(heading), coll, zone, hero=False)
    tr = m.part("TRACTOR", "signal_blue")
    tr.add(rbox(1.5, 0.9, 0.7, 0.06, 2), T(0, 0, 0.5))
    tr.add(rbox(0.5, 0.86, 0.5, 0.05), T(-0.45, 0, 1.05))
    tr.done()
    g = m.part("GUARD", "graphite")
    g.add(box(), T(-0.7, 0, 1.4) @ S(0.05, 0.86, 0.05))
    for sy in (-0.42, 0.42):
        g.add(box(), T(-0.7, sy, 1.0) @ S(0.05, 0.05, 0.8))
    g.done()
    w = m.part("WHEELS", "tire")
    for wx in (0.5, -0.45):
        for sy in (-0.42, 0.42):
            w.add(cyl(0.2, 0.15, 16), T(wx, sy, 0.2) @ Rx(90))
    xc = -1.25
    for c in range(carts):
        cx = xc - 1.05 - c * 2.1
        f = m.part("CART", "steel_dark")
        f.add(box(), T(cx, 0, 0.35) @ S(1.8, 0.9, 0.05))
        f.add(box(), T(cx + 1.0, 0, 0.3) @ S(0.25, 0.05, 0.05))
        for sx in (-0.85, 0.85):
            for sy in (-0.42, 0.42):
                f.add(box(), T(cx + sx, sy, 0.9) @ S(0.04, 0.04, 1.1))
        f.add(box(), T(cx, 0, 1.0) @ S(1.8, 0.9, 0.03))
        f.done()
        for sx in (-0.7, 0.7):
            for sy in (-0.38, 0.38):
                w.add(cyl(0.1, 0.06, 12), T(cx + sx, sy, 0.1) @ Rx(90))
        for ix in (-0.6, 0.0, 0.6):
            for lev, z in enumerate((0.38, 1.03)):
                prop_klt(m.mb, m.frame @ T(cx + ix, 0.0, z), "bin_yellow" if lev else "bin_blue")
    w.done()
    fx, fy = apply_point(m.frame, (-1.25 - carts * 1.05, 0, 0))[:2]
    footprint(fx, fy, 2.1 * carts + 1.5, 1.0, heading, 0.4, 0.3)
    return m.finish()
