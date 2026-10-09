# =============================================================================
#  People, for scale: simple standing operators in shop-appropriate PPE
#
#  1.75 m tall, low-poly, built once per uniform and instanced. A person beside
#  a 6.6 m press is the quickest way for the eye to read the plant's real size.
# =============================================================================

WORKER_STYLES = {
    "assembly": dict(top="signal_blue", hat="white_paint", vest=None),
    "press": dict(top="dark_grey", hat="safety_yellow", vest="hivis"),
    "body": dict(top="machine_grey", hat="white_paint", vest="hivis"),
    "paint": dict(top="white_paint", hat="white_paint", vest=None),
}


def worker_template(style):
    def build(F):
        st = WORKER_STYLES[style]
        m = Machine("WORKER", F, "PEOPLE", "site", hero=False, template=True)
        for sy in (-0.1, 0.1):
            m.mb.add(fcyl(0.075, 0.84, 0.03, 10), T(0.0, sy, 0.47), "graphite")            # legs
            m.mb.add(rbox(0.26, 0.11, 0.08, 0.03), T(0.05, sy, 0.04), "rubber")            # boots
        m.mb.add(rbox(0.26, 0.42, 0.62, 0.08, 1), T(0.0, 0.0, 1.17), st["top"])           # torso
        if st["vest"]:
            m.mb.add(rbox(0.275, 0.43, 0.36, 0.08, 1), T(0.0, 0.0, 1.2), "safety_yellow")
            m.mb.add(box(), T(0.14, 0.0, 1.12) @ S(0.01, 0.38, 0.04), "lens_clear")        # reflective band
        for sy in (-0.255, 0.255):
            m.mb.add(fcyl(0.055, 0.62, 0.03, 10), T(0.06, sy, 1.12) @ Ry(-14), st["top"])  # arms
            m.mb.add(sphere(0.05, 8, 4), T(0.14, sy, 0.82), "skin")                       # hands
        m.mb.add(cyl(0.05, 0.08, 10), T(0.0, 0.0, 1.5), "skin")                           # neck
        m.mb.add(sphere(0.105, 14, 8), T(0.0, 0.0, 1.62), "skin")                        # head
        m.mb.add(dome(0.125, 0.11, 14, 3), T(0.0, 0.0, 1.66), st["hat"])                  # helmet / cap
        m.mb.add(box(), T(0.11, 0.0, 1.665) @ S(0.08, 0.2, 0.012), st["hat"])            # brim
        return m
    return build


_WORKERS = {}


def place_worker(style, x, y, heading, name=None):
    tpl = _WORKERS.get(style)
    if tpl is None:
        tpl = _WORKERS[style] = Template(f"WORKER_{style.upper()}", worker_template(style), detail=1.0)
    n = name or f"PERSON_{style.upper()}"
    tpl.place(n, T(x, y, 0.0) @ Rz(heading), "PEOPLE")
    footprint(x, y, 0.45, 0.5, heading, 0.35, 0.18)


def build_people():
    # press shop: the operator at PRESS-STAMP-01's HMI, a die setter by the tandem line
    p = LAYOUT["press"]
    place_worker("press", p["x"] + 4.1, p["y"] + 2.4, 180.0)
    place_worker("press", 33.0, -29.8, 90.0)
    place_worker("press", 47.0, -14.6, 200.0)
    # body shop: at the panel racks and the robot cell gate
    c = LAYOUT["robot_cell"]
    place_worker("body", c["x1"] + 1.8, c["y1"] - 1.0, 180.0)
    place_worker("body", -41.0, -19.4, 270.0)
    place_worker("body", -28.0, -17.6, 90.0)
    # paint shop: inspectors at the light tunnel
    place_worker("paint", -13.6, 16.0, 0.0)
    place_worker("paint", -7.4, 22.0, 180.0)
    # final assembly: one operator beside every other trim and final-line car
    xs = list(np.arange(5.5, 52.0, ASM_PITCH))
    for i, x in enumerate(xs):
        if i % 2 == 0:
            place_worker("assembly", x + 0.6, TRIM_Y - 1.95, 90.0)
        else:
            place_worker("assembly", x - 0.8, TRIM_Y + 1.95, 270.0)
    for i, x in enumerate([v for v in xs if v < 44.0][1:]):
        if i % 2 == 0:
            place_worker("assembly", x + 0.4, FINAL_Y + 1.95, 270.0)
    for x in (24.0, 32.0):
        place_worker("assembly", x, CHASSIS_Y - 1.0, 90.0)
    # end of line and dispatch
    place_worker("assembly", 52.0, FINAL_Y - 3.6, 90.0)
    place_worker("assembly", SITE["x1"] + 9.5, 8.0, 180.0)
