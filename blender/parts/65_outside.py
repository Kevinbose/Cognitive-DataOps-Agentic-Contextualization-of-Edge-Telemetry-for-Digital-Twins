# =============================================================================
#  Outside: logistics yard, dispatch, utilities; plus aisle traffic inside
# =============================================================================

def truck_template(F, trailer="box", tractor=True):
    """Articulated truck backed onto a dock: trailer rear at the origin, along +X."""
    m = Machine("TRUCK", F, "LOGISTICS", "logistics", hero=False, template=True)
    L = 13.6
    if trailer == "box":
        m.mb.add(rbox(L, 2.55, 2.75, 0.04), T(L / 2, 0, 1.3 + 1.375), "white_paint")
        m.mb.add(box(), T(L / 2, 0, 1.22) @ S(L - 0.4, 2.3, 0.14), "steel_dark")
        for k in np.linspace(0.4, L - 0.4, 12):
            m.mb.add(box(), T(k, 1.28, 2.68) @ S(0.04, 0.012, 2.6), "panel_white")
            m.mb.add(box(), T(k, -1.28, 2.68) @ S(0.04, 0.012, 2.6), "panel_white")
    elif trailer == "flat":
        m.mb.add(box(), T(L / 2, 0, 1.3) @ S(L, 2.55, 0.16), "steel_dark")
    elif trailer == "carrier":
        for z in (1.0, 2.6):
            m.mb.add(box(), T(L / 2, 0, z) @ S(L, 2.5, 0.08), "steel_dark")
        for k in np.linspace(0.3, L - 0.3, 7):
            for sy in (-1.22, 1.22):
                m.mb.add(box(), T(k, sy, 1.8) @ S(0.1, 0.1, 1.8), "safety_red")
        m.mb.add(box(), T(L / 2, -1.22, 3.3) @ S(L, 0.06, 0.06), "safety_red")
        m.mb.add(box(), T(L / 2, 1.22, 3.3) @ S(L, 0.06, 0.06), "safety_red")
    for ax in (1.2, 2.5, 3.8):                                                    # trailer axles
        for sy in (-1.0, 1.0):
            m.mb.add(cyl(0.5, 0.6, 20), T(ax, sy, 0.5) @ Rx(90), "tire")
            m.mb.add(cyl(0.3, 0.62, 16), T(ax, sy, 0.5) @ Rx(90), "rim")
    for sy in (-0.9, 0.9):
        m.mb.add(box(), T(L - 2.8, sy, 0.6) @ S(0.12, 0.12, 0.9), "steel_dark")            # landing legs
    if tractor:
        tx = L + 1.0
        m.mb.add(box(), T(tx + 1.4, 0, 0.9) @ S(5.6, 1.1, 0.35), "steel_dark")          # chassis
        m.mb.add(rbox(2.3, 2.5, 2.7, 0.12, 2), T(tx + 3.2, 0, 1.15 + 1.35), "signal_blue")  # cab
        m.mb.add(rbox(0.04, 2.2, 1.0, 0.03), T(tx + 4.36, 0, 3.0), "glass_dark")
        m.mb.add(rbox(1.7, 2.3, 0.6, 0.1), T(tx + 3.1, 0, 4.05), "signal_blue")            # roof fairing
        for ax, r in ((tx + 3.6, 0.5), (tx, 0.5), (tx - 1.3, 0.5)):
            for sy in (-1.0, 1.0):
                m.mb.add(cyl(r, 0.5, 20), T(ax, sy, r) @ Rx(90), "tire")
        m.mb.add(rbox(0.35, 2.5, 0.35, 0.05), T(tx + 4.45, 0, 0.6), "graphite")              # bumper
    return m


