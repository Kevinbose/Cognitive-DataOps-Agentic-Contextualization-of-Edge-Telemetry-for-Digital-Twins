# =============================================================================
#  Six-axis industrial robot (210 kg payload class, 2.7 m reach)
#
#  Kinematics follow a KR 210 R2700-class arm: A2 sits 0.33 m forward of A1 and
#  0.675 m above the base, lower arm 1.15 m, forearm offset 0.115 m, A3 to wrist
#  centre 1.22 m, wrist centre to flange 0.215 m. Joint angles are solved so the
#  tool really touches its work (see solve_reach), which is what makes a line of
#  robots look like it is working rather than posed.
#
#  Local frame: origin on the floor under A1, +X forward (the robot's front).
# =============================================================================

ROBOT_DIM = dict(a1z=0.675, a2x=0.33, a2=1.15, a3off=0.115, a3=1.22, a6=0.215, base_h=0.24)


def robot_fk(th, plinth=0.0):
    """Joint frames for angles th[0..5] (degrees). Returns dict of 4x4 matrices."""
    d = ROBOT_DIM
    t1, t2, t3, t4, t5, t6 = th
    B = T(0, 0, plinth)
    M1 = B @ T(0, 0, d["base_h"]) @ Rz(t1)
    M2 = M1 @ T(d["a2x"], 0, d["a1z"] - d["base_h"]) @ Ry(t2)
    M3 = M2 @ T(0, 0, d["a2"]) @ Ry(t3)
    M4 = M3 @ T(0, 0, d["a3off"]) @ Rx(t4)
    M5 = M4 @ T(d["a3"], 0, 0) @ Ry(t5)
    M6 = M5 @ T(d["a6"], 0, 0) @ Rx(t6)
    return dict(B=B, M1=M1, M2=M2, M3=M3, M4=M4, M5=M5, M6=M6)


# tool centre point in flange coordinates, per tool type
TOOL_TCP = {"spot_gun": (0.835, 0.0, -0.29), "gripper": (0.32, 0.0, 0.0), "sealer": (0.42, 0.0, -0.12),
            "paint": (0.36, 0.0, 0.0), "glazing": (0.30, 0.0, 0.0), "none": (0.05, 0.0, 0.0)}


def solve_reach(target_local, tool="spot_gun", plinth=0.0, approach=(0, 0, -1), seed=(0, 30, 10, 0, 40, 0), iters=80):
    """Damped least squares on A1, A2, A3, A5 (A4, A6 fixed) so the TCP reaches the
    target with the tool's jaw axis close to `approach` (local robot frame)."""
    tcp = np.array([*TOOL_TCP[tool], 1.0])
    target = np.asarray(target_local, float)
    app = _unit(approach)
    th = np.array(seed, float)
    free = [0, 1, 2, 4]
    limits = {1: (-70, 95), 2: (-110, 80), 4: (-120, 120)}

    def err(t):
        fr = robot_fk(t, plinth)
        p = (fr["M6"] @ tcp)[:3]
        # a C-gun closes along the flange -Z; other tools work along the flange +X
        axis = -fr["M6"][:3, 2] if tool == "spot_gun" else fr["M6"][:3, 0]
        return np.concatenate([p - target, 0.3 * (axis - app)])

    h = 0.1                                    # degrees
    for _ in range(iters):
        e = err(th)
        if np.linalg.norm(e[:3]) < 1e-3 and np.linalg.norm(e[3:]) < 0.03:
            break
        J = np.zeros((6, len(free)))
        for j, idx in enumerate(free):
            dt = np.array(th); dt[idx] += h
            J[:, j] = (err(dt) - e) / math.radians(h)
        step = np.linalg.solve(J.T @ J + 0.02 * np.eye(len(free)), -J.T @ e)
        step = np.degrees(np.clip(step, -0.25, 0.25))
        for j, idx in enumerate(free):
            th[idx] += step[j]
            if idx in limits:
                th[idx] = float(np.clip(th[idx], *limits[idx]))
    return tuple(float(v) for v in th)


