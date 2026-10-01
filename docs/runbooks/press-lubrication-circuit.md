---
document: Press lubrication circuit and filter
machine: press-stamp-01
component_tags: [lube_filter, lubrication_unit]
evidence_channels: [PRESS-STAMP-01.LUBE_OIL_PRESSURE, PRESS-STAMP-01.BEARING_VIBRATION_RMS]
status: stub. Original text for the prototype. Values are illustrative and match the simulator, not a vendor.
---

# Press lubrication circuit and filter

This is an original training runbook for the simulated stamping press. It is not an OEM manual, and the numbers are illustrative constants chosen for the demo. The diagnosis agent retrieves sections of it and cites them by document and section.

## 1. Scope

The pressure lubrication circuit of the press main drive: what it does, how its pressure reading behaves, what a clogged filter looks like in the data, and what to do about it.

## 2. Circuit description

A gear pump draws oil from the reservoir and pushes it through the **lube filter** to the main bearings. The pressure transducer is fitted **downstream of the filter**, in the distribution line that feeds the bearings.

That position decides how to read it. A blocked filter restricts the flow that reaches the transducer's line, so the pressure it reads **falls**. It does not rise. A rising reading would point to a blocked nozzle or line after the transducer, which is a different fault.

Normal operation:

| Quantity | Value |
|---|---|
| Lube oil pressure | about 4.5 bar |
| Gear-pump pulsation | about 0.12 bar at roughly 1 Hz |
| Warning (low) | 3.6 bar |
| Alarm (low) | 3.0 bar |

## 3. What a clogged filter looks like

A clogging filter develops gradually, over minutes to days depending on oil cleanliness. In the data it shows as:

- **Lube oil pressure falls** steadily. In the simulator the reading drops by up to 45 percent at full severity, crossing the warning level at about 44 percent of the ramp and the alarm level at about 74 percent.
- **Bearing vibration rises**, because a starved bearing loses its lubricant film.
- The vibration spectrum gains a **broadband noise floor above about 300 Hz**, with **no discrete family of peaks**. The energy is spread, not concentrated at particular frequencies.
- **Main motor current rises slightly**, about 3 percent at full severity, from added friction.

## 4. Telling it apart from bearing wear

Both faults raise bearing vibration, so the vibration alone does not decide. The evidence that does:

| Evidence | Clogged filter | Bearing wear |
|---|---|---|
| Lube oil pressure | Falls | Normal |
| Spectrum above 300 Hz | Broadband floor, no discrete peaks | A harmonic family at fixed multiples of the shaft frequency |
| Motor current | Up about 3 percent | Up about 8 percent |

If pressure is normal and the spectrum shows discrete peaks, this is not a filter problem: see the main bearing runbook.

## 5. Checks before acting

1. Confirm the pressure trend over the last hour, not a single reading. The gear pump's pulsation makes single readings wander by 0.1 bar.
2. Confirm the vibration spectrum shape: broadband, not peaked.
3. Confirm the other press channels are otherwise normal.

## 6. Action

Replace the filter cartridge. This is a short task, in the order of minutes, compared with days of downtime for a failed bearing.

After the replacement, lube oil pressure should return to about 4.5 bar and the bearing vibration RMS should settle back to its baseline of about 1.3 mm/s.

## 7. If it is ignored

A lubricant-starved bearing wears quickly. Ignoring a clogged filter is how the expensive failure, bearing damage and an unplanned stop of days, eventually happens. The cheap fix is only cheap while it is early.

## 8. Safety

Follow the manufacturer's procedure for the press. Apply lock-out and tag-out before opening the lubrication circuit, relieve the line pressure, and use the specified cartridge. This document is a training stub and does not replace the OEM manual or your site's safety rules.
