# =============================================================================
#  Body shop (south-west): sub-assembly cells, main framing and respot line,
#  overhead monorail to the paint shop
#
#  Main line along y = -8.2, flowing west, one station per 7.6 m:
#    respot A, respot B, framing (open-gate), respot C, geometry inspection,
#    closures. Every station is a fenced cell; identical cells share one mesh.
# =============================================================================

BODY_LINE_Y = -8.2
BODY_PITCH = 7.6
BODY_STATIONS = [(-10.6, "respot"), (-18.2, "respot"), (-25.8, "framing"), (-33.4, "respot"),
                 (-41.0, "inspect"), (-48.6, "closures")]


def side_frame_path():
    """Outline of a body side (sill, pillars, roof rail) in car coordinates (x, z)."""
    return [(-2.0, 0.42), (1.9, 0.42), (1.9, 0.85), (1.15, 0.98), (0.75, 1.42), (0.45, 1.6),
            (-1.5, 1.6), (-1.95, 1.45), (-2.1, 1.0), (-2.0, 0.42)]


def cell_robots(m, specs, plinth=0.35, tool="spot_gun"):
    for (rx, ry, rot, target, approach) in specs:
        F = T(rx, ry, 0.0) @ Rz(rot)
        Fi = np.linalg.inv(F)
        tl = (Fi @ np.array([*target, 1.0]))[:3]
        al = Fi[:3, :3] @ np.asarray(approach, float)
        th = solve_reach(tl, tool, plinth, al, seed=(0, 30, 20, 0, 30, 0))
        tip = (robot_fk(th, plinth)["M6"] @ np.array([*TOOL_TCP[tool], 1.0]))[:3]
        miss = np.linalg.norm(tip - tl) * 1000
        if miss > 30:
            log(f"  IK miss {miss:.0f} mm for robot at ({rx}, {ry}) target {target}")
        build_robot("R", F, th, tool=tool, plinth=plinth, into=m)


def build_line_cell(F, variant):
    m = Machine("BODYCELL", F, "BODY_SHOP", "body", hero=False, template=True)
    hx, hy = BODY_PITCH / 2 - 0.1, 3.2
    roller_conveyor(m.mb, -hx - 0.1, hx + 0.1, 0.0, z=0.5)
    zr = 2.0                          # roof rail height with the body on its skid
    if variant in ("respot", "closures"):
        build_fixture(m, 0.0, 0.0, z_top=0.66)
        cell_robots(m, [
            (1.7, -2.35, 90.0, (0.9, -0.72, zr), (0, 0, -1)),
            (-1.7, -2.35, 90.0, (-0.7, -0.62, zr + 0.02), (0, 0, -1)),
            (1.7, 2.35, -90.0, (0.3, 0.72, zr), (0, 0, -1)),
            (-1.7, 2.35, -90.0, (-1.2, 0.66, zr), (0, 0, -1)),
        ])
    elif variant == "framing":
        # open-gate framing station: portal frame, side gates with clamps
        for sx in (-3.0, 3.0):
            for sy in (-2.9, 2.9):
                m.mb.add(rbox(0.45, 0.45, 4.6, 0.03), T(sx, sy, 2.3), "signal_blue")
        for sy in (-2.9, 2.9):
            m.mb.add(rbox(6.45, 0.45, 0.5, 0.03), T(0, sy, 4.85), "signal_blue")
        for sx in (-3.0, 3.0):
            m.mb.add(rbox(0.45, 6.25, 0.5, 0.03), T(sx, 0, 4.85), "signal_blue")
        for sy in (-1.45, 1.45):
            m.mb.add(rbox(4.6, 0.12, 0.12, 0.02), T(0, sy, 2.6), "dark_grey")              # gate beam
            for sx in (-2.0, -0.7, 0.7, 2.0):
                m.mb.add(rbox(0.12, 0.12, 2.0, 0.02), T(sx, sy, 1.6), "dark_grey")
                m.mb.add(fcyl(0.04, 0.3, 0.01, 12), T(sx, sy * 0.9, 1.9) @ Rx(90), "signal_blue")
        build_fixture(m, 0.0, 0.0, z_top=0.66)
        cell_robots(m, [
            (2.2, -2.35, 120.0, (1.3, -0.75, zr), (0, 0, -1)),
            (-2.2, -2.35, 60.0, (-1.3, -0.7, zr), (0, 0, -1)),
            (2.2, 2.35, -120.0, (1.0, 0.75, zr), (0, 0, -1)),
            (-2.2, 2.35, -60.0, (-1.0, 0.7, zr), (0, 0, -1)),
        ])
    elif variant == "inspect":
        build_fixture(m, 0.0, 0.0, z_top=0.66)
        for (rx, ry, rot, target) in ((1.6, -2.4, 90.0, (0.6, -1.4, 1.5)), (-1.6, 2.4, -90.0, (-0.8, 1.4, 1.5))):
            F2 = T(rx, ry, 0.0) @ Rz(rot)
            Fi = np.linalg.inv(F2)
            tl = (Fi @ np.array([*target, 1.0]))[:3]
            al = Fi[:3, :3] @ _unit(np.array([0, -np.sign(ry), -0.3]))
            th = solve_reach(tl, "none", 0.35, al, seed=(0, 25, 10, 0, 20, 0))
            r = build_robot("INSPECT", F2, th, tool="none", plinth=0.35, into=m, body_mat="robot_white")
            fr = robot_fk(th, 0.35)
            Mt = F2 @ fr["M6"]
            m.mb.add(rbox(0.22, 0.3, 0.16, 0.02), Mt @ T(0.14, 0, 0), "graphite")          # blue-light scanner
            m.mb.add(box(), Mt @ T(0.255, 0, 0) @ S(0.01, 0.22, 0.1), "led_blue")
        for sx in (-3.4, 3.4):
            m.mb.add(box(), T(sx, 0, 1.8) @ S(0.1, 0.1, 3.6), "aluminium")
        m.mb.add(box(), T(0, 0, 3.6) @ S(6.9, 0.12, 0.12), "aluminium")
        for k in np.linspace(-2.8, 2.8, 8):
            m.mb.add(box(), T(k, 0, 3.52) @ S(0.5, 0.25, 0.04), "led_white")
    # controllers outside the south fence, tip dresser inside
    for cx in (-2.6, 0.7):
        robot_controller("C", T(cx, -hy - 0.55, 0.0), "BODY_SHOP", "body", into=m)
    m.mb.add(rbox(0.28, 0.28, 1.0, 0.02), T(hx - 0.6, -hy + 0.6, 0.5), "dark_grey")
    m.mb.add(rbox(0.45, 0.32, 0.2, 0.02), T(hx - 0.6, -hy + 0.6, 1.1), "dark_grey")
    pts = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    fence(m, pts, openings=[dict(seg=1, s0=hy - 1.25, s1=hy + 1.25, kind="curtain"),
                            dict(seg=3, s0=hy - 1.25, s1=hy + 1.25, kind="curtain"),
                            dict(seg=0, s0=2 * hx - 1.6, s1=2 * hx - 0.6, kind="gate")],
          post_mat="machine_grey")
    footprint(0, 0, 2 * hx, 2 * hy, 0, 0.06, 0.3)
    mark("frame", xa=-hx + 0.15, ya=-hy + 0.15, xb=hx - 0.15, yb=hy - 0.15, width=0.08, color=YELLOW)
    return m


