# =============================================================================
#  Final assembly (north-east): trim, chassis with EV marriage, final, EOL
#
#    trim line     y = 28.5, eastbound   painted bodies on skillets, doors off,
#                                        cockpit, seats, glazing robot
#    chassis line  y = 18.0, westbound   bodies on overhead C-hangers; battery
#                                        pack and drive units married from an AGV
#    final line    y =  7.5, eastbound   wheels, doors back on, fluids, then
#                                        alignment, roller dyno, water test
#  Station pitch 6.4 m, the usual takt spacing for a mid-size car.
# =============================================================================

TRIM_Y, CHASSIS_Y, FINAL_Y = 28.5, 18.0, 7.5
ASM_PITCH = 6.4
ASM_COLOURS = ["white", "red", "blue", "silver", "black", "grey", "white", "green", "sand", "blue", "red", "silver"]


def skillet(mb, x, y, heading=0.0):
    M = T(x, y, 0.0) @ Rz(heading)
    mb.add(rbox(5.6, 2.9, 0.3, 0.03), M @ T(0, 0, 0.15), "dark_grey")
    mb.add(box(), M @ T(0, 0, 0.305) @ S(5.5, 2.8, 0.01), "rubber")
    for sy in (-1.45, 1.45):
        mb.add(box(), M @ T(0, sy, 0.16) @ S(5.6, 0.02, 0.3), "safety_yellow")


def c_hanger(mb, x, y, z_rail, z_car):
    """Overhead C-hanger carrying a body by its sills."""
    mb.add(rbox(0.6, 0.4, 0.35, 0.03), T(x, y, z_rail - 0.25), "safety_yellow")            # trolley
    mb.add(box(), T(x, y + 1.25, (z_rail - 0.4 + z_car) / 2) @ S(0.12, 0.12, z_rail - 0.4 - z_car), "signal_blue")
    mb.add(box(), T(x, y + 0.6, z_rail - 0.45) @ S(0.12, 1.3, 0.12), "signal_blue")
    for sx in (-1.0, 1.0):
        mb.add(box(), T(x + sx, y, z_car - 0.06) @ S(0.12, 2.6, 0.1), "signal_blue")
    mb.add(box(), T(x, y + 1.25, z_car - 0.06) @ S(2.12, 0.12, 0.1), "signal_blue")


def tool_balancer(mb, x, y, z_top=3.6):
    mb.add(box(), T(x, y, z_top) @ S(0.12, 0.12, 0.12), "safety_yellow")
    mb.add(cyl(0.004, 1.6, 4), T(x, y, z_top - 0.85), "cable")
    mb.add(fcyl(0.035, 0.28, 0.01, 10), T(x, y, z_top - 1.75), "graphite")


