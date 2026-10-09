# =============================================================================
#  Heavy stamping press (straight-side, double-crank, top drive)
#
#  Hero dimensions (k = 1): 2,500 t, bed 6.8 m x 4.0 m, crown top 5.5 m,
#  main motor top 6.6 m, foundation 8.2 m x 5.4 m. Local frame: origin on the
#  floor at the bed centre, +X right, -Y front (die area, operator side), +Z up.
#  The drive (flywheel, clutch, belt guard) is on the left (-X) end.
# =============================================================================

# extrusion along -X of a profile drawn in (Y, Z)
M_YZ = np.array([[0.0, 0.0, -1.0, 0.0], [1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]])


def press_dims(k):
    zf = 0.12
    zb1 = zf + 1.0 * k
    zbol = zb1 + 0.28 * k
    zld = zbol + 0.5 * k
    zud0 = zld + 0.9 * k
    zud1 = zud0 + 0.55 * k
    zsl1 = zud1 + 0.7 * k
    zc0 = zsl1 + 0.35 * k
    zc1 = zc0 + 1.1 * k
    return dict(zc0=zc0, zc1=zc1, zbr=(zc0 + zc1) / 2, Dc=3.6 * k, Wb=6.8 * k, Db=4.0 * k)


def world_rect(F, x0, y0, x1, y1):
    pts = [apply_point(F, (x, y, 0)) for x in (x0, x1) for y in (y0, y1)]
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def press_floor_marks(F, Wf, Df):
    """Hazard band round the foundation and a keep-out line 1 m further out."""
    ax0, ay0, ax1, ay1 = world_rect(F, -Wf / 2, -Df / 2, Wf / 2, Df / 2)
    b = 0.35
    mark("hatch", xa=ax0 - b, ya=ay0 - b, xb=ax1 + b, yb=ay0)
    mark("hatch", xa=ax0 - b, ya=ay1, xb=ax1 + b, yb=ay1 + b)
    mark("hatch", xa=ax0 - b, ya=ay0, xb=ax0, yb=ay1)
    mark("hatch", xa=ax1, ya=ay0, xb=ax1 + b, yb=ay1)
    mark("frame", xa=ax0 - 1.4, ya=ay0 - 1.4, xb=ax1 + 1.4, yb=ay1 + 1.4, width=0.1, color=YELLOW)
    cx, cy = (ax0 + ax1) / 2, (ay0 + ay1) / 2
    footprint(cx, cy, ax1 - ax0 - 0.4, ay1 - ay0 - 0.4, 0, 0.6, 0.9)


