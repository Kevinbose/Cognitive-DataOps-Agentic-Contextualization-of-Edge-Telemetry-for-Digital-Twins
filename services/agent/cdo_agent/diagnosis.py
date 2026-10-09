"""Signature scoring: the documented discriminator tables, applied to computed features.

Each test reads one feature, compares it with a documented band, and names the
faults the result points to and the faults it rules out (press 02 Tables 29 to
31, robot 02 Tables 3, 4, 24 and 25). A fault's score is the weight of the
tests that support it minus the weight of those that contradict it, plus a
small prior for the faults the documents mark as modelled. Nothing here calls
a model, so a diagnosis is reproducible and every verdict can be shown.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

from . import knowledge as K


@dataclass
class Test:
    test: str
    channel: str | None
    observed: str
    expected: str
    supports: tuple[str, ...] = ()
    contradicts: tuple[str, ...] = ()
    weight: float = 1.0
    ref: str = ""
    finding: bool = False        # an abnormal observation, not only a discriminator

    def verdict_for(self, fault_id: str) -> str:
        if fault_id in self.supports:
            return "supports"
        if fault_id in self.contradicts:
            return "contradicts"
        return "neutral"


@dataclass
class Hypothesis:
    id: str
    name: str
    code: str | None
    component: str
    score: float
    support: float
    against: float
    confidence: float = 0.0

    @property
    def label(self) -> str:
        return f"{self.id} {self.code}" if self.code else self.id


@dataclass
class Diagnosis:
    machine_id: str
    level: str
    level_reasons: list[str]
    features: dict
    tests: list[Test]
    ranked: list[Hypothesis]
    healthy: bool = False
    notes: list[str] = field(default_factory=list)
    machine_type: str = ""
    label: str | None = None

    @property
    def name(self) -> str:
        return self.label or self.machine_id

    @property
    def root(self) -> Hypothesis | None:
        return self.ranked[0] if self.ranked else None

    def evidence_rows(self, limit: int = 12) -> list[dict]:
        root = self.root
        rows = []
        for t in sorted(self.tests, key=lambda t: -t.weight):
            rows.append({"test": t.test, "channel": t.channel, "observed": t.observed, "expected": t.expected,
                         "verdict": t.verdict_for(root.id) if root else "neutral"})
        return rows[:limit]

    def to_dict(self) -> dict:
        return {"machineId": self.machine_id, "machineType": self.machine_type, "label": self.label,
                "level": self.level, "levelReasons": self.level_reasons,
                "features": self.features, "healthy": self.healthy, "notes": self.notes,
                "tests": [asdict(t) for t in self.tests],
                "ranked": [asdict(h) for h in self.ranked]}


SHORT = {
    "Lube pressure, 60 s mean": "P60", "Broadband floor above 300 Hz (HB300)": "HB300",
    "Peak-to-median ratio above 300 Hz (PMR300)": "PMR300", "Vibration above the 4.0 mm/s alarm": "V60",
    "Vibration rise against baseline": "V60 change", "Current rise per unit vibration rise (dI/dV)": "dI/dV",
    "Stroke peak current (Ipk)": "Ipk", "RMS agrees with the spectrum": "RMS against spectrum",
    "Clog severity from pressure and from vibration agree": "clog severity", "Cycle mean shift (dM)": "dM",
    "Sixth-harmonic ripple at 0.75 Hz (A6)": "A6", "Ripple per unit mean shift (A6/dM)": "A6/dM",
    "Noise growth per unit mean shift": "noise growth", "TCP shift per unit mean shift": "TCP shift",
    "Cycle swing change (dSw)": "dSw", "Weld gun temperature": "gun temperature",
    "Largest sample-to-sample step": "largest step",
}


def short_name(test: "Test") -> str:
    """The documents' own abbreviation for a test, for use inside a sentence."""
    if test.test in SHORT:
        return SHORT[test.test]
    if test.test.startswith("Defect lines"):
        return "defect lines"
    if test.test in ("Channel is flat", "Data age"):
        return f"{test.channel.replace('_', ' ').lower() if test.channel else 'channel'} {test.test.lower()}"
    return test.test[0].lower() + test.test[1:]