def build_assembly():
    coll = "ASSEMBLY"
    xs = list(np.arange(5.5, 52.0, ASM_PITCH))
    ci = 0

    # ---------------------------------------------------------------- trim line
    mb = env("ASMTRIM", 28.0, TRIM_Y, coll)
    mark("rect", xa=3.0, ya=TRIM_Y - 1.6, xb=53.5, yb=TRIM_Y + 1.6, color=rgb("#5c6066"), alpha=0.85)
    mark("line", p0=(3.0, TRIM_Y - 1.65), p1=(53.5, TRIM_Y - 1.65), width=0.1, color=YELLOW)
    mark("line", p0=(3.0, TRIM_Y + 1.65), p1=(53.5, TRIM_Y + 1.65), width=0.1, color=YELLOW)
    for i, x in enumerate(xs):
        st = "paint" if i < 3 else "trim"
        skillet(env("ASMTRIM", x, TRIM_Y, coll), x, TRIM_Y)
        place_car(f"ASM_TRIM_CAR_{i + 1}", st, ASM_COLOURS[ci % len(ASM_COLOURS)], x, TRIM_Y, 0.31, 0.0, coll=coll)
        ci += 1
        for sy in (-2.6, 2.6):
            prop_flow_rack(env("ASMTRIM", x, TRIM_Y + sy, coll), T(x - 1.6, TRIM_Y + sy * 1.15, 0) @ Rz(0 if sy > 0 else 180),
                           w=2.4, d=1.0, h=1.7, levels=3, colour="bin_blue" if i % 2 else "bin_grey")
            tool_balancer(env("ASMTRIM", x, TRIM_Y + sy, coll), x + 1.2, TRIM_Y + sy * 0.6)
    # balancer rail above the line
    for sy in (-1.6, 1.6):
        mb.add(box(), T(28.0, TRIM_Y + sy * 0.4, 3.62) @ S(48.0, 0.1, 0.1), "struct_blue")
    # glazing robot at the end of the trim line, windscreen on its gripper
    gx = xs[-1] - ASM_PITCH / 2
    Fr = T(gx, TRIM_Y - 2.9, 0.0) @ Rz(90.0)
    Fi = np.linalg.inv(Fr)
    tl = (Fi @ np.array([gx + 1.1, TRIM_Y, 1.9, 1.0]))[:3]
    al = Fi[:3, :3] @ _unit(np.array([0.5, 0.0, -1.0]))
    th = solve_reach(tl, "glazing", 0.6, al, seed=(0, 20, 20, 0, 40, 0))
    with low_detail(0.5):
        r = build_robot("ASM_GLAZING_ROBOT_", Fr, th, tool="glazing", plinth=0.6, coll=coll, zone="assembly",
                        body_mat="robot_white", base_mat="robot_base")
        Mt = Fr @ robot_fk(th, 0.6)["M6"]
        env("ASMTRIM", gx, TRIM_Y, coll).add(rbox(0.02, 1.45, 0.85, 0.01), Mt @ T(0.2, 0, 0) @ Ry(0), "glass_dark")
    mark("ring", cx=gx, cy=TRIM_Y - 2.9, r=2.4, width=0.06, color=WHITE, dash=(0.4, 0.3))

    # overhead door conveyor along the north side
    mbd = env("ASMDOOR", 28.0, 33.0, coll)
    mbd.add(ibeam(0.2, 0.1, 0.008, 0.012), between((4.0, 32.8, 4.4), (52.0, 32.8, 4.4)), "struct_blue")
    for k, x in enumerate(np.arange(5.0, 51.0, 1.5)):
        col = car_paint_key(CAR_COLOURS[ASM_COLOURS[k // 4 % len(ASM_COLOURS)]])
        mbd.add(box(), T(x, 32.8, 4.1) @ S(0.05, 0.05, 0.5), "steel_dark")
        mbd.add(rbox(1.05, 0.06, 0.95, 0.03), T(x, 32.8, 3.35), col)
        mbd.add(box(), T(x - 0.2, 32.8, 3.95) @ S(0.55, 0.04, 0.3), "glass_dark")
    for x in np.arange(6.0, 52.0, 6.0):
        mbd.add(cyl(0.02, SITE["eave"] - 4.5, 6), T(x, 32.8, (SITE["eave"] + 4.5) / 2), "steel_dark")

    # ---------------------------------------------------------------- chassis line (overhead)
    z_rail, z_car = 4.9, 1.6
    mbc = env("ASMCHAS", 28.0, CHASSIS_Y, coll)
    mbc.add(ibeam(0.3, 0.16, 0.01, 0.016), between((3.0, CHASSIS_Y + 1.25, z_rail), (53.0, CHASSIS_Y + 1.25, z_rail)), "struct_blue")
    for x in np.arange(4.0, 53.0, 4.0):
        mbc.add(cyl(0.025, SITE["eave"] - z_rail, 6), T(x, CHASSIS_Y + 1.25, (SITE["eave"] + z_rail) / 2), "steel_dark")
    marry_x = 27.5
    for i, x in enumerate(reversed(xs)):
        if abs(x - marry_x) < 1.0:
            continue
        before = x > marry_x
        st = "trim" if before else "chassis"
        c_hanger(env("ASMCHAS", x, CHASSIS_Y, coll), x, CHASSIS_Y, z_rail, z_car)
        place_car(f"ASM_CHASSIS_CAR_{i + 1}", st, ASM_COLOURS[ci % len(ASM_COLOURS)], x, CHASSIS_Y, z_car - 0.27, 180.0, coll=coll)
        ci += 1
        if before:
            for sy in (-2.3, 2.3):
                prop_flow_rack(env("ASMCHAS", x, CHASSIS_Y + sy, coll), T(x, CHASSIS_Y + sy * 1.2, 0) @ Rz(0 if sy > 0 else 180),
                               w=2.0, d=0.9, h=1.6, levels=2, colour="bin_yellow")
    # marriage station: body lowered onto battery pack carried by an AGV on a lift
    mx = min(xs, key=lambda v: abs(v - marry_x))
    c_hanger(env("ASMCHAS", mx, CHASSIS_Y, coll), mx, CHASSIS_Y, z_rail, 1.05)
    place_car("ASM_MARRIAGE_CAR", "trim", "red", mx, CHASSIS_Y, 1.05 - 0.27, 180.0, coll=coll,
              label="EV marriage station: body over battery pack", zone="assembly")
    mbm = env("ASMCHAS", mx, CHASSIS_Y, coll)
    mbm.add(rbox(3.2, 2.0, 0.35, 0.03), T(mx, CHASSIS_Y, 0.18), "signal_blue")              # lift table
    for sx in (-1.2, 1.2):
        mbm.add(box(), T(mx + sx, CHASSIS_Y, 0.45) @ S(0.12, 1.6, 0.25), "chrome")
    mbm.add(rbox(2.6, 1.55, 0.16, 0.02), T(mx, CHASSIS_Y, 0.65), "graphite")                 # battery pack
    mbm.add(box(), T(mx, CHASSIS_Y, 0.74) @ S(2.3, 1.3, 0.02), "safety_red")
    for sx in (-1.41, 1.41):                                                                  # drive units
        mbm.add(rbox(0.5, 1.3, 0.35, 0.05), T(mx + sx, CHASSIS_Y, 0.62), "aluminium")
    for sx, sy in ((-1.7, -1.6), (1.7, -1.6), (-1.7, 1.6), (1.7, 1.6)):
        mbm.add(rbox(0.5, 0.5, 1.2, 0.03), T(mx + sx, CHASSIS_Y + sy, 0.6), "machine_grey")   # screwdriver towers
        mbm.add(fcyl(0.06, 0.4, 0.01, 12), T(mx + sx * 0.8, CHASSIS_Y + sy * 0.8, 1.35), "graphite")
    mark("hatch", xa=mx - 2.2, ya=CHASSIS_Y - 2.2, xb=mx + 2.2, yb=CHASSIS_Y - 1.9)
    mark("hatch", xa=mx - 2.2, ya=CHASSIS_Y + 1.9, xb=mx + 2.2, yb=CHASSIS_Y + 2.2)
    for k, ax in enumerate((mx - 9.0, mx - 13.0)):
        build_agv(f"ASM_BATTERY_AGV_{k + 1}", ax, CHASSIS_Y - 4.6, 0.0, coll, "assembly", load="battery")
    # battery buffer racks between the lines
    for x in (12.0, 16.5):
        mbr = env("ASMBAT", x, 13.6, coll)
        for lev in range(3):
            mbr.add(box(), T(x, 13.6, 0.4 + lev * 0.75) @ S(3.6, 1.8, 0.04), "steel_dark")
            mbr.add(rbox(2.4, 1.5, 0.15, 0.02), T(x, 13.6, 0.5 + lev * 0.75), "graphite")
        for sx in (-1.75, 1.75):
            for sy in (-0.85, 0.85):
                mbr.add(box(), T(x + sx, 13.6 + sy, 1.15) @ S(0.06, 0.06, 2.3), "safety_yellow")
        footprint(x, 13.6, 3.7, 1.9, 0, 0.45, 0.35)

    # ---------------------------------------------------------------- final line and EOL
    mark("rect", xa=3.0, ya=FINAL_Y - 1.6, xb=44.0, yb=FINAL_Y + 1.6, color=rgb("#5c6066"), alpha=0.85)
    mark("line", p0=(3.0, FINAL_Y - 1.65), p1=(44.0, FINAL_Y - 1.65), width=0.1, color=YELLOW)
    mark("line", p0=(3.0, FINAL_Y + 1.65), p1=(44.0, FINAL_Y + 1.65), width=0.1, color=YELLOW)
    fxs = [x for x in xs if x < 44.0]
    for i, x in enumerate(fxs):
        st = "chassis" if i < 2 else "final"
        skillet(env("ASMFINAL", x, FINAL_Y, coll), x, FINAL_Y)
        place_car(f"ASM_FINAL_CAR_{i + 1}", st, ASM_COLOURS[ci % len(ASM_COLOURS)], x, FINAL_Y, 0.31, 0.0, coll=coll)
        ci += 1
        prop_flow_rack(env("ASMFINAL", x, FINAL_Y + 2.7, coll), T(x - 1.4, FINAL_Y + 3.0, 0), w=2.0, d=0.9, h=1.6,
                       levels=2, colour="bin_blue")
        tool_balancer(env("ASMFINAL", x, FINAL_Y, coll), x + 1.0, FINAL_Y + 1.3)
    # wheel-mounting robot between the first two final-line stations
    wx = (fxs[0] + fxs[1]) / 2
    Fw = T(wx, FINAL_Y - 3.0, 0.0) @ Rz(90.0)
    Fwi = np.linalg.inv(Fw)
    tl = (Fwi @ np.array([wx + 0.6, FINAL_Y - 1.3, 0.68, 1.0]))[:3]
    al = Fwi[:3, :3] @ np.array([0.0, 1.0, 0.0])
    th = solve_reach(tl, "gripper", 0.3, al, seed=(0, 30, 50, 0, 10, 0))
    with low_detail(0.5):
        build_robot("ASM_WHEEL_ROBOT_", Fw, th, tool="gripper", plinth=0.3, coll=coll, zone="assembly")
        for k in range(4):                                                                    # wheel rack
            car_wheel(env("ASMFINAL", wx, FINAL_Y - 4.4, coll), T(wx - 1.2 + k * 0.8, FINAL_Y - 4.6, 0.37))
    # EOL: alignment rig, roller dyno with pit, water test booth
    mbe = env("ASMEOL", 49.0, FINAL_Y, coll)
    ex = 46.6
    mbe.add(rbox(5.4, 3.2, 0.35, 0.03), T(ex, FINAL_Y, 0.17), "dark_grey")                    # alignment rig
    for sx in (-1.41, 1.41):
        for sy in (-0.8, 0.8):
            mbe.add(fcyl(0.38, 0.06, 0.01, 20), T(ex + sx, FINAL_Y + sy, 0.38), "steel")
            mbe.add(rbox(0.3, 0.2, 0.5, 0.02), T(ex + sx, FINAL_Y + sy * 1.55, 0.6), "graphite")
    place_car("ASM_EOL_ALIGNMENT_CAR", "final", "blue", ex, FINAL_Y, 0.36, 0.0, coll=coll,
              label="Wheel alignment rig", zone="assembly")
    dx = 52.0
    mbe.add(box(), T(dx, FINAL_Y, -0.01) @ S(4.0, 2.6, 0.02), "graphite")                     # dyno pit cover
    for sx in (-1.41, 1.41):
        for sy in (-0.8, 0.8):
            mbe.add(cyl(0.2, 0.7, 20), T(dx + sx, FINAL_Y + sy, 0.02) @ Rx(90), "chrome")
    place_car("ASM_EOL_DYNO_CAR", "final", "white", dx, FINAL_Y, 0.04, 0.0, coll=coll, label="Roller test bench", zone="assembly")
    mbe.add(rbox(3.2, 0.6, 2.2, 0.03), T(dx, FINAL_Y - 2.8, 1.1), "cabinet_grey")             # dyno control desk
    mbe.add(box(), T(dx, FINAL_Y - 2.49, 1.6) @ S(1.6, 0.02, 0.8), "screen")
    # water test booth beside the final line exit
    wbx, wby = 49.5, 13.6
    tunnel = env("ASMEOL", wbx, wby, coll)
    for sx in (-3.5, 3.5):
        tunnel.add(box(), T(wbx + sx, wby, 1.8) @ S(0.15, 3.4, 3.6), "panel_white")
    tunnel.add(box(), T(wbx, wby, 3.65) @ S(7.15, 3.4, 0.12), "panel_white")
    tunnel.add(box(), T(wbx, wby - 1.68, 1.8) @ S(7.0, 0.04, 3.4), "glass")
    for k in np.linspace(-3.0, 3.0, 9):
        tunnel.add(cyl(0.03, 3.2, 8), T(wbx + k, wby, 3.2) @ Rx(90), "chrome")
    place_car("ASM_EOL_WATER_CAR", "final", "silver", wbx, wby, 0.0, 0.0, coll=coll, label="Water test booth", zone="assembly")

    # parts supermarket (pallet racking) against the north wall, east end
    for k in range(5):
        rx = 38.5 + k * 3.0
        rmb = env("ASMRACK", rx, 34.2, coll)
        for sx in (-1.4, 1.4):
            for sy in (-0.5, 0.5):
                rmb.add(box(), T(rx + sx, 34.2 + sy, 3.0) @ S(0.08, 0.08, 6.0), "signal_blue")
        for lev, z in enumerate((0.0, 1.9, 3.8)):
            if lev:
                for sy in (-0.5, 0.5):
                    rmb.add(box(), T(rx, 34.2 + sy, z) @ S(2.8, 0.06, 0.14), "safety_red")
            for px in (-0.68, 0.68):
                prop_pallet(rmb, T(rx + px, 34.2, z + 0.08) @ Rz(90), load="boxes" if (k + lev) % 2 else "bins",
                            colour="cardboard" if (k + lev) % 2 else "bin_grey")
        footprint(rx, 34.2, 3.0, 1.2, 0, 0.35, 0.3)
    build_tugger_train("ASM_TUGGER_1", 26.0, 23.4, 0.0, coll, "assembly", carts=3)
    build_forklift("ASM_FORKLIFT_1", 41.0, 31.5, 90.0, coll, "assembly")
    build_agv("ASM_AGV_KLT_1", 20.0, 11.0, 0.0, coll, "assembly", load="klt")
    prop_safety_station(env("ASMRACK", 21.0, 12.4, coll), T(21.0, 12.45, 0))
    zone_sign("FINAL ASSEMBLY", 30.0, 2.2, 7.6, 0.0)
