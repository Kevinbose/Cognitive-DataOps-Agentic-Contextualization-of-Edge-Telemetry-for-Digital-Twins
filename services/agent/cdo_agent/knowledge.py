"""What the knowledge base says, as constants the diagnosis can compute with.

Every number here is copied from the machine documents in RAG/ and carries the
table it came from, so a reviewer can check it. The documents mark each value
[P] project fact, [D] derived from the model equations, [E] engineering
reference or [I] proposal; only the faults marked [P] are modelled by the
simulator, which is why they carry a small prior in the scoring.
"""
from __future__ import annotations

from dataclasses import dataclass, field

PRESS = "press-stamp-01"
ROBOT = "robot-weld-01"

# --- press, healthy reference (press 03 Table 2, press 01 section 5) ---------
PRESS_P_HEALTHY = 4.50          # bar, P60
PRESS_V_HEALTHY = 1.31          # mm/s, V60
PRESS_I_HEALTHY = 94.8          # A, I60
PRESS_HB300_HEALTHY = 0.030     # mm/s
PRESS_STROKE_SEC = 4.6
PRESS_HIGH_BAND_FIRST_BIN = 24  # 300 Hz at 12.5 Hz per bin
PRESS_DEFECT_BINS = (7, 14, 21, 28, 35)   # 3.55, 7.1, 10.65, 14.2, 17.75 x 1X
# Healthy amplitude of the defect bins: bin 7 sits in the stroke-impact band
# (62.5 to 150 Hz, about 0.14 mm/s on average), the rest on the 0.03 floor.
PRESS_DEFECT_BIN_HEALTHY = {7: 0.14, 14: 0.03, 21: 0.03, 28: 0.03, 35: 0.03}

# --- press, five-level master thresholds (press 01 Table "Master threshold") --
PRESS_LEVELS = {
    # channel feature: (direction, watch, warning, alarm, critical)
    "P60": (-1, 4.30, 3.6, 3.0, 2.5),
    "V60": (1, 1.50, 2.5, 4.0, 7.0),
    "Ipk": (1, None, 175.0, 195.0, 220.0),
    "HB300": (1, 0.12, None, None, None),
}

# --- press, differentiating bands (press 02 Table 29) ------------------------
PRESS_BANDS = {
    "P60_clog_max": 4.30, "P60_normal": (4.45, 4.55), "P60_high": 5.0,
    "PMR300_flat_max": 2.5, "PMR300_peaked_min": 3.0,
    "HB300_clog_min": 0.24, "HB300_quiet_max": 0.10,
    "dIdV_clog": 0.8, "dIdV_bearing": 4.8, "dIdV_ambiguous": (1.5, 3.5),
    "DL_factor": 4.0,
}

# --- robot, healthy reference (robot 01 section 4, robot 03 Table 2) ---------
ROBOT_CYCLE_SEC = 8.0
ROBOT_M_HEALTHY = 13.0          # Nm, cycle mean
ROBOT_SWING_HEALTHY = 7.0       # Nm, amplitude of the 1X cycle component
ROBOT_SIGMA_HEALTHY = 0.45      # Nm, same-phase noise
ROBOT_TCP_HEALTHY = 0.104       # mm
ROBOT_GUN_BAND = (37.0, 58.0)   # degC, healthy band (robot 02 Table 4)
ROBOT_FULL_SHIFT = 10.5         # Nm, dM at severity 1

# --- robot, gearbox-wear consistency ratios (robot 02 Table 4) ---------------
ROBOT_RATIOS = {
    "A6_per_dM": (0.20, 0.40),
    "noise_per_dM": (0.08, 0.20),
    "tcp_per_dM": (0.03, 0.08),
    "swing_tol": 0.5,
}

# --- robot, severity (robot 02 Table 27, robot 01 Table 8) -------------------
ROBOT_WARN_PEAK = 26.0
ROBOT_ALARM_PEAK = 30.0
ROBOT_CRITICAL_SAMPLE = 34.0
ROBOT_CRITICAL_MEAN = 23.5
ROBOT_WATCH_MEAN = 13.5
ROBOT_A6_PRESENT = 0.4
ROBOT_A6_HEALTHY_MAX = 0.2
ROBOT_STEP_CONTEXT = 8.0        # Nm per 0.5 s; above this a step needs context

LEVELS = ("normal", "watch", "warning", "alarm", "critical")


@dataclass(frozen=True)
class Fault:
    id: str
    name: str
    component: str
    modelled: bool
    tags: tuple[str, ...]
    actions: tuple[tuple[str, str | None], ...]
    verify: str
    code: str | None = None
    words: tuple[str, ...] = field(default_factory=tuple)

    @property
    def label(self) -> str:
        return f"{self.id} {self.code}" if self.code else self.id


