---
document: Press main motor bearings and vibration diagnostics
machine: press-stamp-01
component_tags: [main_bearing_housing, main_drive_motor]
evidence_channels: [PRESS-STAMP-01.BEARING_VIBRATION_RMS, PRESS-STAMP-01.MAIN_MOTOR_CURRENT]
status: stub. Original text for the prototype. Values are illustrative and match the simulator, not a vendor.
---

# Press main motor bearings and vibration diagnostics

This is an original training runbook for the simulated stamping press. It is not an OEM manual, and the numbers are illustrative constants chosen for the demo. The diagnosis agent retrieves sections of it and cites them by document and section.

## 1. Scope

Reading the vibration of the press main drive: what a healthy signature looks like, what a developing bearing defect looks like, how to tell it from lubrication starvation, and why a threshold alarm alone is not enough.

## 2. A healthy signature

The main motor turns at about 1480 rpm, a **shaft frequency (1X) of 24.7 Hz**. The spectrum, in 12.5 Hz bins from 0 to 800 Hz, shows:

- a strong peak at **1X** and a smaller one at **2X** (about 49 Hz);
- a low band near the stroke rate;
- structural impact energy between about 60 and 150 Hz that swells during the working stroke of the press;
- a quiet floor of about 0.03 mm/s everywhere else.

The overall vibration RMS is computed from the spectrum. It breathes with the stroke, between about 1.0 and 1.7 mm/s, with a mean near **1.3 mm/s**.

| Overall RMS | Level |
|---|---|
| Warning | 2.5 mm/s |
| Alarm | 4.0 mm/s |

## 3. A developing bearing defect

An outer-race defect adds a **discrete family of harmonics at non-integer multiples of the shaft frequency**. For the illustrative defect used here the orders are about 3.55, 7.1, 10.65, 14.2 and 17.75 times 1X, which is roughly 88, 175, 263, 351 and 439 Hz. Each line has **sidebands at plus and minus 1X**.

Other signs:

- **Overall RMS rises gradually**. In the simulator it reaches about 2.9 mm/s at full severity.
- **It may never reach the alarm limit.** At full severity the RMS peaks at about 3.2 mm/s against an alarm limit of 4.0. It starts to flicker over the warning level at the stroke peaks from about 60 percent of the way, and is over it most of the time from about 80 percent.
- **Lube oil pressure stays normal.**
- **Motor current rises**, about 8 percent at full severity.

## 4. Why a threshold alarm is not enough

A bearing can be badly worn while the overall RMS stays under the alarm limit, because the energy sits in a few narrow lines. A plain alarm sees a number below its limit and says nothing. Two things catch it:

1. **Trend.** Compare the RMS to its own baseline over the last hours. A steady climb from 1.3 mm/s towards 3 mm/s is a drift, whatever the limit says.
2. **Shape.** Look at the spectrum. Discrete peaks at the defect orders are the signature.

## 5. Telling it apart from lubrication starvation

| Evidence | Bearing wear | Clogged lube filter |
|---|---|---|
| Spectrum above 300 Hz | A harmonic family at fixed multiples of 1X, with sidebands | A broadband floor, no discrete peaks |
| Lube oil pressure | Normal | Falls |
| Motor current | Up about 8 percent | Up about 3 percent |
| Cheapest next step | Plan a bearing replacement | Replace the filter cartridge |

Check the lubrication first when the evidence is mixed: a clogged filter is the cheap fault, and it causes bearing damage if it is left.

## 6. Action

Do not run a drifting bearing to alarm. Schedule an inspection at the next planned stop, confirm the defect frequencies with a handheld analyser, and plan the replacement. A planned bearing change costs hours. A bearing that fails in service costs days.

## 7. Safety

Follow the manufacturer's procedure for the press. Apply lock-out and tag-out before opening the main drive, and use the specified bearings and fits. This document is a training stub and does not replace the OEM manual or your site's safety rules.
