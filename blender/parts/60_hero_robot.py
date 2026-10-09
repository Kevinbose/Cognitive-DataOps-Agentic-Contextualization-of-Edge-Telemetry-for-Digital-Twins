# =============================================================================
#  ROBOT-WELD-01: the instrumented spot-welding cell (body shop, front row)
#
#  Cell 12.5 m x 10.5 m inside a 2.2 m fence. The robot stands 1.1 m from the
#  east fence, so its 2.7 m reach (3.5 m to the electrode tips) stays inside
#  the guarded zone; the body arrives on a roller conveyor through a muted
#  light-curtain opening in the west fence.
# =============================================================================

def build_fixture(m, x, y, z_top=0.66, length=4.3, width=1.5, hero=False):
    """Welding fixture under a body: base frame, locators, pneumatic clamps."""
    base = m.part("FIXTURE", "steel_dark")
    for sy in (-width / 2, width / 2):
        base.add(ibeam(0.24, 0.14, 0.01, 0.014), between((x - length / 2, y + sy, 0.12), (x + length / 2, y + sy, 0.12)))
    for sx in np.linspace(-length / 2 + 0.2, length / 2 - 0.2, 5):
        base.add(box(), T(x + sx, y, 0.12) @ S(0.16, width + 0.14, 0.2))
    for sx in (-1.25, 1.35):
        for sy in (-1, 1):
            base.add(rbox(0.16, 0.16, z_top - 0.22, 0.01), T(x + sx, y + sy * (width / 2 - 0.05), (z_top + 0.22) / 2))
            base.add(rbox(0.22, 0.22, 0.06, 0.01), T(x + sx, y + sy * (width / 2 - 0.05), z_top - 0.03))
    base.done(label="Body welding fixture", role="fixture", tags=("fixture",))
    cl = m.part("FIXTURE_CLAMPS", "signal_blue")
    for sx in (-1.25, 1.35):
        for sy in (-1, 1):
            cx, cy = x + sx, y + sy * (width / 2 + 0.12)
            cl.add(fcyl(0.045, 0.32, 0.01, 16), T(cx, cy, z_top - 0.1) @ Rx(sy * 25))
            cl.add(rbox(0.05, 0.3, 0.05, 0.01), T(cx, cy - sy * 0.12, z_top + 0.2))
    cl.done(label="Pneumatic clamps", role="fixture", tags=("clamp",))
    pins = m.part("FIXTURE_PINS", "chrome")
    for sx in (-1.25, 1.35):
        for sy in (-1, 1):
            pins.add(cyl(0.015, 0.08, 10), T(x + sx, y + sy * (width / 2 - 0.05), z_top + 0.04))
    pins.done()


def roller_conveyor(mb, x0, x1, y, z=0.5, width=1.6, pitch=0.25, frame_mat="dark_grey", roller_mat="steel"):
    """Powered roller conveyor along X (into an env batch)."""
    for sy in (-width / 2, width / 2):
        mb.add(prism(chan_profile(0.16, 0.06, 0.006), 1.0), T(x1, y + sy, z) @ Ry(-90) @ Rz(90 if sy < 0 else -90) @ S(1, 1, x1 - x0), frame_mat)
    for xx in np.arange(x0 + 0.15, x1 - 0.1, pitch):
        mb.add(cyl(0.04, width - 0.04, 12), T(xx, y, z + 0.03) @ Rx(90), roller_mat)
    for xx in np.arange(x0 + 0.3, x1, 1.6):
        for sy in (-width / 2, width / 2):
            mb.add(box(), T(xx, y + sy, z / 2) @ S(0.06, 0.06, z), frame_mat)
            mb.add(box(), T(xx, y + sy, 0.006) @ S(0.16, 0.16, 0.012), frame_mat)