# Fault library and fault-to-action matrix: press 02 Table 2, press 04 Table 20.
PRESS_FAULTS: dict[str, Fault] = {f.id: f for f in (
    Fault("F01", "Clogged lube oil filter", "Lube filter, lubrication unit", True,
          ("lube_filter", "lube_unit"),
          (("Replace the lube filter cartridge (task T1). It takes minutes.", None),
           ("Investigate oil cleanliness so the new cartridge does not clog again.", "Planned action")),
          "P60 back to 4.5 bar and V60 to 1.3 mm/s", code="CLOGGED_FILTER",
          words=("lube filter", "lubrication unit")),
    Fault("F02", "Main bearing outer-race defect", "Main bearing housing", True,
          ("main_bearing_housing", "vibration_sensor"),
          (("Do not run to alarm. Confirm with a handheld analyser at the bearing housing (task T2).", None),
           ("Inspect at the next planned stop and plan the bearing replacement.", "Bearing wear never reaches the 4.0 mm/s alarm, so a threshold will not warn you")),
          "Defect lines absent and V60 back to 1.3 mm/s", code="BEARING_WEAR",
          words=("main bearing",)),
    Fault("F03", "Lube pump wear or failure", "Gear pump", False, ("lube_pump",),
          (("Controlled stop if P is at or below 3.0 bar; repair or replace the pump.", None),),
          "Ripple and pressure restored", words=("lube pump",)),
    Fault("F04", "Oil leak or low reservoir level", "Reservoir and lines", False, ("lube_unit", "lube_lines"),
          (("Refill the reservoir and find the leak, then repair it.", None),),
          "Pressure stable", words=("lubrication unit", "lube piping")),
    Fault("F05", "Blocked nozzle or line after the transducer", "Distribution line, nozzle", False, ("lube_lines",),
          (("Clear the blocked line or nozzle; reduce load if needed.", None),),
          "P back to 4.5 bar", words=("lube piping",)),
    Fault("F06", "Relief valve stuck or setpoint drift", "Relief valve", False, ("lube_unit",),
          (("Check the relief valve setting and service the valve.", None),),
          "Pressure restored", words=("lubrication unit",)),
    Fault("F07", "Oil temperature or viscosity effect", "Oil", False, ("lube_unit",),
          (("Check the oil temperature and grade before any repair.", None),),
          "Pressure follows temperature back to normal", words=("lubrication unit",)),
    Fault("F08", "Main drive motor or supply fault", "Main drive motor", False, ("main_motor",),
          (("Stop if the motor trips or overheats; test and repair the motor and supply.", None),),
          "I60 back to 94.8 A", words=("main motor",)),
    Fault("F09", "Process or die overload", "Press and die", False, ("die", "slide"),
          (("Correct the die setup and review the material.", None),),
          "Stroke peak current about 150 A", words=("die",)),
    Fault("F10", "Imbalance or misalignment", "Shaft, coupling", False, ("flywheel", "main_motor"),
          (("Re-check fasteners, then align and balance.", None),),
          "1X back to about 1.05 mm/s", words=("flywheel",)),
    Fault("F11", "Mechanical looseness", "Bearing housing, foundation", False, ("main_bearing_housing", "foundation"),
          (("Re-check the bearing housing fasteners and the foundation.", None),),
          "Harmonics of 1X gone", words=("main bearing",)),
    Fault("F12", "Pressure transducer fault", "LUBE_OIL_PRESSURE sensor", False, ("lube_pressure", "lube_filter"),
          (("Verify the pressure transducer against a reference gauge (task T4) before any mechanical work.", None),),
          "Transducer agrees with the reference", words=("lube gauge",)),
    Fault("F13", "Vibration sensor or mounting fault", "BEARING_VIBRATION_RMS sensor", False, ("vibration_sensor",),
          (("Check the vibration sensor and its mounting (task T5).", None),),
          "RMS and spectrum agree", words=("bearing sensor",)),
    Fault("F14", "Current sensor fault", "MAIN_MOTOR_CURRENT sensor", False, ("main_motor",),
          (("Verify the current sensor against a reference instrument.", None),),
          "Signals agree", words=("main motor",)),
    Fault("F15", "Data-path or gateway fault", "ESP32 gateway, broker, backend", False, (),
          (("Restore the link: check the gateway, the broker and the clock.", None),),
          "No gaps in the stream"),
    Fault("F16", "Combined clog and bearing wear", "Lube filter and main bearing", False,
          ("lube_filter", "main_bearing_housing"),
          (("Replace the lube filter first.", None),
           ("Then inspect the main bearing and plan its replacement.", None)),
          "Both signatures gone", words=("lube filter", "main bearing")),
)}

