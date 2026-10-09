"""Features and signature scoring against windows produced by the simulator's own models."""
from __future__ import annotations

import pytest

from cdo_agent.diagnosis import diagnose
from cdo_agent.features import press_features, robot_features

from .conftest import WINDOWS

PRESS = "press-stamp-01"
ROBOT = "robot-weld-01"


def press(name: str) -> dict:
    w = WINDOWS[PRESS][name]
    return press_features(w["channels"], w["spectra"])


def robot(name: str) -> dict:
    return robot_features(WINDOWS[ROBOT][name]["channels"])


def test_press_features_match_the_documented_values():
    healthy = press("NORMAL")
    assert healthy["P60"] == pytest.approx(4.50, abs=0.03)
    assert healthy["V60"] == pytest.approx(1.31, abs=0.05)
    assert healthy["I60"] == pytest.approx(94.8, abs=1.0)
    assert healthy["HB300"] == pytest.approx(0.030, abs=0.005)
    assert healthy["DLcount"] == 0

    clog = press("CLOGGED_FILTER_100")           # press 02: P about 2.47 bar, V about 4.98, HB300 0.749
    assert clog["P60"] == pytest.approx(2.47, abs=0.05)
    assert clog["V60"] == pytest.approx(4.98, abs=0.15)
    assert clog["HB300"] == pytest.approx(0.749, abs=0.05)
    assert clog["PMR300"] < 2.5
    assert clog["DLcount"] == 0, "a broadband floor is not a line family"
    assert clog["dIdV"] == pytest.approx(0.8, abs=0.4)

    wear = press("BEARING_WEAR_100")             # press 02: V about 2.9, discrete lines, P normal
    assert wear["P60"] == pytest.approx(4.50, abs=0.03)
    assert wear["V60"] == pytest.approx(2.89, abs=0.1)
    assert wear["DLcount"] == 5
    assert wear["PMR300"] > 3
    assert wear["dIdV"] == pytest.approx(4.8, abs=0.8)


def test_robot_features_match_the_documented_values():
    healthy = robot("NORMAL")
    assert healthy["M"] == pytest.approx(13.0, abs=0.2)
    assert healthy["A6"] < 0.2
    assert healthy["swing"] == pytest.approx(7.0, abs=0.3)
    assert healthy["kN"] == pytest.approx(1.0, abs=0.3)

    worn = robot("GEARBOX_WEAR_100")             # robot 02 Table 3 at r = 1
    assert worn["dM"] == pytest.approx(10.5, abs=0.3)
    assert worn["A6"] == pytest.approx(3.0, abs=0.5)
    assert worn["swing"] == pytest.approx(7.0, abs=0.4), "gear wear leaves the 1X swing unchanged"
    assert worn["dTCP"] == pytest.approx(0.55, abs=0.05)
    assert 0.20 <= worn["A6_per_dM"] <= 0.40
    assert 0.08 <= worn["noise_per_dM"] <= 0.20
    assert 0.03 <= worn["tcp_per_dM"] <= 0.08


@pytest.mark.parametrize("name, root, level", [
    ("CLOGGED_FILTER_30", "F01", "watch"),
    ("CLOGGED_FILTER_60", "F01", "warning"),
    ("CLOGGED_FILTER_100", "F01", "critical"),
    ("BEARING_WEAR_30", "F02", "watch"),
    ("BEARING_WEAR_60", "F02", "watch"),
    ("BEARING_WEAR_100", "F02", "warning"),
])
def test_press_faults_are_told_apart(name, root, level):
    d = diagnose(PRESS, press(name), machine_type="press")
    assert d.root.id == root
    assert d.root.confidence >= 0.8
    assert d.level == level
    assert d.ranked[1].confidence < 0.5, "the runner-up is clearly behind"


@pytest.mark.parametrize("name, level", [
    ("GEARBOX_WEAR_30", "warning"), ("GEARBOX_WEAR_60", "warning"), ("GEARBOX_WEAR_100", "alarm"), ("GEARBOX_WEAR_RAMP", "warning"),
])
def test_robot_gearbox_wear_is_recognised_by_its_ratios(name, level):
    d = diagnose(ROBOT, robot(name), machine_type="robot")
    assert d.root.id == "F01" and d.root.code == "GEARBOX_WEAR"
    assert d.root.confidence >= 0.8
    assert d.level == level
    verdicts = {t.test: t.verdict_for("F01") for t in d.tests}
    assert verdicts["Ripple per unit mean shift (A6/dM)"] == "supports"
    assert verdicts["TCP shift per unit mean shift"] == "supports"


def test_healthy_machines_have_no_root_cause():
    for mid, f in ((PRESS, press("NORMAL")), (ROBOT, robot("NORMAL"))):
        d = diagnose(mid, f, machine_type="press" if mid == PRESS else "robot")
        assert d.healthy and d.root is None and d.level == "normal"


def test_a_flat_pressure_channel_points_to_the_transducer_not_the_filter():
    w = WINDOWS[PRESS]["NORMAL"]
    channels = dict(w["channels"])
    channels["LUBE_OIL_PRESSURE"] = [[t, 3.2] for t, _ in channels["LUBE_OIL_PRESSURE"]]
    d = diagnose(PRESS, press_features(channels, w["spectra"]), machine_type="press")
    assert d.root.id == "F12"
    assert all(h.id != "F01" for h in d.ranked[:1])


def test_stale_data_is_a_data_path_finding():
    d = diagnose(PRESS, press("NORMAL"), stale=["LUBE_OIL_PRESSURE"], machine_type="press")
    assert d.root.id == "F15"