def _fmt(x, unit: str = "", d: int = 2) -> str:
    if x is None:
        return "n/a"
    return f"{x:.{d}f}{(' ' + unit) if unit else ''}"


# --- levels ------------------------------------------------------------------

def _grade(value, spec) -> int:
    if value is None:
        return 0
    direction, *bounds = spec
    level = 0
    for i, b in enumerate(bounds, start=1):
        if b is None:
            continue
        if (direction > 0 and value >= b) or (direction < 0 and value <= b):
            level = i
    return level


def press_level(f: dict) -> tuple[str, list[str]]:
    reasons, worst = [], 0
    names = {"P60": "lube pressure (60 s mean)", "V60": "bearing vibration (60 s mean)",
             "Ipk": "stroke peak current", "HB300": "high-band floor above 300 Hz"}
    units = {"P60": "bar", "V60": "mm/s", "Ipk": "A", "HB300": "mm/s"}
    for key, spec in K.PRESS_LEVELS.items():
        g = _grade(f.get(key), spec)
        if g:
            reasons.append(f"{names[key]} {_fmt(f.get(key), units[key], 3 if key == 'HB300' else 2)} is {K.LEVELS[g]}")
        worst = max(worst, g)
    return K.LEVELS[worst], reasons


def robot_level(f: dict) -> tuple[str, list[str]]:
    if not f.get("cycles"):
        return "normal", []
    reasons = []
    level = 0
    if (f.get("maxSample") or 0) >= K.ROBOT_CRITICAL_SAMPLE or (f.get("M") or 0) >= K.ROBOT_CRITICAL_MEAN:
        level = 4
        reasons.append(f"a torque sample of {_fmt(f.get('maxSample'), 'Nm', 1)} or a cycle mean of {_fmt(f.get('M'), 'Nm', 1)} is critical")
    if f.get("peaksOver30", 0) >= 2 or (f.get("TCP") or 0) >= 0.5 or (f.get("gunMax") or 0) >= 105:
        level = max(level, 3)
        reasons.append(f"{f.get('peaksOver30', 0)} cycle peaks at or above 30 Nm, TCP {_fmt(f.get('TCP'), 'mm', 3)}")
    if f.get("peaksOver26", 0) >= 2 or (f.get("TCP") or 0) >= 0.25 or (f.get("gunMax") or 0) >= 85:
        level = max(level, 2)
        reasons.append(f"{f.get('peaksOver26', 0)} cycle peaks at or above 26 Nm, TCP {_fmt(f.get('TCP'), 'mm', 3)}")
    if (f.get("M") or 0) >= K.ROBOT_WATCH_MEAN or (f.get("A6") or 0) >= K.ROBOT_A6_PRESENT:
        level = max(level, 1)
        reasons.append(f"cycle mean {_fmt(f.get('M'), 'Nm', 1)}, sixth-harmonic ripple {_fmt(f.get('A6'), 'Nm')}")
    return K.LEVELS[level], reasons


# --- tests -------------------------------------------------------------------

P_LOW = ("F01", "F03", "F04", "F06", "F12", "F16")
P_NORMAL = ("F02", "F08", "F09", "F10", "F11", "F13", "F14")