def build_sub_cell(F):
    """Sub-assembly cell: two-station turntable, handling robot, two weld robots."""
    m = Machine("SUBCELL", F, "BODY_SHOP", "body", hero=False, template=True)
    hx, hy = 4.5, 4.0
    m.mb.add(fcyl(2.1, 0.5, 0.04, 48), T(0, 0.4, 0.25), "dark_grey")                     # turntable
    m.mb.add(rbox(4.0, 0.12, 2.2, 0.02), T(0, 0.4, 1.6), "signal_blue")                   # dividing wall
    for sy in (-0.65, 1.45):
        side = side_frame_path()
        path = [(x * 0.82, sy, 0.5 + z * 0.85) for (x, z) in side]
        m.mb.add(sweep(path, profile=rect_profile(0.12, 0.07), caps=True), None, "biw_steel")
        for k in np.linspace(-1.3, 1.3, 4):
            m.mb.add(rbox(0.12, 0.12, 0.42, 0.01), T(k, sy, 0.72), "signal_blue")         # nests
    cell_robots(m, [
        (2.4, -2.2, 135.0, (0.9, -0.65, 1.86), (0, 0, -1)),
        (-2.4, -2.2, 45.0, (-0.9, -0.65, 1.86), (0, 0, -1)),
    ])
    F3 = T(0.0, 3.0, 0.0) @ Rz(-90)
    F3i = np.linalg.inv(F3)
    th = solve_reach((F3i @ np.array([0.6, 1.45, 1.6, 1.0]))[:3], "gripper", 0.35,
                     F3i[:3, :3] @ np.array([0.0, -1.0, 0.0]), seed=(0, 20, 30, 0, 20, 0))
    build_robot("H", F3, th, tool="gripper", plinth=0.35, into=m)
    for cx in (-3.0, 0.2):
        robot_controller("C", T(cx, -hy - 0.55, 0.0), "BODY_SHOP", "body", into=m)
    pts = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
    fence(m, pts, openings=[dict(seg=0, s0=6.5, s1=7.5, kind="gate"), dict(seg=2, s0=3.0, s1=6.0, kind="curtain")],
          post_mat="machine_grey")
    footprint(0, 0.4, 4.4, 4.4, 0, 0.35, 0.6)
    mark("frame", xa=-hx + 0.15, ya=-hy + 0.15, xb=hx - 0.15, yb=hy - 0.15, width=0.08, color=YELLOW)
    return m