# Fault classification and action matrix: robot 02 Table 2, robot 04 Table 15.
ROBOT_FAULTS: dict[str, Fault] = {f.id: f for f in (
    Fault("F01", "Gearbox wear (damaged gear mesh)", "Axis 4 gearbox", True, ("axis_4_motor", "axis_4"),
          (("Inspect the axis 4 gearbox at the next stop and plan replacement of the gear set or gearbox.", "Specialist work, several hours to a shift"),
           ("After the repair, replace lubricant and seals, re-master and re-baseline.", None)),
          "Cycle mean back to 13 Nm, A6 below 0.2 Nm", code="GEARBOX_WEAR",
          words=("axis 4 servo motor", "axis 4")),
    Fault("F02", "Lubrication degradation or loss", "Axis 4 gearbox lubricant", False, ("axis_4",),
          (("Relubricate or replace the lubricant; replace seals and clean the breather.", None),),
          "Mean and noise back to baseline", words=("axis 4",)),
    Fault("F03", "Brake drag", "Axis 4 motor brake", False, ("axis_4_motor",),
          (("Repair or replace the holding brake and verify release timing.", None),),
          "Idle torque back to baseline", words=("axis 4 servo motor",)),
    Fault("F04", "Bearing degradation", "Axis 4 bearings", False, ("axis_4",),
          (("Replace the bearings, relubricate and check the shaft.", None),),
          "Noise back to baseline", words=("axis 4",)),
    Fault("F05", "Backlash growth or mechanical looseness", "Gearbox-to-arm interface", False, ("axis_4", "flange"),
          (("Retorque the fasteners and measure backlash; replace the coupling if needed.", None),),
          "No reversal spikes", words=("axis 4", "flange")),
    Fault("F06", "External drag from the dress pack", "Cable dress pack, seals", False, ("dress_pack",),
          (("Re-dress and clean the cable dress pack; replace guides.", None),),
          "No phase-locked bump", words=("dress pack",)),
    Fault("F07", "Overload, payload increase or collision", "Forearm, tool, gun", False, ("weld_gun", "flange"),
          (("Inspect for damage, repair and re-master; check the tool data.", None),),
          "Mean and swing back to baseline", words=("weld gun",)),
    Fault("F08", "Drive or current-measurement fault", "Axis 4 servo drive", False, ("axis_4_motor", "controller"),
          (("Replace the sensor or drive module and recalibrate.", None),),
          "No offset at idle", words=("axis 4 servo motor",)),
    Fault("F09", "Thermal effect", "Motor winding, gearbox oil", False, ("axis_4_motor",),
          (("Restore cooling, reduce duty and allow warm-up.", None),),
          "Drift reverses with temperature", words=("axis 4 servo motor",)),
    Fault("F10", "Program, speed or tuning change", "Controller, program", False, ("controller",),
          (("Re-baseline after the program change and update the tool data.", None),),
          "Shape stable on the new program", words=("controller",)),
    Fault("F11", "Sensor signal fault", "Torque estimate path", False, ("axis_4_motor",),
          (("Fix the signal path and restart the gateway.", None),),
          "Signal varies with the cycle again", words=("axis 4 servo motor",)),
    Fault("F12", "Data-path fault", "ESP32 gateway, broker, backend", False, (),
          (("Fix the network, clock or identity and restart the gateway.", None),),
          "No gaps or duplicates"),
)}

# Fault knowledge belongs to a machine TYPE (the catalogue's `machineType`), so a
# second press added to the plant is diagnosed with the same library. The
# manuals in RAG/ were written for one reference machine of each type; that
# machine's documents are searched for any machine of the type.
FAULTS_BY_TYPE = {"press": PRESS_FAULTS, "robot": ROBOT_FAULTS}
REFERENCE_MACHINE = {"press": PRESS, "robot": ROBOT}

# Words that point a question at a machine type when it names no machine.
TYPE_WORDS = {
    "press": ("press", "stamp", "stamping", "lube", "lubrication", "bearing", "filter", "die", "flywheel"),
    "robot": ("robot", "weld", "welding", "axis", "torque", "gun", "tcp", "gearbox", "wrist"),
}


def faults_for(machine_type: str | None) -> dict[str, Fault]:
    return FAULTS_BY_TYPE.get(machine_type or "", {})


def type_from_words(text: str) -> str | None:
    """The machine type a sentence is about, or None when it is unclear."""
    t = text.lower()
    hits = {kind: sum(1 for w in words if w in t) for kind, words in TYPE_WORDS.items()}
    best = max(hits.items(), key=lambda kv: kv[1])
    return best[0] if best[1] and list(hits.values()).count(best[1]) == 1 else None
