"""Features exactly as the diagnostic procedures define them (press 03 Table 2, robot 03 Table 2).

Inputs are raw samples, `(t_ms, value)` pairs at the 2 Hz publication rate, and
spectrum frames. Every function returns plain floats (or None when the window
is too short), so the result can be logged, tested and shown in a report.
"""
from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

from . import knowledge as K

Samples = Sequence[tuple[float, float]]


def _arrays(samples: Samples | None) -> tuple[np.ndarray, np.ndarray]:
    if not samples:
        return np.zeros(0), np.zeros(0)
    a = np.asarray(samples, dtype=float)
    order = np.argsort(a[:, 0], kind="stable")
    return a[order, 0], a[order, 1]


def _window(samples: Samples | None, seconds: float) -> np.ndarray:
    t, v = _arrays(samples)
    if not len(t):
        return v
    return v[t > t[-1] - seconds * 1000]


def _mean(x: np.ndarray) -> float | None:
    return float(np.mean(x)) if len(x) else None


def _r(x: float | None, d: int = 3) -> float | None:
    return None if x is None or not math.isfinite(x) else round(float(x), d)


def _flat(x: np.ndarray, tol: float) -> bool:
    return len(x) >= 20 and float(np.std(x)) < tol


# --- press -------------------------------------------------------------------

def _local_floor(amp: np.ndarray, b: int, half: int = 4) -> float:
    lo, hi = max(0, b - half), min(len(amp), b + half + 1)
    around = [float(amp[i]) for i in range(lo, hi) if i != b]
    return float(np.median(around)) if around else 0.0


def press_features(channels: dict[str, Samples], spectra: Sequence[Sequence[float]] | None = None,
                   baselines: dict[str, dict] | None = None) -> dict:
    """V10, V60, P10, P60, I60, Ipk, PF60, HB300, PMR300, DL, RMSchk, dI/dV and the r estimates."""
    baselines = baselines or {}
    p = channels.get("LUBE_OIL_PRESSURE")
    v = channels.get("BEARING_VIBRATION_RMS")
    i = channels.get("MAIN_MOTOR_CURRENT")
    p10, p60 = _window(p, 10), _window(p, 60)
    v10, v60 = _window(v, 10), _window(v, 60)
    i60 = _window(i, 60)

    f: dict = {
        "P10": _r(_mean(p10)), "P60": _r(_mean(p60)),
        "V10": _r(_mean(v10)), "V60": _r(_mean(v60)),
        "I60": _r(_mean(i60), 2),
        "samples60": int(min(len(p60), len(v60), len(i60))) if p and v and i else 0,
    }

    # Ipk: the maximum of each 4.6 s stroke, averaged over the last three strokes
    ti, vi = _arrays(i)
    if len(ti):
        strokes = []
        end = ti[-1]
        for k in range(3):
            hi, lo = end - k * K.PRESS_STROKE_SEC * 1000, end - (k + 1) * K.PRESS_STROKE_SEC * 1000
            seg = vi[(ti > lo) & (ti <= hi)]
            if len(seg):
                strokes.append(float(seg.max()))
        f["Ipk"] = _r(float(np.mean(strokes)), 1) if strokes else None
    else:
        f["Ipk"] = None

    f["PF60"] = _r(float(np.mean(v60 >= 2.5))) if len(v60) else None

    # spectrum: average the frames, then read the high band and the defect bins
    f.update({"HB300": None, "PMR300": None, "DL": None, "DLcount": None, "RMSspec": None, "RMSchk": None})
    frames = [np.asarray(s, dtype=float) for s in (spectra or []) if s is not None and len(s) >= 40]
    if frames:
        amp = np.mean(np.vstack(frames), axis=0)
        high = amp[K.PRESS_HIGH_BAND_FIRST_BIN:]
        f["HB300"] = _r(float(np.mean(high)), 4)
        med = float(np.median(high))
        f["PMR300"] = _r(float(np.max(high)) / med, 2) if med > 0 else None
        dl = {b: float(amp[b]) / K.PRESS_DEFECT_BIN_HEALTHY[b] for b in K.PRESS_DEFECT_BINS if b < len(amp)}
        f["DL"] = {str(b): _r(x, 2) for b, x in dl.items()}
        # a line is 4 x its healthy level AND stands above its own neighbourhood, so a
        # broadband floor (lubrication starvation) does not count as a line family
        f["DLcount"] = sum(1 for b, x in dl.items()
                           if x >= K.PRESS_BANDS["DL_factor"] and amp[b] >= 2 * _local_floor(amp, b))
        rms_spec = float(np.sqrt(np.mean([np.sum(fr ** 2) for fr in frames])))
        f["RMSspec"] = _r(rms_spec)
        if f["V10"]:
            f["RMSchk"] = _r(abs(f["V10"] - rms_spec) / f["V10"])

    # change against the learned baseline, or the documented healthy value
    v_base = (baselines.get("BEARING_VIBRATION_RMS") or {}).get("mean") or K.PRESS_V_HEALTHY
    i_base = (baselines.get("MAIN_MOTOR_CURRENT") or {}).get("mean") or K.PRESS_I_HEALTHY
    p_base = (baselines.get("LUBE_OIL_PRESSURE") or {}).get("mean") or K.PRESS_P_HEALTHY
    f["base"] = {"P": _r(p_base), "V": _r(v_base), "I": _r(i_base, 2)}
    dV = (f["V60"] - v_base) if f["V60"] is not None else None
    dI = (f["I60"] - i_base) if f["I60"] is not None else None
    f["dV60"] = _r(dV)
    f["dI60"] = _r(dI, 2)
    f["dI_pct"] = _r(100 * dI / i_base, 1) if dI is not None and i_base else None
    f["dIdV"] = _r(dI / dV, 2) if dV is not None and dI is not None and dV >= 0.25 else None

    # severity estimates, one per signature (press 03 Table 2)
    if f["P60"] is not None:
        f["r_clog_P"] = _r((K.PRESS_P_HEALTHY - f["P60"]) / 2.03)
    if f["V60"] is not None:
        f["r_clog_V"] = _r((f["V60"] - K.PRESS_V_HEALTHY) / 3.68)
        f["r_bear_V"] = _r((f["V60"] - K.PRESS_V_HEALTHY) / 1.58)
    if f["I60"] is not None:
        f["r_bear_I"] = _r((f["I60"] - K.PRESS_I_HEALTHY) / 7.6)

    f["flat"] = {
        "LUBE_OIL_PRESSURE": _flat(p60, 0.005),
        "BEARING_VIBRATION_RMS": _flat(v60, 0.005),
        "MAIN_MOTOR_CURRENT": _flat(i60, 0.05),
    }
    return f