def build_hero_robot():
    coll = collection("HERO_ROBOT")
    c = LAYOUT["robot_cell"]
    x0, x1, y0, y1 = c["x0"], c["x1"], c["y0"], c["y1"]
    fx = LAYOUT["biw_fixture"]
    car_x, car_y = fx["x"], fx["y"]
    z_car = 0.40                       # rocker bottom at 0.67 m, on the fixture
    world = Machine("ROBOT_", np.eye(4), coll, "body", "robot-weld-01", hero=True)

    # body-in-white on its fixture, front towards the robot
    place_car("ROBOT_BIW", "biw", "white", car_x, car_y, z_car, 0.0, coll="HERO_ROBOT",
                    label="Body-in-white being welded", zone="body")
    build_fixture(world, car_x, car_y, z_top=0.66)
    conv = env("BODYCONV", car_x, car_y, "HERO_ROBOT")
    roller_conveyor(conv, x0 - 2.5, car_x - 2.4, car_y, z=0.5)

    # robot: base 1.1 m inside the east fence, solve the pose onto a weld point
    rx, ry = x1 - 4.6, car_y - 0.55
    rot = 180.0
    F = T(rx, ry, 0.0) @ Rz(rot)
    plinth = 0.35
    target_w = np.array([car_x + 1.72, car_y + 0.62, z_car + 0.80])        # fender apron flange
    Finv = np.linalg.inv(F)
    target_l = (Finv @ np.array([*target_w, 1.0]))[:3]
    approach_l = (Finv[:3, :3] @ np.array([0.0, 0.0, -1.0]))
    th = solve_reach(target_l, "spot_gun", plinth, approach_l, seed=(10, 35, 15, 0, 35, 0))
    if user_asset("robot"):
        # your model on the pedestal, its front (+X) facing the body
        p = world.part("PEDESTAL", "steel_dark")
        p.add(rbox(1.05, 1.05, plinth - 0.03, 0.02), T(rx, ry, (plinth - 0.03) / 2))
        p.done(label="Robot pedestal", role="structure")
        place_user_asset("robot", (rx, ry, plinth), rot, coll)
        rob = type("R", (), {"tcp": None})()
    else:
        rob = build_robot("ROBOT_", F, th, tool="spot_gun", plinth=plinth, hero=True, coll=coll, zone="body",
                          machine_id="robot-weld-01")
    if rob.tcp is not None:
        log(f"ROBOT-WELD-01 pose {tuple(round(a, 1) for a in th)}; tip error {np.linalg.norm(rob.tcp - target_w) * 1000:.0f} mm")
    footprint(rx, ry, 1.3, 1.3, 0, 0.55, 0.4)

    # floor cable trunking: pedestal to the east fence, out to the controller
    p = world.part("CABLE_TRUNKING", "dark_grey")
    path = [(rx + 0.55, ry), (x1 - 0.35, ry), (x1 - 0.35, y1 - 2.8), (x1 + 0.35, y1 - 2.8)]
    for (ax, ay), (bx, by) in zip(path[:-1], path[1:]):
        L = math.hypot(bx - ax, by - ay)
        ang = math.degrees(math.atan2(by - ay, bx - ax))
        p.add(rbox(L + 0.3, 0.3, 0.05, 0.01), T((ax + bx) / 2, (ay + by) / 2, 0.025) @ Rz(ang))
    p.done(label="Robot cable trunking", role="cabling")

    # weld spark at the tips (subtle glow), tip dresser, controllers
    if rob.tcp is not None:
        p = world.part("WELD_SPARK", "weld_glow")
        p.add(sphere(0.03, 12, 6), T(*target_w))
        p.done()
    p = world.part("TIP_DRESSER", "dark_grey")
    tdx, tdy = x1 - 1.4, y0 + 1.4
    p.add(rbox(0.3, 0.3, 1.05, 0.02), T(tdx, tdy, 0.525))
    p.add(rbox(0.5, 0.36, 0.22, 0.03), T(tdx, tdy, 1.16))
    p.done(label="Electrode tip dresser", role="tool_maintenance", tags=("tip_dresser",))
    p = world.part("TIP_DRESSER_MOTOR", "robot_orange")
    p.add(fcyl(0.08, 0.26, 0.01, 16), T(tdx - 0.32, tdy, 1.16) @ Ry(90))
    p.done()
    robot_controller("ROBOT_", T(x1 + 0.75, y1 - 2.8, 0) @ Rz(90), coll, "body", hero=True, machine_id="robot-weld-01")

    # fence: west edge has the conveyor opening, north edge the gate
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    if user_asset("fence"):
        fence_from_user_panel(pts, closed=True, coll=coll)
        parts = {}
    else:
        parts = None
    parts = parts if parts is not None else fence(world, pts, openings=[
        dict(seg=3, s0=(y1 - (car_y + 1.2)), s1=(y1 - (car_y - 1.2)), kind="curtain"),
        dict(seg=2, s0=0.6, s1=1.6, kind="gate"),
    ], names={k: f"CELL_FENCE_{k.upper()}" for k in ("posts", "mesh", "frame", "kick", "gate", "curtain", "curtain_led", "lock")})
    finish_fence(parts, "Robot cell fence")

    # beacon and operator panel at the gate, cell sign
    gx, gy = x1 - 1.1, y1
    p = world.part("CELL_BEACON", "graphite")
    p.add(cyl(0.02, 0.45, 8), T(x1, y1, 2.45))
    p.done(label="Cell stack light", role="signal", tags=("andon",))
    for i, (nm, mat) in enumerate((("CELL_BEACON_GREEN", "led_green"), ("CELL_BEACON_AMBER", "lamp_amber_off"), ("CELL_BEACON_RED", "lamp_red_off"))):
        p = world.part(nm, mat)
        p.add(fcyl(0.06, 0.1, 0.015, 20), T(x1, y1, 2.72 + i * 0.11))
        p.done()
    p = world.part("CELL_PANEL", "cabinet_grey")
    p.add(rbox(0.3, 0.16, 0.4, 0.02), T(x1 - 0.35, y1 + 0.12, 1.3))
    p.done(label="Cell operator panel", role="controls")
    p = world.part("CELL_PANEL_BUTTONS", "safety_red")
    p.add(cyl(0.035, 0.03, 16), T(x1 - 0.35, y1 + 0.21, 1.38) @ Rx(90))
    p.done()
    sign_board(world, "CELL_SIGN", "ROBOT-WELD-01", (x1 + 0.06, y0 + 2.6, 1.75), 90.0, width=2.3, height=0.42,
               size=0.2, label="ROBOT-WELD-01 cell sign")

    # floor: cell interior border, robot reach envelope, gate swing
    mark("frame", xa=x0 + 0.15, ya=y0 + 0.15, xb=x1 - 0.15, yb=y1 - 0.15, width=0.1, color=YELLOW)
    mark("ring", cx=rx, cy=ry, r=2.7, width=0.06, color=WHITE, dash=(0.5, 0.35))
    mark("hatch", xa=x0 - 1.0, ya=car_y - 1.2, xb=x0, yb=car_y + 1.2)
    mark("rect", xa=x1 - 1.7, ya=y1 + 0.1, xb=x1 - 0.5, yb=y1 + 1.2, color=YELLOW, alpha=0.35)
    footprint((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, 0, 0.08, 0.3)
    world.finish()