def press_tests(f: dict, stale: list[str] | None = None) -> list[Test]:
    B = K.PRESS_BANDS
    T: list[Test] = []
    P60, V60, HB, PMR = f.get("P60"), f.get("V60"), f.get("HB300"), f.get("PMR300")

    if P60 is not None:
        if P60 <= B["P60_clog_max"]:
            T.append(Test("Lube pressure, 60 s mean", "LUBE_OIL_PRESSURE", _fmt(P60, "bar"),
                          "at or below 4.30 bar points to a lubrication fault", P_LOW, P_NORMAL + ("F05",), 2.0, "press 02 Table 29", finding=True))
        elif P60 >= B["P60_high"]:
            T.append(Test("Lube pressure, 60 s mean", "LUBE_OIL_PRESSURE", _fmt(P60, "bar"),
                          "above 5.0 bar points to a blockage after the transducer", ("F05", "F06"), P_LOW, 2.0, "press 02 Table 31", finding=True))
        elif P60 >= B["P60_normal"][0]:
            T.append(Test("Lube pressure, 60 s mean", "LUBE_OIL_PRESSURE", _fmt(P60, "bar"),
                          "4.45 to 4.55 bar is normal", P_NORMAL, P_LOW + ("F05",), 2.0, "press 02 Table 29"))
        else:
            T.append(Test("Lube pressure, 60 s mean", "LUBE_OIL_PRESSURE", _fmt(P60, "bar"),
                          "4.30 to 4.45 bar is ambiguous", (), (), 0.5, "press 02 Table 29"))

    if HB is not None:
        if HB >= B["HB300_clog_min"]:
            T.append(Test("Broadband floor above 300 Hz (HB300)", "BEARING_VIBRATION_RMS", _fmt(HB, "mm/s", 3),
                          "0.24 mm/s or more is lubrication starvation", ("F01", "F16", "F03", "F04"),
                          ("F02", "F08", "F09", "F10", "F12", "F14"), 2.0, "press 02 Table 29", finding=True))
        elif HB <= B["HB300_quiet_max"]:
            T.append(Test("Broadband floor above 300 Hz (HB300)", "BEARING_VIBRATION_RMS", _fmt(HB, "mm/s", 3),
                          "0.03 to 0.10 mm/s is a quiet floor", ("F02", "F08", "F09", "F10", "F12"),
                          ("F01", "F16"), 1.5, "press 02 Table 29"))
        else:
            T.append(Test("Broadband floor above 300 Hz (HB300)", "BEARING_VIBRATION_RMS", _fmt(HB, "mm/s", 3),
                          "0.10 to 0.24 mm/s is ambiguous; above 0.12 is watch", ("F01",), (), 0.5, "press 02 Table 29", finding=True))

    if f.get("DLcount") is not None:
        n = f["DLcount"]
        if n >= 4:
            T.append(Test("Defect lines at 3.55, 7.1, 10.65, 14.2 and 17.75 x 1X", "BEARING_VIBRATION_RMS",
                          f"{n} of 5 bins at 4 x healthy", "all five present means an outer-race defect",
                          ("F02", "F16"), ("F01", "F03", "F04", "F05", "F08", "F09", "F10", "F12", "F13"), 3.0, "press 02 Table 29", finding=True))
        elif n == 0:
            T.append(Test("Defect lines at 3.55, 7.1, 10.65, 14.2 and 17.75 x 1X", "BEARING_VIBRATION_RMS",
                          "0 of 5 bins at 4 x healthy", "absent unless the bearing is damaged",
                          (), ("F02", "F16"), 2.0, "press 02 Table 29"))
        else:
            T.append(Test("Defect lines at 3.55, 7.1, 10.65, 14.2 and 17.75 x 1X", "BEARING_VIBRATION_RMS",
                          f"{n} of 5 bins at 4 x healthy", "some lines only is ambiguous", ("F02",), (), 0.5, "press 02 Table 29", finding=True))

    if PMR is not None:
        if PMR > B["PMR300_peaked_min"]:
            T.append(Test("Peak-to-median ratio above 300 Hz (PMR300)", "BEARING_VIBRATION_RMS", _fmt(PMR, "", 1),
                          "above 3 is a peaked spectrum (bearing family)", ("F02", "F16", "F11"), ("F01",), 1.5, "press 02 Table 29", finding=True))
        elif PMR < B["PMR300_flat_max"]:
            T.append(Test("Peak-to-median ratio above 300 Hz (PMR300)", "BEARING_VIBRATION_RMS", _fmt(PMR, "", 1),
                          "below 2.5 is a flat floor", ("F01", "F03", "F04"), ("F02", "F16"), 1.0, "press 02 Table 29"))

    if V60 is not None:
        if V60 > 4.0:
            T.append(Test("Vibration above the 4.0 mm/s alarm", "BEARING_VIBRATION_RMS", _fmt(V60, "mm/s"),
                          "bearing wear never exceeds 4.0 mm/s; a clog does", ("F01", "F16"), ("F02",), 2.0, "press 02 Table 29", finding=True))
        dV = f.get("dV60")
        if dV is not None and dV >= 0.3:
            T.append(Test("Vibration rise against baseline", "BEARING_VIBRATION_RMS", f"+{_fmt(dV, 'mm/s')}",
                          "a rise means a mechanical or lubrication cause, not the pressure transducer",
                          ("F01", "F02", "F08", "F10", "F11", "F16"), ("F12", "F06"), 1.0, "press 02 Table 30", finding=True))
        elif dV is not None and abs(dV) < 0.2 and P60 is not None and P60 <= B["P60_clog_max"]:
            T.append(Test("Vibration rise against baseline", "BEARING_VIBRATION_RMS", _fmt(dV, "mm/s"),
                          "low pressure with normal vibration: verify the sensor first",
                          ("F12", "F06", "F04"), ("F01", "F02", "F16"), 2.0, "press 02 Table 31"))

    if f.get("dIdV") is not None:
        r = f["dIdV"]
        lo, hi = B["dIdV_ambiguous"]
        if r < lo:
            T.append(Test("Current rise per unit vibration rise (dI/dV)", "MAIN_MOTOR_CURRENT", _fmt(r, "A per mm/s", 1),
                          "about 0.8 A per mm/s for a clog, 4.8 for bearing wear", ("F01",), ("F02", "F08"), 1.5, "press 02 Table 29"))
        elif r > hi:
            T.append(Test("Current rise per unit vibration rise (dI/dV)", "MAIN_MOTOR_CURRENT", _fmt(r, "A per mm/s", 1),
                          "about 4.8 A per mm/s for bearing wear, 0.8 for a clog", ("F02", "F08"), ("F01",), 1.5, "press 02 Table 29"))

    ipk = f.get("Ipk")
    if ipk is not None:
        if ipk >= 175:
            T.append(Test("Stroke peak current (Ipk)", "MAIN_MOTOR_CURRENT", _fmt(ipk, "A", 1),
                          "175 A or more in the working stroke is overload", ("F09", "F08"), ("F01", "F02"), 1.5, "press 02 Table 31", finding=True))

    if f.get("RMSchk") is not None and f["RMSchk"] > 0.25:
        T.append(Test("RMS agrees with the spectrum", "BEARING_VIBRATION_RMS", f"{_fmt(100 * f['RMSchk'], '%', 0)} apart",
                      "RMS equals the spectrum energy unless the sensor is faulty", ("F13",), (), 1.0, "press 02 Table 30", finding=True))

    if f.get("r_clog_P") is not None and f.get("r_clog_V") is not None and (f["r_clog_P"] > 0.1 or f["r_clog_V"] > 0.1):
        gap = abs(f["r_clog_P"] - f["r_clog_V"])
        ok = gap <= 0.15
        T.append(Test("Clog severity from pressure and from vibration agree", None,
                      f"r {_fmt(f['r_clog_P'])} and {_fmt(f['r_clog_V'])}", "within 0.15 of each other for a clog",
                      ("F01",) if ok else (), () if ok else ("F01",), 1.0, "press 03 Table 2"))

    flat = f.get("flat") or {}
    for key, fault in (("LUBE_OIL_PRESSURE", "F12"), ("BEARING_VIBRATION_RMS", "F13"), ("MAIN_MOTOR_CURRENT", "F14")):
        if flat.get(key):
            T.append(Test("Channel is flat", key, "no variation for 60 s", "a live channel always varies",
                          (fault,), ("F01", "F02"), 3.0, "press 02 Table 31", finding=True))
    for key in stale or []:
        T.append(Test("Data age", key, "stale", "a fresh sample every 0.5 s", ("F15",), (), 3.0, "press 02 Table 31", finding=True))
    return T


