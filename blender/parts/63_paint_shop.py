# =============================================================================
#  Paint shop (north-west): seven process tunnels, serpentine flow
#
#  Tunnels run north-south between the column lines, 5 m wide, 29 m long:
#    T1 pretreatment and e-coat dip  (north)   T5 base and clear coat booth (north)
#    T2 e-coat oven                  (south)   T6 topcoat oven              (south)
#    T3 sealer and underbody deck    (north)   T7 inspection light tunnel   (north)
#    T4 primer booth                 (south)
#  Bodies arrive on the monorail at T1's south end and leave T7's north end
#  for final assembly. Booths have glass walls and ceilings, so the painting
#  robots stay visible from the viewer's raised camera.
# =============================================================================

PAINT_Y0, PAINT_Y1 = 4.6, 33.4
PAINT_TUNNELS = [(-52.5, "ptd", 1), (-45.5, "edoven", -1), (-38.5, "sealer", 1), (-31.5, "primer", -1),
                 (-24.5, "topcoat", 1), (-17.5, "oven", -1), (-10.5, "inspect", 1)]
PAINT_W = 5.0
PAINT_COLOURS = ["white", "red", "blue", "silver", "black", "grey", "green", "sand"]


def skid_conveyor(mb, x, y0, y1, z=0.5):
    for sx in (-0.55, 0.55):
        mb.add(box(), T(x + sx, (y0 + y1) / 2, z) @ S(0.1, y1 - y0, 0.16), "dark_grey")
    for yy in np.arange(y0 + 0.5, y1, 2.0):
        mb.add(box(), T(x, yy, z / 2) @ S(1.3, 0.1, z), "dark_grey")


def tunnel_shell(x, y0, y1, w, h, roof="solid", windows=False, coll="PAINT_SHOP", wall_mat="cladding"):
    """Enclosure: walls with optional window band on the east side, roof, plinth."""
    get = lambda xx, yy: env("PAINTSHELL", xx, yy, coll)
    hw = w / 2
    # long walls; the east wall (facing the aisle and the camera) gets windows
    win = []
    if windows:
        for s in np.arange(1.5, (y1 - y0) - 2.0, 3.0):
            win.append((s, s + 2.2, 1.0, 2.8))
    _wall_run(get, (x + hw, y0), (x + hw, y1), 0.15, h, win, wall_mat, 0.12, 1.0)
    _wall_run(get, (x - hw, y0), (x - hw, y1), 0.15, h, [], wall_mat, 0.12, 1.0)
    for (s0, s1, z0, z1) in win:
        yy = y0 + (s0 + s1) / 2
        get(x + hw, yy).add(box(), T(x + hw, yy, (z0 + z1) / 2) @ S(0.03, s1 - s0, z1 - z0), "glass")
    # end walls with the conveyor opening
    for ye in (y0, y1):
        _wall_run(get, (x - hw, ye), (x + hw, ye), 0.15, h, [(hw - 1.4, hw + 1.4, 0.0, 2.8)], wall_mat, 0.12, 1.0)
    for ye in (y0, y1):
        get(x, ye).add(box(), T(x, ye, 0.075) @ S(w + 0.3, 0.3, 0.15), "concrete_block")
    for xe in (x - hw, x + hw):
        get(xe, (y0 + y1) / 2).add(box(), T(xe, (y0 + y1) / 2, 0.075) @ S(0.3, y1 - y0, 0.15), "concrete_block")
    # roof
    L = y1 - y0
    if roof == "glass":
        get(x, (y0 + y1) / 2).add(box(), T(x, (y0 + y1) / 2, h) @ S(w, L, 0.03), "glass")
        for yy in np.arange(y0, y1 + 0.01, 1.5):
            get(x, yy).add(box(), T(x, yy, h + 0.03) @ S(w + 0.1, 0.08, 0.08), "aluminium")
        for sx in (-hw, 0.0, hw):
            get(x, (y0 + y1) / 2).add(box(), T(x + sx, (y0 + y1) / 2, h + 0.03) @ S(0.1, L, 0.1), "aluminium")
    else:
        get(x, (y0 + y1) / 2).add(box(), T(x, (y0 + y1) / 2, h) @ S(w + 0.2, L + 0.2, 0.12), "insulation")
        for yy in np.arange(y0 + 1.2, y1, 2.4):
            get(x, yy).add(box(), T(x, yy, h + 0.07) @ S(w + 0.2, 0.04, 0.03), "duct")
    footprint(x, (y0 + y1) / 2, w + 0.4, L + 0.4, 0, 0.35, 0.6)