def build_logistics():
    coll = "LOGISTICS"
    y1 = SITE["y1"]
    box_truck = Template("TRUCK_BOX", lambda F: truck_template(F, "box", True))
    trailer_only = Template("TRAILER_BOX", lambda F: truck_template(F, "box", False))
    for k, x in enumerate((12.0, 19.0, 26.0, 33.0)):
        tpl = trailer_only if k == 2 else box_truck
        tpl.place(f"YARD_TRUCK_DOCK_{k + 1}", T(x, y1 + 0.75, 0.0) @ Rz(90.0), coll,
                  label=f"Inbound truck at dock {k + 1}", zone="logistics", role="vehicle", tags=("truck",))
        footprint(x, y1 + 8.0, 2.8, 14.0, 0, 0.45, 0.5)
    # coil delivery at the press-shop coil dock (east)
    flat = Template("TRUCK_FLAT", lambda F: truck_template(F, "flat", True))
    flat.place("YARD_COIL_TRUCK", T(SITE["x1"] + 0.8, -18.0, 0.0), coll, label="Coil delivery truck", zone="logistics",
               role="vehicle", tags=("truck",))
    for k, cx in enumerate((SITE["x1"] + 4.0, SITE["x1"] + 7.5)):
        prop_coil(env("YARD", cx, -18.0, coll), T(cx, -18.0, 1.38) @ Rz(0), r=0.8, w=1.3)
    footprint(SITE["x1"] + 9.0, -18.0, 18.0, 2.8, 0, 0.4, 0.5)

    # dispatch yard: finished cars, car transporter
    for i, y in enumerate(np.arange(4.5, 33.0, 3.0)):
        place_car(f"YARD_FINISHED_CAR_{i + 1}", "final", ASM_COLOURS[(i * 5) % len(ASM_COLOURS)], SITE["x1"] + 6.2, y,
                  -0.15, 180.0, coll=coll)
    carrier = Template("TRUCK_CAR_CARRIER", lambda F: truck_template(F, "carrier", True))
    cx0 = SITE["x1"] + 13.5
    carrier.place("YARD_CAR_TRANSPORTER", T(cx0, 6.0, 0.0) @ Rz(90.0), coll, label="Car transporter", zone="logistics",
                  role="vehicle", tags=("truck",))
    for deck, z in enumerate((1.04, 2.64)):
        for j, off in enumerate((2.5, 7.4, 12.0)):
            col = ASM_COLOURS[(deck * 3 + j * 2) % len(ASM_COLOURS)]
            place_car(f"YARD_TRANSPORTER_CAR_{deck}_{j}", "final", col, cx0, 6.0 + off, z, 90.0, coll=coll)
    footprint(cx0, 6.0 + 8.5, 2.8, 19.0, 0, 0.45, 0.5)

    # aisle traffic inside the hall
    build_tugger_train("AISLE_TUGGER_1", -18.0, 1.3, 0.0, coll, "logistics", carts=3)
    build_agv("AISLE_AGV_1", 10.0, -1.4, 180.0, coll, "logistics", load="rack")
    build_forklift("AISLE_FORKLIFT_1", -44.0, 1.2, 0.0, coll, "logistics")
    build_forklift("YARD_FORKLIFT_1", 40.0, y1 + 6.0, 200.0, coll, "logistics")
    # skips for press-shop scrap, south apron
    for k, sx in enumerate((40.0, 44.0)):
        mb = env("YARD", sx, SITE["y0"] - 5.0, coll)
        mb.add(prism([(-1.9, -1.0), (1.9, -1.0), (2.3, 1.0), (-2.3, 1.0)], 1.6), T(sx, SITE["y0"] - 5.0, -0.15) @ Rx(90) @ T(0, 1.0, -0.9), "door_green")
        footprint(sx, SITE["y0"] - 5.0, 4.6, 1.9, 0, 0.45, 0.4)