# --- robot -------------------------------------------------------------------

def robot_features(channels: dict[str, Samples], baselines: dict[str, dict] | None = None,
                   cycles: int = 5) -> dict:
    """M, S, dM, Pbar, Minbar, swing (1X amplitude), A6, sigma, kN, dTCP, step and the consistency ratios."""
    baselines = baselines or {}
    t, x = _arrays(channels.get("AXIS_4_SERVO_TORQUE"))
    f: dict = {"cycles": 0}
    if len(t) < 32:
        return f
    period = K.ROBOT_CYCLE_SEC * 1000
    keep = t > t[-1] - cycles * period
    t, x = t[keep], x[keep]
    t0 = t[0]
    phase = ((t - t0) % period) / period
    M = float(np.mean(x))
    base = (baselines.get("AXIS_4_SERVO_TORQUE") or {}).get("mean")
    m0 = base if base and abs(base - K.ROBOT_M_HEALTHY) < 1.0 else K.ROBOT_M_HEALTHY
    dM = M - m0

    k = ((t - t0) // period).astype(int)
    peaks, mins = [], []
    for c in np.unique(k):
        seg = x[k == c]
        if len(seg) >= 12:            # a complete cycle holds 16 samples
            peaks.append(float(seg.max()))
            mins.append(float(seg.min()))
    pbar = float(np.mean(peaks)) if peaks else None
    minbar = float(np.mean(mins)) if mins else None

    resid = x - M

    def harmonic(n: int) -> float:
        w = 2 * math.pi * n * phase
        return 2 * math.hypot(float(np.mean(resid * np.cos(w))), float(np.mean(resid * np.sin(w))))

    a6 = harmonic(6)
    swing = harmonic(1)          # the documents' "swing": the 1X cycle amplitude, 7.0 Nm healthy

    # same-phase cycle-to-cycle noise: samples one period apart
    diffs = []
    j = 0
    for idx in range(len(t)):
        target = t[idx] + period
        while j < len(t) and t[j] < target - 250:
            j += 1
        if j < len(t) and abs(t[j] - target) <= 250:
            diffs.append(x[j] - x[idx])
    sigma = float(np.std(diffs)) / math.sqrt(2) if len(diffs) >= 16 else None
    kN = sigma / K.ROBOT_SIGMA_HEALTHY if sigma is not None else None

    _, tcp = _arrays(channels.get("TOOL_CENTER_POINT_DEVIATION"))
    _, gun = _arrays(channels.get("WELD_GUN_TEMP"))
    dT = float(np.mean(tcp[-len(x):])) - K.ROBOT_TCP_HEALTHY if len(tcp) else None
    step = float(np.max(np.abs(np.diff(x)))) if len(x) > 1 else None

    f.update({
        "cycles": len(peaks),
        "M": _r(M, 2), "S": _r((M - K.ROBOT_M_HEALTHY) / K.ROBOT_FULL_SHIFT), "dM": _r(dM, 2),
        "Pbar": _r(pbar, 2), "Minbar": _r(minbar, 2), "swing": _r(swing, 2),
        "dSw": _r(swing - K.ROBOT_SWING_HEALTHY, 2),
        "peaksOver26": sum(1 for pk in peaks if pk >= K.ROBOT_WARN_PEAK),
        "peaksOver30": sum(1 for pk in peaks if pk >= K.ROBOT_ALARM_PEAK),
        "maxSample": _r(float(np.max(x)), 2),
        "A6": _r(a6), "sigma": _r(sigma), "kN": _r(kN, 2),
        "TCP": _r(float(np.mean(tcp[-len(x):])), 3) if len(tcp) else None,
        "dTCP": _r(dT), "step": _r(step, 2),
        "gun": _r(float(np.mean(gun[-len(x):])), 1) if len(gun) else None,
        "gunMax": _r(float(np.max(gun[-len(x):])), 1) if len(gun) else None,
        "flat": _flat(x, 0.05),
    })
    if dM >= 2:
        f["A6_per_dM"] = _r(a6 / dM)
        f["noise_per_dM"] = _r((kN - 1) / dM) if kN is not None else None
        f["tcp_per_dM"] = _r(dT / dM, 4) if dT is not None else None
    return f