def robot_tests(f: dict, stale: list[str] | None = None) -> list[Test]:
    R = K.ROBOT_RATIOS
    T: list[Test] = []
    if not f.get("cycles"):
        return [Test("Data age", key, "stale", "a fresh sample every 0.5 s", ("F12",), (), 3.0, "robot 02 Table 24", finding=True)
                for key in stale or []]
    dM, A6 = f.get("dM"), f.get("A6")

    if dM is not None:
        if dM >= 0.5:
            T.append(Test("Cycle mean shift (dM)", "AXIS_4_SERVO_TORQUE", f"+{_fmt(dM, 'Nm')}",
                          "a rise of 0.5 Nm or more is a baseline shift", ("F01", "F02", "F03", "F07"), ("F05", "F11"), 1.5, "robot 02 Table 25", finding=True))
        else:
            T.append(Test("Cycle mean shift (dM)", "AXIS_4_SERVO_TORQUE", _fmt(dM, "Nm"),
                          "within 0.5 Nm of 13.0 Nm is healthy", ("F05", "F06"), ("F01", "F02", "F03", "F07"), 1.0, "robot 01 Table 8"))

    if A6 is not None:
        if A6 > K.ROBOT_A6_PRESENT:
            T.append(Test("Sixth-harmonic ripple at 0.75 Hz (A6)", "AXIS_4_SERVO_TORQUE", _fmt(A6, "Nm"),
                          "above 0.4 Nm is gear-mesh damage; absent when healthy", ("F01",),
                          ("F02", "F03", "F06", "F07", "F08", "F09", "F10", "F11"), 3.0, "robot 02 Table 25", finding=True))
        elif A6 <= K.ROBOT_A6_HEALTHY_MAX and dM is not None and dM >= 2:
            T.append(Test("Sixth-harmonic ripple at 0.75 Hz (A6)", "AXIS_4_SERVO_TORQUE", _fmt(A6, "Nm"),
                          "a mean rise without ripple is friction or load, not the gear mesh",
                          ("F02", "F03", "F07", "F09"), ("F01",), 2.0, "robot 02 Table 24"))

    if f.get("A6_per_dM") is not None:
        lo, hi = R["A6_per_dM"]
        x = f["A6_per_dM"]
        ok = lo <= x <= hi
        T.append(Test("Ripple per unit mean shift (A6/dM)", "AXIS_4_SERVO_TORQUE", _fmt(x, "", 3),
                      "0.20 to 0.40 for gearbox wear (0.286 expected)", ("F01",) if ok else ("F02", "F03", "F07") if x < 0.1 else (),
                      () if ok else ("F01",), 2.0, "robot 02 Table 4"))
    if f.get("noise_per_dM") is not None:
        lo, hi = R["noise_per_dM"]
        x = f["noise_per_dM"]
        sup = ("F01",) if lo <= x <= hi else ("F04", "F05", "F11") if x > 0.3 else ("F02", "F03", "F07", "F10") if x < 0.03 else ()
        T.append(Test("Noise growth per unit mean shift", "AXIS_4_SERVO_TORQUE", _fmt(x, "per Nm", 3),
                      "0.08 to 0.20 for gearbox wear (0.143 expected)", sup, () if "F01" in sup else ("F01",), 1.5, "robot 02 Table 4"))
    if f.get("tcp_per_dM") is not None:
        lo, hi = R["tcp_per_dM"]
        x = f["tcp_per_dM"]
        sup = ("F01",) if lo <= x <= hi else ("F05",) if x > 0.12 else ("F02", "F03", "F09") if x < 0.01 else ()
        T.append(Test("TCP shift per unit mean shift", "TOOL_CENTER_POINT_DEVIATION", _fmt(x, "mm per Nm", 4),
                      "0.03 to 0.08 mm per Nm for gearbox wear", sup, () if "F01" in sup else ("F01",), 1.5, "robot 02 Table 4"))

    if f.get("dSw") is not None:
        x = f["dSw"]
        if abs(x) <= R["swing_tol"]:
            T.append(Test("Cycle swing change (dSw)", "AXIS_4_SERVO_TORQUE", _fmt(x, "Nm"),
                          "within 0.5 Nm for wear; a change means load or program", (), ("F07", "F10"), 1.0, "robot 02 Table 4"))
        elif abs(x) > 1.0:
            T.append(Test("Cycle swing change (dSw)", "AXIS_4_SERVO_TORQUE", _fmt(x, "Nm"),
                          "a swing change means load or program, not wear", ("F07", "F10"), ("F01", "F02"), 1.5, "robot 02 Table 25", finding=True))

    gun = f.get("gun")
    if gun is not None:
        lo, hi = K.ROBOT_GUN_BAND
        if lo <= gun <= hi:
            T.append(Test("Weld gun temperature", "WELD_GUN_TEMP", _fmt(gun, "degC", 1),
                          "37 to 58 degC; a change points to a thermal or process cause", (), ("F09",), 0.5, "robot 02 Table 4"))
        else:
            T.append(Test("Weld gun temperature", "WELD_GUN_TEMP", _fmt(gun, "degC", 1),
                          "outside 37 to 58 degC is thermal or process", ("F09", "F10"), ("F01",), 1.0, "robot 02 Table 25", finding=True))

    if f.get("step") is not None and f["step"] > K.ROBOT_STEP_CONTEXT:
        T.append(Test("Largest sample-to-sample step", "AXIS_4_SERVO_TORQUE", _fmt(f["step"], "Nm", 1),
                      "steps above 8 Nm need context (collision, backlash, sensor)", ("F05", "F07", "F11"), (), 1.0, "robot 01 Table 8", finding=True))
    if f.get("flat"):
        T.append(Test("Channel is flat", "AXIS_4_SERVO_TORQUE", "no cycle pattern", "the torque follows the 8 s cycle",
                      ("F11",), ("F01", "F02"), 3.0, "robot 02 Table 24", finding=True))
    for key in stale or []:
        T.append(Test("Data age", key, "stale", "a fresh sample every 0.5 s", ("F12",), (), 3.0, "robot 02 Table 24", finding=True))
    return T


