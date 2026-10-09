# =============================================================================
#  Press shop: tandem line, destacker, coil and blanking line, dies, racks
#
#  The tandem line runs east to west along y = -24: PRESS-STAMP-01 (the draw
#  press, instrumented) then three trim and flange presses at 11.5 m pitch,
#  linked by crossbar transfer feeders. Parallel to it, along y = -8, a coil
#  line (decoiler, straightener, servo feed) feeds the blanking press whose
#  blanks supply the destacker. Finished panels leave at the west end in
#  stillages and go to the body shop by AGV.
# =============================================================================

def crossbar_feeder(mb, xm, y, span=7.2, z=2.55):
    for sy in (-span / 2, span / 2):
        mb.add(rbox(0.5, 0.5, 3.4, 0.03), T(xm, y + sy, 1.7), "machine_grey")
        mb.add(rbox(0.9, 0.7, 0.55, 0.04), T(xm, y + sy, 3.65), "machine_grey")
        mb.add(rbox(0.2, 0.36, 0.5, 0.02), T(xm - 0.4, y + sy, 3.65), "graphite")
    mb.add(rbox(0.16, span, 0.16, 0.02), T(xm, y, z), "aluminium")                   # crossbar
    for k in np.linspace(-1.2, 1.2, 6):
        mb.add(cyl(0.012, 0.25, 8), T(xm, y + k, z - 0.2), "steel")
        mb.add(cyl(0.045, 0.03, 12), T(xm, y + k, z - 0.33), "rubber")
    # idle station between the presses holding a panel
    mb.add(rbox(1.8, 2.6, 0.08, 0.02), T(xm, y, 1.55), "dark_grey")
    for sx in (-0.7, 0.7):
        for sy in (-1.1, 1.1):
            mb.add(box(), T(xm + sx, y + sy, 0.78) @ S(0.08, 0.08, 1.5), "dark_grey")
    mb.add(rbox(1.3, 2.2, 0.012, 0.004), T(xm, y, 1.6), "sheet_steel")