def booth_module(F):
    """9 m booth section: four painting robots on raised rails, both sides."""
    m = Machine("BOOTHMOD", F, "PAINT_SHOP", "paint", hero=False, template=True)
    for sx in (-1.95, 1.95):
        m.mb.add(rbox(0.5, 9.0, 0.8, 0.03), T(sx, 0, 0.4), "white_paint")                 # robot rail
        m.mb.add(box(), T(sx, 0, 0.82) @ S(0.25, 9.0, 0.04), "steel_dark")
    specs = [(-1.95, -2.2, 0.0, (-0.45, -1.4, 2.05), (0.6, 0, -1)), (-1.95, 2.2, 0.0, (-0.8, 2.6, 1.4), (1, 0, -0.2)),
             (1.95, -2.2, 180.0, (0.45, -0.6, 2.05), (-0.6, 0, -1)), (1.95, 2.2, 180.0, (0.85, 1.4, 1.35), (-1, 0, -0.2))]
    for (rx, ry, rot, target, approach) in specs:
        Fr = T(rx, ry, 0.0) @ Rz(rot)
        Fi = np.linalg.inv(Fr)
        tl = (Fi @ np.array([*target, 1.0]))[:3]
        al = Fi[:3, :3] @ _unit(np.asarray(approach, float))
        th = solve_reach(tl, "paint", 0.85, al, seed=(0, 20, 20, 0, 30, 0))
        build_robot("P", Fr, th, tool="paint", plinth=0.85, into=m, body_mat="paint_robot", base_mat="white_paint")
    for sy in (-3.0, 3.0):                                                                 # booth lights
        for sx in (-2.2, 2.2):
            m.mb.add(box(), T(sx, sy, 3.9) @ S(0.25, 2.4, 0.06), "led_white")
    return m