# --- scoring -----------------------------------------------------------------

def score(machine_type: str, tests: list[Test]) -> list[Hypothesis]:
    faults = K.faults_for(machine_type)
    total = sum(t.weight for t in tests) or 1.0
    hyps = []
    for fid, fault in faults.items():
        sup = sum(t.weight for t in tests if fid in t.supports)
        con = sum(t.weight for t in tests if fid in t.contradicts)
        if not any(t.finding and fid in t.supports for t in tests):
            continue                                    # nothing abnormal points to it
        prior = 0.5 if fault.modelled else 0.0
        hyps.append(Hypothesis(fid, fault.name, fault.code, fault.component, round(sup - con + prior, 3), sup, con))
    hyps.sort(key=lambda h: (-h.score, -h.support, h.id))
    best = hyps[0].score if hyps else 0
    for i, h in enumerate(hyps):
        net = (h.support - h.against) / total                 # -1 .. 1
        runner = hyps[1].score if i == 0 and len(hyps) > 1 else best
        sep = (h.score - runner) / total if i == 0 else (h.score - best) / total
        conf = 0.3 + 0.45 * net + 0.25 * max(-1.0, min(1.0, sep * 2))
        h.confidence = round(max(0.05, min(0.95, conf)), 2)
    return hyps


def diagnose(machine_id: str, features: dict, stale: list[str] | None = None, *,
             machine_type: str, label: str | None = None) -> Diagnosis:
    """Score one machine. The type (from the catalogue) picks the fault library."""
    if machine_type == "press":
        level, reasons = press_level(features)
        tests = press_tests(features, stale)
    elif machine_type == "robot":
        level, reasons = robot_level(features)
        tests = robot_tests(features, stale)
    else:
        return Diagnosis(machine_id, "normal", [], features, [], [], machine_type=machine_type, label=label,
                         notes=[f"No fault library for machine type {machine_type!r}."])
    ranked = score(machine_type, tests)
    d = Diagnosis(machine_id, level, reasons, features, tests, ranked, healthy=level == "normal" and not ranked,
                  machine_type=machine_type, label=label)
    if not ranked:
        d.notes.append("No documented signature is supported by the current data.")
    return d