def destacker(xc, y, coll="PRESS_SHOP"):
    """Blank destacker: two blank carts under a gantry with a vacuum frame,
    then a washer/oiler and a belt into the press (to the west, -X)."""
    mbd = env("PRESSAUTO", xc, y, coll)
    for sy in (-1.6, 1.6):
        mbd.add(rbox(2.2, 1.8, 0.35, 0.03), T(xc, y + sy, 0.25), "signal_blue")
        for k in range(4):
            mbd.add(cyl(0.08, 0.06, 10), T(xc + (k % 2 - 0.5) * 1.8, y + sy + (k // 2 - 0.5) * 1.4, 0.08) @ Rx(90), "rubber")
        mbd.add(box(), T(xc, y + sy, 0.62) @ S(1.7, 1.25, 0.38), "sheet_steel")
    for sx in (-2.3, 2.3):
        for sy in (-3.2, 3.2):
            mbd.add(rbox(0.3, 0.3, 3.6, 0.02), T(xc + sx, y + sy, 1.8), "safety_yellow")
    for sy in (-3.2, 3.2):
        mbd.add(rbox(4.9, 0.3, 0.4, 0.02), T(xc, y + sy, 3.7), "safety_yellow")
    mbd.add(rbox(0.5, 6.7, 0.4, 0.02), T(xc - 0.8, y, 3.9), "safety_yellow")
    mbd.add(rbox(0.6, 1.4, 1.6, 0.03), T(xc - 0.8, y, 2.9), "graphite")
    mbd.add(rbox(1.6, 1.1, 0.08, 0.01), T(xc - 0.8, y, 2.05), "aluminium")
    mbd.add(rbox(1.5, 1.0, 0.012, 0.004), T(xc - 0.8, y, 1.98), "sheet_steel")
    mbd.add(rbox(1.1, 2.2, 1.6, 0.04), T(xc - 3.4, y, 0.8), "panel_white")            # washer/oiler
    mbd.add(box(), T(xc - 3.4, y - 1.11, 1.0) @ S(0.6, 0.02, 0.4), "glass_dark")
    mbd.add(rbox(1.0, 1.8, 0.12, 0.02), T(xc - 4.2, y, 1.72), "dark_grey")             # belt to the press
    footprint(xc, y, 5.0, 6.8, 0, 0.25, 0.6)
    mark("frame", xa=xc - 2.6, ya=y - 3.5, xb=xc + 2.6, yb=y + 3.5, width=0.1, color=YELLOW)


def build_press_line():
    xs = LAYOUT["press_line_x"]
    y = LAYOUT["press_line_y"]
    k = 0.86
    tandem = Template("PRESS_TANDEM", lambda F: build_press("PRESSLINE_TANDEM", 0.0, 0.0, 0.0, hero=False, k=k,
                                                            frame_mat="machine_grey", body_mat="press_grey",
                                                            template=True))
    dims = press_dims(k)
    for i, x in enumerate(xs, start=1):
        F = T(x, y, 0.0) @ Rz(90.0)
        tandem.place(f"TANDEM_P{i}", F, "PRESS_SHOP", label=f"Tandem line press T{i}, 1,600 t",
                     zone="press", role="machine", tags=("press",))
        pm = Machine(f"TANDEM_P{i}_PLATE", F, "PRESS_SHOP", "press", hero=False)
        sign_board(pm, "N", f"T{i}", (0.0, -dims["Dc"] / 2 - 0.04, dims["zbr"]), 0.0, width=0.9, height=0.34,
                   size=0.2)
        pm.finish()
    for xa, xb in zip(xs[:-1], xs[1:]):                       # crossbar feeders
        xm = (xa + xb) / 2
        crossbar_feeder(env("PRESSAUTO", xm, y, "PRESS_SHOP"), xm, y)
        footprint(xm, y, 2.2, 7.6, 0, 0.3, 0.4)
    destacker(xs[0] + 5.6, y)                                 # tandem line infeed, east end
    # tandem line outfeed: belt and stillages between the two lines
    mbo = env("PRESSEOL", 22.8, y, "PRESS_SHOP")
    mbo.add(rbox(3.4, 1.4, 0.15, 0.02), T(22.6, y, 0.9), "dark_grey")
    for xx in (21.3, 23.9):
        mbo.add(box(), T(xx, y, 0.42) @ S(0.08, 1.3, 0.84), "dark_grey")
    mbo.add(rbox(1.3, 1.0, 0.012, 0.004), T(22.2, y, 0.985), "sheet_steel")
    for ry_ in (-31.5, -16.5):
        prop_panel_rack(env("PRESSEOL", 22.6, ry_, "PRESS_SHOP"), T(22.6, ry_, 0) @ Rz(90), n=9)
        footprint(22.6, ry_, 1.6, 2.8, 0, 0.4, 0.3)

    # ---- PRESS-STAMP-01 transfer line: destacker in front (east) of the press
    hp = LAYOUT["press"]
    destacker(hp["x"] + 6.4, hp["y"])

    # ---- coil line and blanking press along y = -8
    yc = -8.0
    mbc = env("COILLINE", 48.0, yc, "PRESS_SHOP")
    mbc.add(rbox(1.3, 1.1, 2.3, 0.04), T(53.6, yc, 1.15), "machine_grey")               # decoiler housing
    mbc.add(cyl(0.16, 1.2, 20), T(53.6, yc, 1.25) @ Rx(90) @ T(0, 0, -0.6), "steel")
    mbc.add(tube(0.9, 0.31, 1.3, 56), T(53.6, yc - 1.25, 1.25) @ Rx(90), "steel_coil")
    mbc.add(rbox(2.0, 1.8, 0.18, 0.02), T(53.6, yc - 0.8, 0.09), "dark_grey")
    mbc.add(rbox(1.9, 1.8, 1.7, 0.04), T(49.6, yc, 0.85), "machine_grey")               # straightener
    for k in range(5):
        mbc.add(cyl(0.09, 1.5, 16), T(48.9 + k * 0.35, yc, 1.75 + (k % 2) * 0.12) @ Rx(90), "chrome")
    mbc.add(fcyl(0.25, 0.6, 0.03, 20), T(49.6, yc + 1.2, 0.9) @ Rx(90), "motor_teal")
    mbc.add(rbox(1.0, 1.6, 1.5, 0.04), T(46.2, yc, 0.75), "machine_grey")               # servo roll feed
    mbc.add(fcyl(0.2, 0.5, 0.02, 20), T(46.2, yc + 1.05, 1.2) @ Rx(90), "motor_teal")
    strip = [(53.0, yc - 0.6, 0.62), (51.5, yc, 0.55), (50.6, yc, 1.62), (48.6, yc, 1.62), (46.6, yc, 1.55), (43.5, yc, 1.5)]
    mbc.add(sweep(fillet_path(strip, 0.6, 6), profile=rect_profile(0.004, 1.25), caps=True), None, "sheet_steel")
    build_press("PRESSLINE_BLANKING", 41.6, yc, 90.0, hero=False, k=0.62, plate_text="BLANKING",
                frame_mat="machine_grey", body_mat="press_grey")
    mbc.add(rbox(6.0, 1.3, 0.15, 0.02), T(35.2, yc, 0.86), "dark_grey")                 # exit conveyor
    for xx in np.arange(32.4, 38.2, 1.5):
        mbc.add(box(), T(xx, yc, 0.4) @ S(0.08, 1.2, 0.8), "dark_grey")
    for k, xx in enumerate((33.0, 34.8, 36.6)):
        mbc.add(rbox(1.4, 1.0, 0.012, 0.004), T(xx, yc, 0.945), "sheet_steel")
    for xx in (29.8, 27.4):
        mbc.add(rbox(2.0, 1.6, 0.3, 0.03), T(xx, yc, 0.15), "signal_blue")
        mbc.add(box(), T(xx, yc, 0.55) @ S(1.5, 1.05, 0.5), "sheet_steel")
    footprint(49.6, yc, 9.0, 3.0, 0, 0.35, 0.6)
    footprint(34.0, yc, 9.0, 2.0, 0, 0.25, 0.5)
    mark("hatch", xa=55.2, ya=yc - 1.9, xb=55.6, yb=yc + 1.0)
    mark("frame", xa=44.9, ya=yc - 2.4, xb=55.3, yb=yc + 2.4, width=0.1, color=YELLOW)

    # ---- coil storage
    for (cx, cy) in ((53.0, -14.2), (50.6, -14.2), (46.4, -14.2), (53.0, -17.0), (50.6, -17.0)):
        prop_coil(env("COILS", cx, cy, "PRESS_SHOP"), T(cx, cy, 0.0) @ Rz(90), r=0.82, w=1.3)
        footprint(cx, cy, 1.5, 1.9, 0, 0.45, 0.4)
    mark("frame", xa=45.2, ya=-18.3, xb=54.4, yb=-12.9, width=0.1, color=WHITE)

    # ---- die storage between the bolster rails, south side
    for (dx, dy) in ((42.2, -32.6), (31.8, -32.6), (17.6, -32.6), (52.0, -32.8)):
        prop_die(env("DIES", dx, dy, "PRESS_SHOP"), T(dx, dy, 0.0) @ Rz(90), 3.3, 2.0, 1.1)
        footprint(dx, dy, 2.2, 3.5, 0, 0.5, 0.4)
        mark("frame", xa=dx - 1.4, ya=dy - 2.0, xb=dx + 1.4, yb=dy + 2.0, width=0.08, color=WHITE)

    # ---- end of line: belt, inspection light tunnel, stillages, AGV
    mbe = env("PRESSEOL", 5.0, y, "PRESS_SHOP")
    mbe.add(rbox(4.0, 1.4, 0.15, 0.02), T(5.4, y, 0.9), "dark_grey")
    for xx in np.arange(3.6, 7.4, 1.25):
        mbe.add(box(), T(xx, y, 0.42) @ S(0.08, 1.3, 0.84), "dark_grey")
    mbe.add(rbox(1.3, 1.0, 0.012, 0.004), T(4.4, y, 0.985), "sheet_steel")
    for sx in (-0.9, 0.9):
        mbe.add(box(), T(5.6, y + sx, 1.45) @ S(0.06, 0.06, 1.3), "aluminium")
    mbe.add(box(), T(5.6, y, 2.1) @ S(0.3, 1.9, 0.06), "aluminium")
    for k in np.linspace(-0.7, 0.7, 6):
        mbe.add(box(), T(5.6, y + k, 2.05) @ S(0.25, 0.05, 0.03), "led_white")
    for i, ry_ in enumerate((-32.0, -29.0, -20.0, -17.0)):
        prop_panel_rack(env("PRESSEOL", 4.6, ry_, "PRESS_SHOP"), T(4.6, ry_, 0) @ Rz(90), n=9)
        footprint(4.6, ry_, 1.6, 2.8, 0, 0.4, 0.3)
    build_agv("PRESS_AGV_1", 0.0, -14.0, 90.0, "PRESS_SHOP", "press", load="rack")
    build_forklift("PRESS_FORKLIFT_1", 30.0, -14.6, 180.0, "PRESS_SHOP", "press")
    prop_safety_station(env("PRESSAUTO", 21.0, -11.6, "PRESS_SHOP"), T(21.0, -11.55, 0) @ Rz(180))
    prop_workbench(env("PRESSAUTO", 12.0, -14.0, "PRESS_SHOP"), T(12.0, -13.6, 0) @ Rz(180))
    for bx in (10.4, 10.9):
        prop_barrel(env("PRESSAUTO", bx, -15.6, "PRESS_SHOP"), T(bx, -15.6, 0), "signal_blue")
    zone_sign("PRESS SHOP", 30.0, -4.0, 7.4, 0.0)