def _arm_profile(r0, r1, L):
    """Capsule-like side profile in (x, z) from a circle r0 at z=0 to r1 at z=L."""
    return circles_hull([(0.0, 0.0, r0), (0.0, L, r1)], 28)


M_XZ = np.array([[1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]])
# prism profile drawn in (x, z), extruded along +y  (det = -1, builder flips winding)


def build_robot(prefix, frame, th, tool="spot_gun", plinth=0.35, hero=False, coll=None, zone="body",
                machine_id=None, body_mat="robot_orange", motor_mat="graphite", base_mat="robot_base", into=None):
    if into is not None:
        frame = into.frame @ frame
    m = Machine(prefix, frame, coll or ("HERO_ROBOT" if hero else "BODY_SHOP"), zone, machine_id, hero, into=into)
    d = ROBOT_DIM
    fr = robot_fk(th, plinth)
    B, M1, M2, M3, M4, M5, M6 = (fr[k] for k in ("B", "M1", "M2", "M3", "M4", "M5", "M6"))

    # ---------------------------------------------------------------- plinth and base
    if plinth > 0:
        p = m.part("PEDESTAL", "steel_dark")
        p.add(rbox(1.05, 1.05, plinth - 0.03, 0.02), T(0, 0, (plinth - 0.03) / 2))
        p.add(rbox(1.35, 1.35, 0.03, 0.01), T(0, 0, 0.015))
        for sx in (-0.58, 0.58):
            for sy in (-0.58, 0.58):
                p.add(cyl(0.025, 0.06, 8), T(sx, sy, 0.06))
        p.done(label="Robot pedestal", role="structure")
    p = m.part("BASE", base_mat)
    p.add(rbox(0.78, 0.78, 0.06, 0.01), B @ T(0, 0, 0.03))
    p.add(fcyl(0.36, d["base_h"] - 0.06, 0.03, 40), B @ T(0, 0, 0.06 + (d["base_h"] - 0.06) / 2))
    bolt_ring(p, B @ T(0, 0, 0.06), 0.33, 8, 0.02, 0.025)
    p.done(label="Robot base (A1 housing)", role="robot_base", tags=("base",))

    # ---------------------------------------------------------------- A1 carousel and shoulder
    p = m.part("A1_COLUMN", body_mat)
    p.add(fcyl(0.37, 0.16, 0.03, 40), M1 @ T(0, 0, 0.08))
    prof = circles_hull([(-0.12, 0.12, 0.26), (d["a2x"], d["a1z"] - d["base_h"], 0.31)], 28)
    p.add(prism(prof, 0.56), M1 @ T(0, -0.28, 0) @ M_XZ)
    p.done(label="Axis 1 rotating column", role="robot_link", tags=("axis_1",))
    p = m.part("A1_MOTOR", motor_mat)
    p.add(fcyl(0.1, 0.36, 0.02, 24), M1 @ T(-0.32, 0.16, 0.32))
    p.add(rbox(0.12, 0.1, 0.1, 0.01), M1 @ T(-0.32, 0.16, 0.54))
    p.done(label="Axis 1 servo motor", role="motor", tags=("axis_1_motor",))

    # ---------------------------------------------------------------- A2 lower arm
    p = m.part("A2_LOWER_ARM", body_mat)
    p.add(fcyl(0.3, 0.64, 0.04, 40), M2 @ Rx(90))                                   # A2 hub
    p.add(prism(_arm_profile(0.25, 0.19, d["a2"]), 0.34), M2 @ T(0, -0.17, 0) @ M_XZ)
    p.add(fcyl(0.22, 0.5, 0.04, 32), M2 @ T(0, 0, d["a2"]) @ Rx(90))                # A3 hub
    p.done(label="Axis 2 lower arm", role="robot_link", tags=("axis_2",))
    if hero:
        p = m.part("ID_LABEL", "white_paint")
        p.add(text_prim("ROBOT-WELD-01", 0.075, 0.004), M2 @ T(0.0, 0.172, 0.62) @ Rx(-90) @ Rz(-90))
        p.done()
    p = m.part("A2_MOTOR", motor_mat)
    p.add(fcyl(0.13, 0.4, 0.02, 24), M2 @ T(0, 0.52, 0) @ Rx(90))
    p.add(rbox(0.13, 0.12, 0.1, 0.01), M2 @ T(0.0, 0.52, 0.17))
    p.done(label="Axis 2 servo motor", role="motor", tags=("axis_2_motor",))

    # counterbalance: carousel rear to lower arm, recomputed for the pose
    pa = apply_point(M1, (-0.3, -0.33, 0.62))
    pb = apply_point(M2, (-0.2, -0.33, 0.45))
    p = m.part("COUNTERBALANCE", "dark_grey")
    p.add(fcyl(0.085, 1.0, 0.02, 20), between(pa, pa + (pb - pa) * 0.62) @ T(0, 0, 0.5))
    p.done(label="Hydropneumatic counterbalance", role="robot_link", tags=("counterbalance",))
    p = m.part("COUNTERBALANCE_ROD", "chrome")
    p.add(cyl(0.035, 1.0, 12), between(pa + (pb - pa) * 0.6, pb) @ T(0, 0, 0.5))
    p.done()

    # ---------------------------------------------------------------- A3 arm housing (wrist motors at the rear)
    p = m.part("A3_ARM", body_mat)
    p.add(rbox(0.62, 0.44, 0.42, 0.08, 2), M3 @ T(-0.06, 0, d["a3off"]))
    p.add(fcyl(0.24, 0.46, 0.04, 32), M3 @ Rx(90))
    p.done(label="Axis 3 arm housing", role="robot_link", tags=("axis_3",))
    p = m.part("A4_SERVO_MOTOR", motor_mat)
    Mm = M3 @ T(-0.37, 0, d["a3off"] + 0.02) @ Ry(-90)
    p.add(fcyl(0.1, 0.34, 0.02, 24), Mm @ T(0, 0, 0.17))
    p.add(rbox(0.12, 0.1, 0.1, 0.01), Mm @ T(0.12, 0, 0.17))
    p.done(label="Axis 4 servo motor (wrist roll)", role="motor", tags=("axis_4_motor", "servo"),
           channel="ROBOT-WELD-01.AXIS_4_SERVO_TORQUE" if hero else None)
    p = m.part("WRIST_MOTORS", motor_mat)
    for sy in (-0.14, 0.14):
        Mw = M3 @ T(-0.36, sy, d["a3off"] + 0.17) @ Ry(-90)
        p.add(fcyl(0.075, 0.3, 0.02, 20), Mw @ T(0, 0, 0.15))
    p.done(label="Axis 5 and 6 servo motors", role="motor", tags=("axis_5_motor", "axis_6_motor"))

    # ---------------------------------------------------------------- A4 forearm tube, A5 wrist, A6 flange
    p = m.part("A4_FOREARM", body_mat)
    p.add(cyl(0.15, 0.88, 32, r_top=0.12), M4 @ T(0.66, 0, 0) @ Ry(90))
    p.add(fcyl(0.17, 0.1, 0.02, 32), M4 @ T(0.26, 0, 0) @ Ry(90))
    for sy in (-0.12, 0.12):                                                          # wrist fork
        p.add(rbox(0.26, 0.05, 0.22, 0.03), M4 @ T(d["a3"] - 0.06, sy, 0))
    p.done(label="Axis 4 forearm", role="robot_link", tags=("axis_4",))
    p = m.part("A5_WRIST", body_mat)
    p.add(fcyl(0.1, 0.19, 0.02, 28), M5 @ Rx(90))
    p.add(cyl(0.085, 0.14, 28, r_top=0.075), M5 @ T(0.1, 0, 0) @ Ry(90))
    p.done(label="Axis 5 wrist", role="robot_link", tags=("axis_5",))
    p = m.part("A6_FLANGE", "steel")
    p.add(fcyl(0.08, 0.04, 0.008, 28), M6 @ T(-0.02, 0, 0) @ Ry(90))
    p.add(rbox(0.035, 0.2, 0.2, 0.01), M6 @ T(0.017, 0, 0))
    p.done(label="Axis 6 tool flange", role="robot_link", tags=("axis_6", "flange"))

    # ---------------------------------------------------------------- tool
    tcp_w = None
    if tool == "spot_gun":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("WELD_GUN", "steel_dark")
        p.add(rbox(0.3, 0.24, 0.34, 0.03), G @ T(0.17, 0, 0.02))                     # transformer
        c_shape = [(0.3, 0.07), (0.86, 0.07), (0.86, -0.05), (0.42, -0.05), (0.42, -0.45),
                   (0.84, -0.45), (0.84, -0.55), (0.3, -0.55)]
        p.add(prism(c_shape, 0.07), G @ T(0, -0.035, 0) @ M_XZ)
        p.add(rbox(0.08, 0.16, 0.1, 0.01), G @ T(0.3, 0, -0.2))
        p.done(label="Servo spot-welding gun", role="tool", tags=("weld_gun", "gun"),
               channel="ROBOT-WELD-01.WELD_GUN_TEMP" if hero else None)
        p = m.part("WELD_GUN_SERVO", motor_mat)
        p.add(fcyl(0.065, 0.3, 0.015, 20), G @ T(0.8, 0, 0.22))
        p.add(cyl(0.03, 0.14, 12), G @ T(0.8, 0, 0.0))
        p.done(label="Weld gun servo actuator", role="tool", tags=("gun_servo",))
        p = m.part("WELD_GUN_TIP", "copper")
        p.add(cyl(0.022, 0.2, 16), G @ T(0.8, 0, -0.15))
        p.add(dome(0.022, 0.025, 16, 3), G @ T(0.8, 0, -0.25) @ Rx(180))
        p.add(cyl(0.022, 0.13, 16), G @ T(0.8, 0, -0.385))
        p.add(dome(0.022, 0.025, 16, 3), G @ T(0.8, 0, -0.32))
        p.done(label="Electrode caps (tool centre point)", role="tool", tags=("tcp", "electrode"),
               channel="ROBOT-WELD-01.TOOL_CENTER_POINT_DEVIATION" if hero else None)
        tcp_w = apply_point(G, (0.8, 0, -0.29))
        hp = m.part("WELD_GUN_HOSES", "hose_blue")
        hr = m.part("WELD_GUN_HOSES_RED", "hose_red")
        for part_, dy in ((hp, 0.05), (hr, -0.05)):
            path = fillet_path([apply_point(G, (0.15, dy, 0.2)), apply_point(G, (0.0, dy, 0.38)),
                                apply_point(M4, (0.7, dy, 0.24)), apply_point(M4, (0.25, dy, 0.24))], 0.1, 5)
            part_.add(sweep(path, radius=0.014, seg=8))
        hp.done(); hr.done()
    elif tool == "gripper":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("GRIPPER", "aluminium")
        p.add(rbox(0.1, 0.9, 0.08, 0.01), G @ T(0.08, 0, 0))
        p.add(rbox(0.1, 0.08, 0.9, 0.01), G @ T(0.08, 0, 0))
        for sy in (-0.42, 0.42):
            for sz in (-0.42, 0.42):
                p.add(cyl(0.04, 0.16, 12), G @ T(0.2, sy if abs(sz) < 0.1 else 0, sz if abs(sy) < 0.1 else 0) @ Ry(90))
        p.done(label="Vacuum gripper", role="tool")
    elif tool == "sealer":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("SEALER_GUN", "aluminium")
        p.add(fcyl(0.06, 0.3, 0.01, 16), G @ T(0.15, 0, 0) @ Ry(90))
        p.add(cyl(0.012, 0.18, 8), G @ T(0.35, 0, -0.06) @ Ry(135))
        p.done(label="Sealer applicator", role="tool")
    elif tool == "paint":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("ATOMIZER", "aluminium")
        p.add(cyl(0.07, 0.24, 20, r_top=0.05), G @ T(0.12, 0, 0) @ Ry(90))
        p.add(cyl(0.035, 0.06, 20), G @ T(0.27, 0, 0) @ Ry(90))
        p.done(label="Rotary bell atomizer", role="tool")
    elif tool == "glazing":
        G = M6 @ T(0.035, 0, 0)
        p = m.part("GLAZING_GRIPPER", "aluminium")
        p.add(rbox(0.08, 1.1, 0.06, 0.01), G @ T(0.06, 0, 0))
        for sy in (-0.5, 0.5):
            p.add(cyl(0.07, 0.05, 16), G @ T(0.13, sy, 0) @ Ry(90))
        p.done(label="Glazing suction gripper", role="tool")

    # ---------------------------------------------------------------- dress pack (cable bundle)
    p = m.part("DRESS_PACK", "corrugated")
    side = -0.36
    path = [apply_point(M1, (-0.42, side + 0.05, 0.25)), apply_point(M1, (-0.2, side, 0.75)),
            apply_point(M2, (-0.2, side, 0.25)), apply_point(M2, (-0.22, side, 0.8)),
            apply_point(M3, (-0.3, side + 0.05, d["a3off"] + 0.3)), apply_point(M4, (0.4, 0.0, 0.24)),
            apply_point(M4, (0.95, 0.0, 0.2))]
    if tool == "spot_gun":
        path.append(apply_point(M6, (0.05, 0.0, 0.25)))
    p.add(sweep(fillet_path(path, 0.18, 6), radius=0.042, seg=10))
    p.done(label="Robot dress pack", role="cabling", tags=("dress_pack",))

    m.finish()
    m.tcp = None if tcp_w is None else apply_point(frame, tcp_w)
    return m