def build_paint_shop():
    coll = "PAINT_SHOP"
    y0, y1 = PAINT_Y0, PAINT_Y1
    L = y1 - y0
    booth = Template("PAINT_BOOTH_MODULE", booth_module)
    car_i = 0
    for ti, (x, kind, direction) in enumerate(PAINT_TUNNELS):
        heading = 90.0 if direction > 0 else -90.0
        conv = env("PAINTCONV", x, (y0 + y1) / 2, coll)
        skid_conveyor(conv, x, y0 + 0.2, y1 - 0.2)
        ys = list(np.arange(y0 + 3.0, y1 - 2.5, 6.0))
        if kind == "ptd":
            tunnel_shell(x, y0, y1, PAINT_W, 7.0, "solid", windows=True)
            tank_y0, tank_y1 = y0 + 7.0, y0 + 21.0
            mb = env("PAINTPROC", x, (tank_y0 + tank_y1) / 2, coll)
            mb.add(box(), T(x, (tank_y0 + tank_y1) / 2, 0.9) @ S(PAINT_W - 0.6, tank_y1 - tank_y0, 1.8), "steel_dark")
            mb.add(box(), T(x, (tank_y0 + tank_y1) / 2, 1.82) @ S(PAINT_W - 0.8, tank_y1 - tank_y0 - 0.2, 0.02), "water")
            # bodies on rotating dip carriers: entering nose-down, inverted mid-bath, leaving
            # nose-down into the bath, inverted mid-bath, nose-up leaving it
            stages = [("biw_closed", 0.0, y0 + 3.0, 1.0), ("biw_closed", 35.0, tank_y0 + 2.5, 1.9),
                      ("ecoat_closed", 180.0, (tank_y0 + tank_y1) / 2, 2.1), ("ecoat_closed", -30.0, tank_y1 - 2.0, 2.2),
                      ("ecoat_closed", 0.0, y1 - 4.0, 1.0)]
            for st, tilt, yy, zz in stages:
                place_car(f"PAINT_PTD_CAR_{car_i}", st, "white", x, yy, zz, heading, coll=coll,
                          matrix=T(x, yy, zz) @ Rz(heading) @ (Rx(180) if tilt == 180.0 else Ry(tilt)))
                car_i += 1
            for yy in np.arange(y0 + 1.0, y1, 4.0):
                mb.add(box(), T(x, yy, 6.4) @ S(0.3, 0.3, 0.3), "safety_yellow")             # carrier rail hangers
            mb.add(box(), T(x, (y0 + y1) / 2, 6.25) @ S(0.25, L - 1.0, 0.25), "steel_dark")
        elif kind in ("edoven", "oven"):
            tunnel_shell(x, y0, y1, PAINT_W, 5.2, "solid", windows=False, wall_mat="insulation")
            mb = env("PAINTPROC", x, (y0 + y1) / 2, coll)
            for yy in (y0 + 5.0, y0 + 14.0, y0 + 23.0):
                mb.add(rbox(2.6, 2.4, 1.6, 0.04), T(x, yy, 5.2 + 0.8), "white_paint")          # burner units
                mb.add(cyl(0.35, 1.2, 16), T(x + 0.9, yy, 7.4), "duct")
                mb.add(cyl(0.3, 16.2 - 7.4, 16), T(x - 0.6, yy + 0.6, (16.2 + 6.8) / 2), "duct")  # exhaust stack
                mb.add(cyl(0.34, 0.25, 16), T(x - 0.6, yy + 0.6, 16.3), "steel_dark")
            st = "ecoat_closed" if kind == "edoven" else "paintshell"
            for yy in (y0 + 3.0, y1 - 3.0):
                col = PAINT_COLOURS[car_i % len(PAINT_COLOURS)]
                place_car(f"PAINT_OVEN_CAR_{car_i}", st, col, x, yy, 0.62, heading, coll=coll)
                car_i += 1
        elif kind == "sealer":
            mb = env("PAINTPROC", x, (y0 + y1) / 2, coll)
            for sx in (-PAINT_W / 2, PAINT_W / 2):                                           # open deck, handrails
                mb.add(box(), T(x + sx, (y0 + y1) / 2, 0.075) @ S(0.3, L, 0.15), "concrete_block")
            sealer = Template("PAINT_SEALER_ROBOT", lambda F: _sealer_pair(F))
            for k, yy in enumerate(ys):
                place_car(f"PAINT_SEALER_CAR_{car_i}", "ecoat_closed", "white", x, yy, 0.62, heading, coll=coll)
                car_i += 1
                if k in (1, 3):
                    sealer.place(f"PAINT_SEALER_ROBOTS_{k}", T(x, yy, 0.0), coll)
            for yy in np.arange(y0 + 1.0, y1, 4.0):
                mb.add(box(), T(x + PAINT_W / 2 + 0.6, yy, 0.6) @ S(0.05, 0.05, 1.2), "safety_yellow")
            mb.add(box(), T(x + PAINT_W / 2 + 0.6, (y0 + y1) / 2, 1.2) @ S(0.05, L, 0.05), "safety_yellow")
        elif kind in ("primer", "topcoat"):
            tunnel_shell(x, y0, y1, PAINT_W, 4.4, "glass", windows=True)
            for k, yy in enumerate((y0 + 8.5, y0 + 19.5)):
                booth.place(f"PAINT_{kind.upper()}_BOOTH_{k + 1}", T(x, yy, 0.0) @ Rz(0 if direction > 0 else 180), coll,
                            label=f"{'Primer' if kind == 'primer' else 'Base and clear coat'} booth, robot zone {k + 1}",
                            zone="paint", role="cell", tags=("paint_booth",))
            for yy in ys:
                st = "primer_closed" if kind == "primer" else "paintshell"
                col = PAINT_COLOURS[car_i % len(PAINT_COLOURS)]
                place_car(f"PAINT_BOOTH_CAR_{car_i}", st, col, x, yy, 0.62, heading, coll=coll)
                car_i += 1
            mb = env("PAINTPROC", x, (y0 + y1) / 2, coll)
            mb.add(rbox(PAINT_W - 1.0, L - 2.0, 1.1, 0.05), T(x, (y0 + y1) / 2, 4.4 + 0.6), "white_paint")  # supply plenum
            for yy in (y0 + 6.0, y1 - 6.0):
                mb.add(cyl(0.45, 16.0 - 5.5, 16), T(x + 1.4, yy, (16.0 + 5.5) / 2), "duct")
                mb.add(cyl(0.5, 0.3, 16), T(x + 1.4, yy, 16.1), "steel_dark")
        elif kind == "inspect":
            mb = env("PAINTPROC", x, (y0 + y1) / 2, coll)
            for yy in np.arange(y0 + 2.0, y1 - 1.0, 1.2):                                     # light tunnel arches
                for sx in (-2.0, 2.0):
                    mb.add(box(), T(x + sx, yy, 1.4) @ S(0.08, 0.08, 2.8), "aluminium")
                mb.add(box(), T(x, yy, 2.85) @ S(4.1, 0.08, 0.08), "aluminium")
                mb.add(box(), T(x, yy, 2.78) @ S(3.6, 0.05, 0.03), "led_white")
                for sx in (-1.95, 1.95):
                    mb.add(box(), T(x + sx, yy, 1.5) @ S(0.03, 0.05, 2.2), "led_white")
            for yy in ys[::2]:
                col = PAINT_COLOURS[car_i % len(PAINT_COLOURS)]
                place_car(f"PAINT_INSPECT_CAR_{car_i}", "paintshell", col, x, yy, 0.62, heading, coll=coll)
                car_i += 1
            prop_workbench(mb, T(x + 3.6, y0 + 10.0, 0) @ Rz(90))
        # transfer between tunnels at the ends
        if ti < len(PAINT_TUNNELS) - 1:
            x2 = PAINT_TUNNELS[ti + 1][0]
            ye = y1 + 1.0 if direction > 0 else y0 - 1.0
            mb = env("PAINTPROC", (x + x2) / 2, ye, coll)
            mb.add(rbox(abs(x2 - x) + 1.6, 2.2, 3.0, 0.04), T((x + x2) / 2, ye, 1.5), "cladding", uv="box", tile=1.0)
    # exit transfer from T7 to final assembly (along the north side)
    mb = env("PAINTPROC", -5.0, y1 + 1.0, coll)
    mb.add(rbox(10.0, 2.0, 3.0, 0.04), T(-5.5, y1 + 1.0, 1.5), "cladding", uv="box", tile=1.0)
    # paint mix room and supply air units against the west wall
    mb = env("PAINTPROC", -54.0, 20.0, coll)
    zone_sign("PAINT SHOP", -16.0, 2.0, 7.6, 0.0)


def _sealer_pair(F):
    m = Machine("SEALERPAIR", F, "PAINT_SHOP", "paint", hero=False, template=True)
    for (rx, rot, target, approach) in ((-2.0, 0.0, (-0.7, 0.4, 1.0), (1, 0, -0.5)), (2.0, 180.0, (0.7, -0.4, 1.0), (-1, 0, -0.5))):
        Fr = T(rx, 0.0, 0.0) @ Rz(rot)
        Fi = np.linalg.inv(Fr)
        tl = (Fi @ np.array([*target, 1.0]))[:3]
        al = Fi[:3, :3] @ _unit(np.asarray(approach, float))
        th = solve_reach(tl, "sealer", 0.3, al, seed=(0, 30, 30, 0, 30, 0))
        build_robot("S", Fr, th, tool="sealer", plinth=0.3, into=m, body_mat="paint_robot", base_mat="white_paint")
    return m