def build_body_shop():
    coll = "BODY_SHOP"
    y = BODY_LINE_Y
    variants = {}
    for x, var in BODY_STATIONS:
        geo = "respot" if var == "closures" else var
        if geo not in variants:
            variants[geo] = Template(f"BODY_{geo.upper()}_CELL", lambda F, v=geo: build_line_cell(F, v))
        variants[geo].place(f"BODY_LINE_{var.upper()}_{int(abs(x))}", T(x, y, 0.0), coll,
                            label=f"Body line station: {var}", zone="body", role="cell", tags=("cell", var))
        stage = "biw"
        place_car(f"BODY_LINE_CAR_{int(abs(x))}", stage, "white", x, y, 0.40, 180.0, coll=coll)
    # entry and exit conveyor sections
    conv = env("BODYCONV", -5.0, y, coll)
    roller_conveyor(conv, -6.6, -3.2, y, z=0.5)
    roller_conveyor(conv, -54.0, -52.4, y, z=0.5)
    place_car("BODY_LINE_CAR_ENTRY", "biw", "white", -4.9, y, 0.40, 180.0, coll=coll)

    # sub-assembly cells, south-west
    sub = Template("BODY_SUB_CELL", build_sub_cell)
    for i, x in enumerate((-50.0, -40.0, -30.0)):
        sub.place(f"BODY_SUBASSEMBLY_{i + 1}", T(x, -27.0, 0.0), coll, label="Side frame sub-assembly cell",
                  zone="body", role="cell", tags=("cell", "subassembly"))
    for i, x in enumerate((-50.0, -40.0, -30.0)):
        prop_panel_rack(env("BODYRACK", x, -20.6, coll), T(x - 2.0, -20.6, 0) @ Rz(0), n=8, w=2.4, d=1.2, h=1.5)
        prop_panel_rack(env("BODYRACK", x, -20.6, coll), T(x + 1.0, -20.6, 0) @ Rz(0), n=8, w=2.4, d=1.2, h=1.5)
        footprint(x - 0.5, -20.6, 5.8, 1.6, 0, 0.35, 0.3)
    build_agv("BODY_AGV_1", -24.0, -17.0, 180.0, coll, "body", load="rack")
    build_agv("BODY_AGV_2", -44.0, -17.5, 0.0, coll, "body", load="rack")
    build_forklift("BODY_FORKLIFT_1", -36.5, -15.4, 0.0, coll, "body")

    # overhead electrified monorail: line end, north across the aisle into paint
    ems_x = -53.6
    mb = env("EMS", ems_x, -2.0, coll)
    path = [(ems_x, y, 6.2), (ems_x, 5.0, 6.2)]
    mb.add(ibeam(0.22, 0.12, 0.008, 0.012), between(path[0], path[1]), "struct_blue")
    for yy in np.arange(y, 5.1, 3.0):
        mb.add(cyl(0.02, SITE["eave"] - 6.3, 6), T(ems_x, yy, (SITE["eave"] + 6.3) / 2), "steel_dark")
    mb.add(rbox(1.2, 0.8, 4.8, 0.03), T(ems_x, y, 3.3), "signal_blue")                    # lift tower
    for k, cy in enumerate((-2.6, 1.6)):
        for dy in (-1.5, 1.5):
            mb.add(box(), T(ems_x, cy + dy, 5.2) @ S(0.06, 0.06, 2.0), "steel_dark")       # C-hanger legs
        mb.add(rbox(0.5, 0.35, 0.3, 0.02), T(ems_x, cy, 6.0), "safety_yellow")             # trolley
        mb.add(box(), T(ems_x, cy, 4.2) @ S(1.7, 3.2, 0.08), "steel_dark")
        place_car(f"BODY_EMS_CAR_{k + 1}", "biw", "white", ems_x, cy, 4.26 - 0.27, 90.0, coll=coll)
    mark("hatch", xa=ems_x - 1.3, ya=-3.0, xb=ems_x + 1.3, yb=3.0)
    zone_sign("BODY SHOP", -30.0, -2.0, 7.6, 0.0)
    prop_safety_station(env("BODYRACK", -21.0, -11.5, coll), T(-21.0, -11.45, 0) @ Rz(180))
    for i, x in enumerate((-14.0, -38.0)):
        prop_workbench(env("BODYRACK", x, -17.8, coll), T(x, -17.8, 0))