def build_press(prefix, x, y, rot, hero=True, k=1.0, machine_id=None, plate_text=None,
                frame_mat="press_blue", body_mat="press_grey", coll=None, template=False):
    if not hero and LOD[-1] >= 1.0:
        with low_detail(0.5):
            return build_press(prefix, x, y, rot, hero, k, machine_id, plate_text, frame_mat, body_mat, coll, template)
    F = T(x, y, 0.0) @ Rz(rot)
    m = Machine(prefix, F, coll or ("HERO_PRESS" if hero else "PRESS_SHOP"), "press", machine_id, hero,
                template=template)

    zf = 0.12
    Wb, Db, Hb = 6.8 * k, 4.0 * k, 1.0 * k
    zb1 = zf + Hb
    zbol = zb1 + 0.28 * k
    zld = zbol + 0.5 * k
    zud0 = zld + 0.9 * k
    zud1 = zud0 + 0.55 * k
    zsl1 = zud1 + 0.7 * k
    zc0 = zsl1 + 0.35 * k
    zc1 = zc0 + 1.1 * k
    ux0, ux1 = 2.45 * k, 3.35 * k
    Du = 3.4 * k
    Dc = 3.6 * k
    Wf, Df = Wb + 1.4, Db + 1.4

    # ---------------------------------------------------------------- base
    p = m.part("FOUNDATION", "foundation")
    p.add(rbox(Wf, Df, zf, 0.03), T(0, 0, zf / 2))
    p.done(label="Press foundation block", role="structure", tags=("foundation",))

    p = m.part("BED", body_mat)
    p.add(rbox(Wb, Db, Hb, 0.05, 2), T(0, 0, zf + Hb / 2))
    for sx in (-1, 1):                                   # bed access doors, front
        p.add(rbox(1.6 * k, 0.04, 0.55 * k, 0.015), T(sx * 1.6 * k, -Db / 2 - 0.02, zf + Hb * 0.5))
    p.add(rbox(Wb + 0.08, Db + 0.08, 0.08, 0.02), T(0, 0, zb1 - 0.04))
    p.done(label="Press bed", role="structure", tags=("bed",))

    p = m.part("BOLSTER", "steel_dark")
    p.add(rbox(4.6 * k, 2.6 * k, zbol - zb1, 0.02), T(0, 0, (zb1 + zbol) / 2))
    for sy in (-1, 1):
        for sx in np.linspace(-1.9, 1.9, 4) * k:
            p.add(fcyl(0.09, 0.07, 0.01, 16), T(sx, sy * 1.33 * k, zb1 + 0.1) @ Rx(90))
    p.done(label="Moving bolster", role="structure", tags=("bolster",))

    # ---------------------------------------------------------------- dies and part
    p = m.part("DIE_LOWER", "die_steel")
    p.add(rbox(3.6 * k, 2.1 * k, 0.32 * k, 0.02), T(0, 0, zbol + 0.16 * k))
    p.add(rbox(2.5 * k, 1.25 * k, 0.2 * k, 0.09, 2), T(0, 0, zld - 0.1 * k))          # punch
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(cyl(0.07, 0.25 * k, 16), T(sx * 1.6 * k, sy * 0.85 * k, zbol + 0.32 * k + 0.12 * k))
    p.done(label="Lower die (draw punch)", role="tooling", tags=("die",))

    p = m.part("DIE_UPPER", "die_steel")
    p.add(rbox(3.6 * k, 2.1 * k, zud1 - zud0, 0.02), T(0, 0, (zud0 + zud1) / 2))
    p.add(rbox(2.8 * k, 1.5 * k, 0.12, 0.03), T(0, 0, zud0 - 0.06))
    p.done(label="Upper die", role="tooling", tags=("die",))

    p = m.part("DIE_GUIDE_PINS", "chrome")
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(cyl(0.05, 0.42 * k, 16), T(sx * 1.6 * k, sy * 0.85 * k, zud0 - 0.21 * k))
    p.done(label="Die guide pins", role="tooling")

    def bump(gx, gy):
        ax, ay = 1.25 * k, 0.62 * k
        d = np.maximum(np.abs(gx) / ax, np.abs(gy) / ay)
        return 0.2 * k * np.clip((1.12 - d) / 0.24, 0, 1) ** 1.6
    p = m.part("PANEL", "sheet_steel")
    p.add(grid_plane(2.9 * k, 1.6 * k, 36, 20, bump), T(0, 0, zld - 0.2 * k + 0.006))
    p.done(label="Formed door panel in the die", role="workpiece", tags=("panel",))

    # ---------------------------------------------------------------- slide and drive links
    p = m.part("SLIDE", body_mat)
    p.add(rbox(4.6 * k, 2.7 * k, zsl1 - zud1, 0.05, 2), T(0, 0, (zud1 + zsl1) / 2))
    p.add(rbox(1.2 * k, 0.25, 0.3, 0.03), T(0, -1.35 * k - 0.1, zud1 + 0.35 * k))       # slide adjust motor box
    p.done(label="Slide (ram)", role="motion", tags=("slide",))

    p = m.part("CONNECTING_RODS", "chrome")
    for sx in (-1.6 * k, 1.6 * k):
        for sy in (-0.7 * k, 0.7 * k):
            p.add(cyl(0.16 * k, zc0 - zsl1 + 0.1, 20), T(sx, sy, (zsl1 + zc0) / 2))
    p.done(label="Connecting rods (pitmans)", role="motion")

    p = m.part("CONNECTING_ROD_BOOTS", "rubber")
    for sx in (-1.6 * k, 1.6 * k):
        for sy in (-0.7 * k, 0.7 * k):
            for zz in np.linspace(zsl1 + 0.04, zc0 - 0.06, 5):
                p.add(cyl(0.21 * k, 0.05, 20), T(sx, sy, zz))
    p.done()

    # ---------------------------------------------------------------- uprights
    for side, name in ((-1, "UPRIGHT_LEFT"), (1, "UPRIGHT_RIGHT")):
        p = m.part(name, frame_mat)
        cx, t = side * (ux0 + ux1) / 2, ux1 - ux0
        for (ya, yb) in ((-Du / 2, -0.62 * k), (0.62 * k, Du / 2)):
            p.add(rbox(t, yb - ya, zc0 - zb1, 0.05, 2), T(cx, (ya + yb) / 2, (zb1 + zc0) / 2))
        p.add(rbox(t, 1.3 * k, 0.5 * k, 0.03), T(cx, 0, zb1 + 0.25 * k))
        p.add(rbox(t, 1.3 * k, 0.55 * k, 0.03), T(cx, 0, zc0 - 0.275 * k))
        for yy in (-1.15 * k, 1.15 * k):
            p.add(rbox(0.1, 0.1, zc0 - zb1 - 0.3, 0.02), T(side * (ux1 + 0.04), yy, (zb1 + zc0) / 2))
        p.done(label=f"Upright, {'left' if side < 0 else 'right'}", role="structure", tags=("frame",))

    p = m.part("SLIDE_GIBS", "brass")
    for side in (-1, 1):
        for yy in (-0.9 * k, 0.9 * k):
            p.add(box(), T(side * (ux0 - 0.03), yy, (zbol + zc0) / 2 + 0.3) @ S(0.06, 0.22, zc0 - zbol - 0.6))
    p.done(label="Slide guide gibs", role="motion")

    # ---------------------------------------------------------------- crown
    p = m.part("CROWN", frame_mat)
    p.add(rbox(Wb, Dc, zc1 - zc0, 0.07, 2), T(0, 0, (zc0 + zc1) / 2))
    for sx in (-1.7 * k, 0.0, 1.7 * k):
        p.add(rbox(1.5 * k, 2.6 * k, 0.05, 0.02), T(sx, 0, zc1 + 0.025))               # top covers
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(rbox(0.22, 0.12, 0.22, 0.03), T(sx * (Wb / 2 - 0.35), sy * (Dc / 2 - 0.2), zc1 + 0.11))  # lifting lugs
    p.add(rbox(Wb - 0.6, 0.05, 0.08, 0.01), T(0, -Dc / 2 - 0.02, zc0 + 0.1))
    p.done(label="Crown (drive housing)", role="structure", tags=("crown", "frame"))

    p = m.part("TIE_RODS", "steel")
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(cyl(0.25 * k, 0.28, 6), T(sx * 2.9 * k, sy * 1.2 * k, zc1 + 0.14))      # hex nuts
            p.add(fcyl(0.17 * k, 0.5, 0.03, 20), T(sx * 2.9 * k, sy * 1.2 * k, zc1 + 0.28 + 0.2))
    p.done(label="Tie rods and nuts", role="structure")

    # ---------------------------------------------------------------- main bearings
    zbr = (zc0 + zc1) / 2
    for side, name, lab in ((-1, "MAIN_BEARING", "Main bearing, drive end"),
                            (1, "MAIN_BEARING_NDE", "Main bearing, non-drive end")):
        p = m.part(name, "cast_iron")
        M = T(side * 1.6 * k, -Dc / 2, zbr) @ Rx(90)
        p.add(fcyl(0.42 * k, 0.3 * k, 0.04, 32), M @ T(0, 0, 0.15 * k))
        p.add(fcyl(0.5 * k, 0.07, 0.015, 32), M @ T(0, 0, 0.035))
        p.add(fcyl(0.3 * k, 0.06, 0.02, 32), M @ T(0, 0, 0.3 * k + 0.03))
        bolt_ring(p, M @ T(0, 0, 0.07), 0.46 * k, 12, 0.024, 0.035, 6)
        bolt_ring(p, M @ T(0, 0, 0.3 * k + 0.06), 0.24 * k, 6, 0.018, 0.025, 6)
        p.add(cyl(0.025, 0.16, 8), M @ T(0, 0.43 * k, 0.15 * k) @ Rx(-90) @ T(0, 0, 0.08))  # grease nipple
        p.done(label=lab, role="bearing", tags=("main_bearing_housing", "bearing"),
               channel="PRESS-STAMP-01.BEARING_VIBRATION_RMS" if side < 0 and hero else None)
        if side < 0 and hero:
            s = m.part("MAIN_BEARING_SENSOR", "graphite")
            Ms = M @ T(0, 0.42 * k, 0.15 * k) @ Rx(-90)
            s.add(fcyl(0.035, 0.07, 0.008, 16), Ms @ T(0, 0, 0.035))
            s.add(cyl(0.012, 0.05, 8), Ms @ T(0, 0, 0.09))
            s.add(sweep(fillet_path([apply_point(Ms, (0, 0, 0.11)), apply_point(Ms, (0.0, 0, 0.3)),
                                     apply_point(Ms, (0.5, 0.0, 0.3))], 0.08), radius=0.008, seg=6))
            s.done(label="Accelerometer on the drive-end main bearing", role="sensor",
                   tags=("vibration_sensor",), channel="PRESS-STAMP-01.BEARING_VIBRATION_RMS")

    # ---------------------------------------------------------------- drive: clutch, flywheel, guard
    fx0 = -Wb / 2
    zfw = zbr
    yfw = 0.3 * k
    Rfw = 0.95 * k
    Rg = 1.12 * k
    p = m.part("CLUTCH_BRAKE", "cast_iron")
    p.add(fcyl(0.55 * k, 0.32 * k, 0.03, 32), T(fx0 - 0.16 * k, yfw, zfw) @ Ry(90))
    bolt_ring(p, T(fx0 - 0.32 * k, yfw, zfw) @ Ry(-90), 0.45 * k, 12, 0.02, 0.03)
    p.done(label="Clutch and brake unit", role="drive", tags=("clutch",))

    gx0 = fx0 - 0.34 * k                   # guard inner face
    gw = 0.62 * k                          # guard width along X
    p = m.part("FLYWHEEL", "cast_iron")
    Mf = T(gx0 - gw / 2, yfw, zfw) @ Ry(90)
    p.add(tube(Rfw, Rfw - 0.16 * k, 0.4 * k, 48), Mf)
    p.add(fcyl(0.24 * k, 0.5 * k, 0.03, 24), Mf)
    for i in range(6):
        a = 60.0 * i
        p.add(rbox(0.14 * k, Rfw - 0.3 * k, 0.18 * k, 0.03), Mf @ Rz(a) @ T(0, (Rfw - 0.3 * k) / 2 + 0.2 * k, 0))
    p.done(label="Flywheel", role="drive", tags=("flywheel",))

    p = m.part("FLYWHEEL_GUARD", "safety_yellow")
    p.add(tube(Rg, Rg - 0.02, gw, 56), T(gx0 - gw / 2, yfw, zfw) @ Ry(90))
    p.add(cyl(Rg, 0.02, 56), T(gx0 + 0.01, yfw, zfw) @ Ry(90))
    for i in range(4):
        a = math.radians(45 + 90 * i)
        p.add(box(), T(gx0 - gw, yfw + Rg * 0.98 * math.cos(a), zfw + Rg * 0.98 * math.sin(a)) @ S(0.04, 0.05, 0.05))
    p.done(label="Flywheel guard", role="guard", tags=("guard",))
    p = m.part("FLYWHEEL_GUARD_MESH", "mesh_panel")
    p.add(cyl(Rg - 0.015, 0.004, 56, caps=True), T(gx0 - gw + 0.01, yfw, zfw) @ Ry(90), uv="box", tile=0.4)
    p.done()

    # ---------------------------------------------------------------- main motor on the crown
    mr = 0.42 * k
    ym, zm = 1.25 * k, zc1 + 0.25 + mr
    mx_out, mx_in = -3.05 * k, -1.55 * k
    p = m.part("MOTOR_BASE", "dark_grey")
    p.add(rbox(1.75 * k, 1.0 * k, 0.25, 0.02), T((mx_out + mx_in) / 2, ym, zc1 + 0.125))
    p.done()
    p = m.part("MAIN_MOTOR", "motor_slate")
    Lm = mx_in - mx_out
    Mm = T((mx_out + mx_in) / 2, ym, zm) @ Ry(90)
    p.add(cyl(mr, Lm - 0.2, 40, caps=False), Mm)
    for i in range(36):                                                           # axial cooling fins
        a = 360.0 * i / 36
        p.add(box(), Mm @ Rz(a) @ T(mr + 0.03, 0, 0) @ S(0.06, 0.012, Lm - 0.32))
    p.add(fcyl(mr + 0.01, 0.12, 0.03, 40), Mm @ T(0, 0, -(Lm - 0.2) / 2 - 0.05))   # drive-end shield
    p.add(fcyl(mr + 0.05, 0.36, 0.04, 40), Mm @ T(0, 0, (Lm - 0.2) / 2 + 0.16))    # fan cowl
    for rr in (0.1, 0.2, 0.3):
        p.add(torus(rr * k, 0.012, 32, 4), Mm @ T(0, 0, (Lm - 0.2) / 2 + 0.345))
    p.add(rbox(0.38, 0.32, 0.26, 0.03), T((mx_out + mx_in) / 2 + 0.1, ym, zm + mr + 0.1))  # terminal box
    for sx in (-0.45, 0.45):
        p.add(rbox(0.2, 0.75 * k, 0.16, 0.02), T((mx_out + mx_in) / 2 + sx, ym, zm - mr - 0.02))  # feet
    p.add(torus(0.06, 0.015, 12, 6), T((mx_out + mx_in) / 2 - 0.3, ym, zm + mr + 0.06) @ Rx(90))
    p.done(label="Main drive motor, 250 kW", role="motor", tags=("main_motor", "motor"),
           channel="PRESS-STAMP-01.MAIN_MOTOR_CURRENT" if hero else None)
    p = m.part("MOTOR_SHAFT", "steel")
    p.add(cyl(0.065, abs(mx_out - (gx0 - gw / 2)) + 0.1, 16), T((mx_out + gx0 - gw / 2) / 2, ym, zm) @ Ry(90))
    p.done()

    # belt guard: hull of the motor pulley and the top of the flywheel guard, in (Y, Z)
    poly = circles_hull([(ym, zm, 0.36), (yfw + 0.12, zfw + 0.6 * k, 0.6 * k)], 24)
    p = m.part("BELT_GUARD", "safety_yellow")
    p.add(prism(poly, gw - 0.04), T(gx0 - 0.02, 0, 0) @ M_YZ)
    p.done(label="Drive belt guard", role="guard", tags=("guard", "belt"))

    # ---------------------------------------------------------------- platform, rails, ladder
    r = m.part("RAILING", "safety_yellow")
    toe = m.part("TOE_BOARD", "safety_yellow")
    e = 0.12
    handrail(r, [(-Wb / 2 + e, -Dc / 2 + e, zc1), (Wb / 2 - e, -Dc / 2 + e, zc1), (Wb / 2 - e, Dc / 2 - e, zc1),
                 (-Wb / 2 + e, Dc / 2 - e, zc1)], height=1.1, post_step=1.7, closed=True, toe=toe)
    r.done(label="Crown platform guard rail", role="access")
    toe.done()
    lad = m.part("LADDER", "safety_yellow")
    ladder(lad, (Wb / 2 + 0.45, 1.2 * k, 0.0), zc1, facing_deg=90.0, cage=True)
    lad.done(label="Access ladder with cage", role="access")

    # ---------------------------------------------------------------- andon
    zA = zc1 + 0.05
    ax, ay = Wb / 2 - 0.55, -Dc / 2 + 0.45
    p = m.part("ANDON", "graphite")
    p.add(cyl(0.08, 0.04, 20), T(ax, ay, zA + 0.02))
    p.add(cyl(0.022, 0.6, 10), T(ax, ay, zA + 0.32))
    p.add(dome(0.08, 0.06, 20, 4), T(ax, ay, zA + 0.62 + 0.42))
    p.done(label="Andon stack light", role="signal", tags=("andon",))
    for i, (nm, mat) in enumerate((("ANDON_GREEN", "led_green"), ("ANDON_AMBER", "lamp_amber_off"), ("ANDON_RED", "lamp_red_off"))):
        p = m.part(nm, mat)
        p.add(fcyl(0.075, 0.13, 0.02, 24), T(ax, ay, zA + 0.7 + i * 0.14))
        p.done()

    # ---------------------------------------------------------------- lubrication unit (floor, front-left)
    L0 = T(-5.2 * k, 2.2 * k, 0.0)
    p = m.part("LUBE_SKID", "steel_dark")
    p.add(rbox(1.25, 2.3, 0.14, 0.02), L0 @ T(0, 0, 0.07))
    p.add(rbox(1.33, 2.38, 0.05, 0.01), L0 @ T(0, 0, 0.165))
    p.done()
    p = m.part("LUBE_UNIT", "lube_grey")
    p.add(rbox(0.95, 1.25, 0.82, 0.04, 2), L0 @ T(0, 0.45, 0.19 + 0.41))
    p.add(fcyl(0.07, 0.08, 0.01, 16), L0 @ T(0.2, 0.75, 1.05))
    p.add(cyl(0.035, 0.18, 10), L0 @ T(-0.25, 0.85, 1.1))
    p.done(label="Central lubrication unit (oil reservoir)", role="lubrication",
           tags=("lube_unit", "lube_reservoir"), channel=None)
    p = m.part("LUBE_SIGHT_GLASS", "glass_dark")
    p.add(rbox(0.04, 0.12, 0.4, 0.01), L0 @ T(-0.48, 0.45, 0.6))
    p.done()
    p = m.part("LUBE_PUMP", "motor_teal")
    Mp = L0 @ T(0.05, -0.55, 0.42) @ Rx(90)
    p.add(cyl(0.14, 0.4, 24), Mp)
    for i in range(16):
        p.add(box(), Mp @ Rz(22.5 * i) @ T(0.15, 0, 0) @ S(0.03, 0.008, 0.32))
    p.add(fcyl(0.15, 0.08, 0.02, 24), Mp @ T(0, 0, 0.24))
    p.add(rbox(0.2, 0.36, 0.08, 0.01), L0 @ T(0.05, -0.55, 0.23))
    p.done(label="Lubrication pump motor", role="lubrication", tags=("lube_pump",))
    p = m.part("LUBE_PUMP_HEAD", "cast_iron")
    p.add(fcyl(0.1, 0.18, 0.02, 20), L0 @ T(0.05, -0.18, 0.42) @ Rx(90))
    p.done()
    p = m.part("LUBE_FILTER", "filter_silver")
    for dx in (-0.2, 0.2):
        Mf2 = L0 @ T(dx, -0.95, 0.5)
        p.add(fcyl(0.1, 0.42, 0.03, 24), Mf2)
        p.add(dome(0.1, 0.06, 24, 4), Mf2 @ T(0, 0, 0.21))
    p.done(label="Lube oil filter bank (duplex)", role="filter", tags=("lube_filter", "filter"),
           channel="PRESS-STAMP-01.LUBE_OIL_PRESSURE" if hero else None)
    p = m.part("LUBE_MANIFOLD", "steel_dark")
    p.add(rbox(0.6, 0.16, 0.12, 0.02), L0 @ T(0, -0.95, 0.24))
    p.add(rbox(0.12, 0.08, 0.1, 0.01), L0 @ T(0, -0.95, 0.85))      # differential pressure indicator
    p.done()
    p = m.part("LUBE_GAUGE", "white_paint")
    Mg = L0 @ T(0.0, -0.95, 0.98) @ Rx(90)
    p.add(fcyl(0.075, 0.03, 0.006, 24), Mg)
    p.done(label="Lube oil pressure gauge", role="gauge", tags=("lube_pressure",))
    p = m.part("LUBE_GAUGE_RIM", "chrome")
    p.add(tube(0.082, 0.072, 0.04, 24), Mg)
    p.add(cyl(0.012, 0.22, 8), L0 @ T(0, -0.95, 0.86))
    p.done()
    p = m.part("LUBE_PIPING", "copper")
    # up a pipe stand beside the unit, then across above the flywheel guard into
    # the crown end: nothing crosses the bolster-change track on the floor
    sx0, sy0 = -5.2 * k + 0.45, 2.2 * k - 0.95
    for i, dz in enumerate((0.0, 0.06, 0.12)):
        yo = 0.07 * i
        path = fillet_path([(-5.2 * k + 0.3, sy0, 0.3 + dz), (sx0, sy0 + yo, 0.3 + dz),
                            (sx0, sy0 + yo, zc0 + 0.15 + dz), (sx0, Dc / 2 - 0.1 - yo, zc0 + 0.15 + dz),
                            (-Wb / 2 + 0.02, Dc / 2 - 0.1 - yo, zc0 + 0.15 + dz)], 0.14, 5)
        p.add(sweep(path, radius=0.016, seg=8))
    p.done(label="Lube supply lines to crown", role="lubrication", tags=("lube_lines",))
    p = m.part("LUBE_PIPE_STAND", "steel_dark")
    p.add(box(), T(sx0 + 0.08, sy0 + 0.07, (zc0 + 0.4) / 2) @ S(0.08, 0.08, zc0 + 0.4))
    p.add(box(), T(sx0 + 0.08, sy0 + 0.07, 0.01) @ S(0.3, 0.3, 0.02))
    p.done()

    # ---------------------------------------------------------------- air receiver, cabinets, HMI
    # counterbalance air receiver beside the control cabinets, clear of the
    # part-transfer path behind the press
    atx, aty = Wb / 2 + 1.6, Db / 2 + 1.5
    p = m.part("AIR_TANK", "white_paint")
    p.add(cyl(0.45, 2.0, 32, caps=False), T(atx, aty, 0.75) @ Rx(90))
    p.add(dome(0.45, 0.22, 32, 5), T(atx, aty + 1.0, 0.75) @ Rx(-90))
    p.add(dome(0.45, 0.22, 32, 5), T(atx, aty - 1.0, 0.75) @ Rx(90))
    p.add(cyl(0.05, 0.3, 10), T(atx, aty + 0.4, 1.3))
    p.done(label="Counterbalance air receiver", role="pneumatic", tags=("air_tank",))
    p = m.part("AIR_TANK_SADDLES", "dark_grey")
    for sy in (-0.6, 0.6):
        p.add(rbox(0.8, 0.2, 0.35, 0.02), T(atx, aty + sy, 0.17))
    p.done()

    p = m.part("CONTROL_CABINET", "cabinet_grey")
    for i in range(3):
        yy = (i - 1) * 0.82
        p.add(rbox(0.6, 0.8, 2.0, 0.02), T(Wb / 2 + 1.6, yy, 0.1 + 1.0))
        p.add(box(), T(Wb / 2 + 1.29, yy + 0.3, 1.1) @ S(0.03, 0.03, 0.22))      # handles
    p.done(label="Press control cabinet", role="controls", tags=("control_cabinet",))
    p = m.part("CONTROL_CABINET_PLINTH", "graphite")
    p.add(box(), T(Wb / 2 + 1.6, 0, 0.05) @ S(0.62, 2.48, 0.1))
    p.add(box(), T(Wb / 2 + 1.6, 0, 2.18) @ S(0.62, 2.48, 0.06))
    p.done()
    p = m.part("HMI", "graphite")
    Mh = T(2.4 * k, -Db / 2 - 1.4, 0.0) @ Rz(0)
    p.add(cyl(0.05, 1.2, 12), Mh @ T(0, 0, 0.6))
    p.add(rbox(0.6, 0.12, 0.44, 0.02), Mh @ T(0, 0, 1.45) @ Rx(-15))
    p.add(rbox(0.36, 0.36, 0.06, 0.01), Mh @ T(0, 0, 0.03))
    p.done(label="Operator HMI panel", role="controls", tags=("hmi",))
    p = m.part("HMI_SCREEN", "screen")
    p.add(box(), Mh @ T(0, 0, 1.45) @ Rx(-15) @ T(0, -0.062, 0.0) @ S(0.52, 0.005, 0.34))
    p.done()

    # ---------------------------------------------------------------- light curtains at the die opening
    p = m.part("LIGHT_CURTAIN", "safety_yellow")
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(rbox(0.07, 0.07, 2.4, 0.01), T(sx * 2.62 * k, sy * (Db / 2 + 0.35), zb1 + 0.05 + 1.2))
    p.done(label="Safety light curtains", role="safety", tags=("light_curtain",))
    p = m.part("LIGHT_CURTAIN_LED", "led_red")
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.add(box(), T(sx * (2.62 * k - 0.04), sy * (Db / 2 + 0.35), zb1 + 1.25) @ S(0.012, 0.02, 2.2))
    p.done()

    # bolster change rails, out to the left (towards the aisle)
    p = m.part("BOLSTER_RAILS", "rail_steel")
    for sy in (-0.9 * k, 0.9 * k):
        p.add(box(), T(-Wb / 2 - 3.2, sy, 0.025) @ S(6.4, 0.09, 0.05))
    p.done(label="Moving bolster change rails", role="structure")

    # name plate on the crown front, between the bearings
    if plate_text:
        sign_board(m, "NAMEPLATE", plate_text, (0.0, -Dc / 2 - 0.04, zbr), 0.0,
                   width=2.05 * k, height=0.34 * k, size=0.16 * k, label=f"{plate_text} name plate")

    if hero:
        # hazard striping on the die-opening edges of both uprights, front and back
        p = m.part("DIE_OPENING_STRIPES", "hazard", uv="box", tile=0.4)
        for side in (-1, 1):
            for sy in (-1, 1):
                p.add(box(), T(side * (ux0 + 0.02), sy * (Du / 2 + 0.006), (zb1 + zc0) / 2) @ S(0.16, 0.012, zc0 - zb1 - 0.1))
        p.add(box(), T(0, -2.6 * k / 2 - 0.02, zbol - 0.05) @ S(4.6 * k, 0.012, 0.1))
        p.done()
        # crown: inspection covers, lube distributor block with feed lines, capacity plate
        p = m.part("CROWN_COVERS", "press_grey")
        for sx in (-2.4, -0.8, 0.8, 2.4):
            p.add(rbox(1.1, 0.04, 0.42, 0.02), T(sx * k, -Dc / 2 - 0.02, zc1 - 0.32))
        p.done()
        p = m.part("CROWN_COVER_BOLTS", "steel")
        for sx in (-2.4, -0.8, 0.8, 2.4):
            for bx in (-0.48, 0.48):
                for bz in (-0.16, 0.16):
                    p.add(cyl(0.016, 0.02, 6), T(sx * k + bx, -Dc / 2 - 0.045, zc1 - 0.32 + bz) @ Rx(90))
        p.done()
        p = m.part("LUBE_DISTRIBUTOR", "brass")
        p.add(rbox(0.5, 0.12, 0.16, 0.01), T(-0.2, -Dc / 2 - 0.06, zc0 + 0.18))
        for i in range(6):
            x = -0.4 + i * 0.16
            p.add(sweep(fillet_path([(x, -Dc / 2 - 0.08, zc0 + 0.26), (x, -Dc / 2 - 0.08, zc0 + 0.42),
                                     (x * 2.2 + (1.6 if x > -0.2 else -1.6), -Dc / 2 - 0.08, zc0 + 0.42)], 0.06, 3),
                        radius=0.008, seg=6))
        p.done()
        sign_board(m, "CAPACITY_PLATE", "2500 t", (Wb / 2 - 0.75, -Dc / 2 - 0.04, zc0 + 0.25), 0.0,
                   width=0.8, height=0.28, size=0.16, board_mat="safety_yellow", text_mat="graphite")
        # cable tray from the control cabinets up the right upright to the crown
        p = m.part("CABLE_TRAY", "galvanized")
        tx = Wb / 2 + 0.25
        p.add(box(), T(tx, -1.1 * k, (0.2 + zc1) / 2) @ S(0.06, 0.35, zc1 - 0.2))
        p.add(box(), T((tx + Wb / 2 + 1.3) / 2, -1.1 * k, 2.3) @ S(Wb / 2 + 1.3 - tx, 0.35, 0.06))
        p.done()
        p = m.part("CABLES", "cable")
        p.add(box(), T(tx + 0.045, -1.1 * k, (0.2 + zc1) / 2) @ S(0.04, 0.28, zc1 - 0.25))
        p.add(box(), T((tx + Wb / 2 + 1.3) / 2, -1.1 * k, 2.345) @ S(Wb / 2 + 1.3 - tx, 0.28, 0.04))
        p.done()
    press_floor_marks(F, Wf, Df)
    footprint(*apply_point(F, (-5.2 * k, 2.2 * k, 0))[:2], 1.4, 2.5, rot + 0, 0.45, 0.4)
    m.finish()
    return m