def robot_controller(prefix, frame, coll, zone, hero=False, machine_id=None, into=None):
    """Controller cabinet with teach pendant, plus the weld timer cabinet."""
    if into is not None:
        frame = into.frame @ frame
    m = Machine(prefix, frame, coll, zone, machine_id, hero, into=into)
    p = m.part("CONTROLLER", "cabinet_grey")
    p.add(rbox(0.8, 0.55, 1.25, 0.02), T(0, 0, 0.1 + 0.625))
    p.add(box(), T(0.0, -0.28, 0.95) @ S(0.62, 0.02, 0.5))
    p.done(label="Robot controller cabinet", role="controls", tags=("controller",))
    p = m.part("CONTROLLER_TRIM", "robot_orange")
    p.add(box(), T(0, -0.278, 1.28) @ S(0.8, 0.02, 0.06))
    p.add(box(), T(0, 0, 0.05) @ S(0.82, 0.57, 0.1))
    p.done()
    p = m.part("TEACH_PENDANT", "graphite")
    p.add(rbox(0.33, 0.06, 0.24, 0.02), T(0.25, -0.3, 1.05) @ Rx(-10))
    p.add(sweep(fillet_path([(0.25, -0.31, 0.93), (0.3, -0.36, 0.6), (0.36, -0.3, 0.3), (0.38, -0.28, 0.18)], 0.1), radius=0.008, seg=6))
    p.done(label="Teach pendant", role="controls", tags=("pendant",))
    p = m.part("PENDANT_SCREEN", "screen")
    p.add(box(), T(0.25, -0.334, 1.05) @ Rx(-10) @ S(0.2, 0.004, 0.14))
    p.done()
    p = m.part("WELD_CONTROLLER", "cabinet_grey")
    p.add(rbox(0.6, 0.45, 1.6, 0.02), T(1.0, 0, 0.8))
    p.done(label="Weld timer cabinet", role="controls", tags=("weld_timer",))
    p = m.part("WELD_CONTROLLER_PANEL", "graphite")
    p.add(box(), T(1.0, -0.23, 1.2) @ S(0.36, 0.02, 0.24))
    p.done()
    p = m.part("CONTROLLER_LEDS", "led_green")
    p.add(cyl(0.012, 0.012, 8), T(-0.2, -0.29, 1.15) @ Rx(90))
    p.add(cyl(0.012, 0.012, 8), T(1.08, -0.235, 1.38) @ Rx(90))
    p.done()
    footprint(*apply_point(frame, (0.5, 0, 0))[:2], 2.0, 0.8, math.degrees(math.atan2(frame[1, 0], frame[0, 0])), 0.4, 0.25)
    return m.finish()