def build_utilities():
    coll = "UTILITIES"
    xw = SITE["x0"] - 7.0
    gz = -0.15
    mb = env("UTIL", xw, 20.0, coll)
    # cooling towers
    for y in (27.5, 21.0):
        mb.add(rbox(5.2, 5.2, 4.4, 0.05), T(xw, y, gz + 2.2), "panel_white")
        for k in np.linspace(-2.2, 2.2, 10):
            mb.add(box(), T(xw + 2.62, y + k, gz + 1.4) @ S(0.03, 0.25, 2.2), "galvanized")
        mb.add(cyl(1.9, 1.3, 32, r_top=2.1, caps=False), T(xw, y, gz + 5.05), "galvanized")
        mb.add(cyl(1.85, 0.02, 32), T(xw, y, gz + 4.75), "graphite")
        footprint(xw, y, 5.6, 5.6, 0, 0.5, 0.6)
    # air-cooled chillers
    for y in (13.5, 9.5):
        mb.add(rbox(6.0, 2.4, 2.3, 0.04), T(xw, y, gz + 1.15), "panel_white")
        for k in (-2.0, 0.0, 2.0):
            mb.add(cyl(0.75, 0.25, 24), T(xw + k, y, gz + 2.42), "graphite")
            mb.add(torus(0.75, 0.03, 24, 4), T(xw + k, y, gz + 2.55), "galvanized")
        footprint(xw, y, 6.2, 2.6, 0, 0.45, 0.4)
    # water tank
    mb.add(cyl(2.8, 7.5, 40), T(xw, 2.0, gz + 3.75), "galvanized")
    mb.add(dome(2.8, 0.6, 40, 4), T(xw, 2.0, gz + 7.5), "galvanized")
    for k in np.arange(0.6, 7.5, 1.0):
        mb.add(torus(2.81, 0.02, 40, 4), T(xw, 2.0, gz + k), "steel_dark")
    footprint(xw, 2.0, 5.8, 5.8, 0, 0.5, 0.6)
    # compressor house with vertical air receiver
    mb.add(rbox(7.5, 6.0, 4.4, 0.05), T(xw - 0.5, -9.0, gz + 2.2), "cladding", uv="box", tile=1.0)
    mb.add(box(), T(xw - 0.5, -9.0, gz + 4.45) @ S(7.7, 6.2, 0.15), "steel_dark")
    for k in np.linspace(-2.5, 2.5, 6):
        mb.add(box(), T(xw + 3.27, -9.0 + k * 0.8, gz + 2.8) @ S(0.04, 0.6, 1.1), "graphite")   # louvres
    mb.add(cyl(0.7, 3.6, 24), T(xw + 3.6, -4.6, gz + 1.9), "white_paint")
    mb.add(dome(0.7, 0.35, 24, 4), T(xw + 3.6, -4.6, gz + 3.7), "white_paint")
    footprint(xw - 0.5, -9.0, 7.8, 6.3, 0, 0.5, 0.6)
    # transformers in a fenced compound
    for k, y in enumerate((-22.0, -28.0)):
        mb.add(rbox(2.4, 1.6, 2.2, 0.03), T(xw, y, gz + 1.1), "door_green")
        for f in np.linspace(-1.0, 1.0, 11):
            mb.add(box(), T(xw + f, y + 0.95, gz + 1.05) @ S(0.03, 0.3, 1.7), "door_green")
            mb.add(box(), T(xw + f, y - 0.95, gz + 1.05) @ S(0.03, 0.3, 1.7), "door_green")
        for b in (-0.6, 0.0, 0.6):
            mb.add(cyl(0.07, 0.5, 10), T(xw + b, y, gz + 2.45), "white_paint")
        footprint(xw, y, 3.0, 2.4, 0, 0.5, 0.4)
    um = Machine("UTILITY_COMPOUND", np.eye(4), coll, "utilities", hero=False)
    parts = fence(um, [(xw - 2.6, -31.0), (xw + 2.6, -31.0), (xw + 2.6, -19.0), (xw - 2.6, -19.0)],
                  openings=[dict(seg=1, s0=5.0, s1=6.2, kind="gate")], post_mat="door_green")
    um.finish()
    # paint-shop exhaust: regenerative thermal oxidiser and tall stack
    mb.add(rbox(6.0, 3.0, 3.2, 0.04), T(xw, 33.0 + 0.2, gz + 1.6), "machine_grey")
    mb.add(cyl(0.9, 24.0, 32), T(xw + 2.2, 33.2, gz + 12.0), "galvanized")
    for k in (6.0, 12.0, 18.0, 23.6):
        mb.add(torus(0.92, 0.04, 32, 4), T(xw + 2.2, 33.2, gz + k), "steel_dark")
    footprint(xw, 33.2, 6.4, 3.4, 0, 0.5, 0.5)
    # pipe bridge from the utilities into the hall along the west wall
    for y in np.arange(-24.0, 30.0, 6.0):
        mb.add(box(), T(SITE["x0"] - 2.0, y, gz + 2.6) @ S(0.25, 0.25, 5.2), "steel_dark")
        mb.add(box(), T(SITE["x0"] - 2.0, y, gz + 5.25) @ S(1.6, 0.25, 0.2), "steel_dark")
    for k, (dx, r, mat) in enumerate(((-0.5, 0.16, "galvanized"), (-0.1, 0.12, "safety_red"), (0.3, 0.12, "signal_green"), (0.6, 0.08, "safety_yellow"))):
        mb.add(cyl(r, 54.0, 16, caps=False), T(SITE["x0"] - 2.0 + dx, 3.0, gz + 5.35 + r) @ Rx(90), mat)
