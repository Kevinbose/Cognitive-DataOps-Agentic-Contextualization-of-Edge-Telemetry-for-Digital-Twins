# =============================================================================
#  Machine safety fencing (ISO 14120 style welded-mesh panels)
#
#  2.2 m high: 60 x 60 mm yellow posts, panels up to 1.5 m wide, 50 mm wire
#  mesh (alpha-masked texture, so it costs two triangles a panel), 150 mm
#  solid kick plate. Openings are gates (interlocked) or light-curtain muting
#  openings for conveyors.
# =============================================================================

FENCE_H = 2.2
KICK_H = 0.15


def fence(m, pts, openings=(), closed=True, height=FENCE_H, max_panel=1.5, names=None, post_mat="safety_yellow"):
    """Fence along a polyline in the machine's local frame.

    openings: list of dicts {seg, s0, s1, kind} where kind is gate, curtain
    or open; s0/s1 are metres along that segment from its start.
    names: optional overrides for the part names (posts, mesh, frame, kick).
    """
    names = names or {}
    posts = m.part(names.get("posts", "FENCE_POSTS"), post_mat)
    mesh = m.part(names.get("mesh", "FENCE_MESH"), "mesh_panel")
    frame = m.part(names.get("frame", "FENCE_FRAMES"), "dark_grey")
    kick = m.part(names.get("kick", "FENCE_KICK_PLATES"), "dark_grey")
    gate_p = m.part(names.get("gate", "FENCE_GATE"), post_mat)
    curtain = m.part(names.get("curtain", "FENCE_LIGHT_CURTAIN"), "safety_yellow")
    curtain_led = m.part(names.get("curtain_led", "FENCE_LIGHT_CURTAIN_LED"), "led_red")
    lock = m.part(names.get("lock", "FENCE_INTERLOCK"), "safety_red")

    P = [np.asarray(p, float) for p in pts]
    if closed:
        P = P + [P[0]]
    post_spots = []
    for si, (a, b) in enumerate(zip(P[:-1], P[1:])):
        L = float(np.linalg.norm(b - a))
        d = (b - a) / L
        ang = math.degrees(math.atan2(d[1], d[0]))
        ops = sorted([o for o in openings if o["seg"] == si], key=lambda o: o["s0"])
        # solid runs between openings
        runs, cur = [], 0.0
        for o in ops:
            runs.append((cur, o["s0"])); cur = o["s1"]
        runs.append((cur, L))
        for (r0, r1) in runs:
            if r1 - r0 < 0.05:
                continue
            n = max(1, int(math.ceil((r1 - r0) / max_panel)))
            for k in range(n):
                s0 = r0 + (r1 - r0) * k / n
                s1 = r0 + (r1 - r0) * (k + 1) / n
                c = a + d * (s0 + s1) / 2
                w = s1 - s0 - 0.07
                M = T(c[0], c[1], 0) @ Rz(ang)
                mesh.add(plane(w, height - KICK_H - 0.06), M @ T(0, 0, KICK_H + (height - KICK_H) / 2) @ Rx(90), uv="box", tile=0.4)
                kick.add(box(), M @ T(0, 0, KICK_H / 2 + 0.01) @ S(w, 0.012, KICK_H))
                for zz in (KICK_H + 0.01, height - 0.02):
                    frame.add(box(), M @ T(0, 0, zz) @ S(w, 0.025, 0.025))
                for sx in (-w / 2, w / 2):
                    frame.add(box(), M @ T(sx, 0, (KICK_H + height) / 2) @ S(0.02, 0.025, height - KICK_H))
                post_spots += [a + d * s0, a + d * s1]
        for o in ops:
            s0, s1 = o["s0"], o["s1"]
            c = a + d * (s0 + s1) / 2
            M = T(c[0], c[1], 0) @ Rz(ang)
            w = s1 - s0
            post_spots += [a + d * s0, a + d * s1]
            if o["kind"] == "gate":
                gw = w - 0.12
                M2 = M @ T(-w / 2 + 0.06, 0, 0) @ Rz(-12) @ T(gw / 2, 0, 0)      # slightly ajar
                mesh.add(plane(gw - 0.06, height - KICK_H - 0.1), M2 @ T(0, 0, KICK_H + (height - KICK_H) / 2) @ Rx(90), uv="box", tile=0.4)
                for zz in (KICK_H + 0.02, height - 0.04, (KICK_H + height) / 2):
                    gate_p.add(box(), M2 @ T(0, 0, zz) @ S(gw, 0.035, 0.035))
                for sx in (-gw / 2, gw / 2):
                    gate_p.add(box(), M2 @ T(sx, 0, (KICK_H + height) / 2) @ S(0.035, 0.035, height - KICK_H))
                lock.add(rbox(0.06, 0.05, 0.16, 0.008), M @ T(w / 2 - 0.08, -0.05, 1.1))
            elif o["kind"] == "curtain":
                for sx in (-w / 2 + 0.05, w / 2 - 0.05):
                    curtain.add(rbox(0.05, 0.05, 1.9, 0.008), M @ T(sx, -0.05, 0.95 + 0.05))
                    curtain_led.add(box(), M @ T(sx + (0.027 if sx < 0 else -0.027), -0.05, 1.0) @ S(0.006, 0.02, 1.75))
                frame.add(box(), M @ T(0, 0, height - 0.02) @ S(w, 0.025, 0.025))       # header
    # posts, de-duplicated
    seen = []
    for p in post_spots:
        if any(np.linalg.norm(p - q) < 0.05 for q in seen):
            continue
        seen.append(p)
        posts.add(rbox(0.06, 0.06, height + 0.05, 0.006), T(p[0], p[1], (height + 0.05) / 2))
        posts.add(box(), T(p[0], p[1], 0.005) @ S(0.16, 0.16, 0.01))
    out = {}
    for key, part in (("posts", posts), ("mesh", mesh), ("frame", frame), ("kick", kick), ("gate", gate_p),
                      ("curtain", curtain), ("curtain_led", curtain_led), ("lock", lock)):
        out[key] = part
    return out


def finish_fence(parts, label_prefix="Safety fence"):
    labels = {"posts": f"{label_prefix} posts", "mesh": f"{label_prefix} mesh panels", "gate": f"{label_prefix} gate",
              "curtain": f"{label_prefix} light curtain", "lock": f"{label_prefix} gate interlock"}
    for key, part in parts.items():
        part.done(label=labels.get(key), role="safety" if key in labels else None, tags=("fence",) if key in labels else ())
