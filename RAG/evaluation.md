# RAG evaluation results

All results of the retrieval and generation benchmarks for the `RAG/` module, compiled from the saved result files in `evaluation/results/`. Generation model `gemini-3.5-flash-lite`, embedding model `gemini-embedding-2`, final prompt version `v3`. Measured on 2026-10-09.

## 1. Verdict

**Overall: FAIL.** Six of seven criteria pass. Multi-step diagnostic correctness is 75.0% against a 90% target, so no 90% claim is made for diagnosis.

| Criterion | Target | Result | Status |
|---|---|---|---|
| Retrieval Recall@5 | 90.0% | 98.4% | PASS |
| Answer correctness | 90.0% | 92.2% | PASS |
| Multi-step diagnostic correctness | 90.0% | 75.0% | **FAIL** |
| Threshold accuracy | 90.0% | 100.0% | PASS |
| Insufficient-information accuracy | 90.0% | 100.0% | PASS |
| Groundedness | 90.0% | 98.4% | PASS |
| Machine isolation | 95.0% | 100.0% | PASS |

## 2. Corpus

10 PDFs, 261 chunks (122 press-stamp-01, 139 robot-weld-01).

| Machine | Document | Chunks |
|---|---|---|
| press-stamp-01 | 01_Operating_Conditions_and_Performance_Standards_Press_Stamp.pdf | 29 |
| press-stamp-01 | 02_Failure_Modes_and_Fault_Signatures_Press_Stamp.pdf | 23 |
| press-stamp-01 | 03_Diagnostic_Procedures_and_Decision_Logic_Press_Stamp.pdf | 22 |
| press-stamp-01 | 04_Maintenance_Inspection_and_Troubleshooting_Press_Stamp.pdf | 29 |
| press-stamp-01 | 05_Fault_History_Case_Scenarios_and_Diagnostic_Evidence_Press_Stamp.pdf | 19 |
| robot-weld-01 | 01_Operating_Conditions_and_Performance_Standards_Sensor1.pdf | 30 |
| robot-weld-01 | 02_Failure_Modes_and_Fault_Signatures_Sensor1.pdf | 26 |
| robot-weld-01 | 03_Diagnostic_Procedures_and_Decision_Logic_Sensor1.pdf | 27 |
| robot-weld-01 | 04_Maintenance_Inspection_and_Troubleshooting_Sensor1.pdf | 33 |
| robot-weld-01 | 05_Fault_History_Case_Scenarios_and_Diagnostic_Evidence_Sensor1.pdf | 23 |

## 3. Retrieval

62 queries: 50 single-topic and 12 multi-step diagnostic. A hit is a retrieved chunk from a gold section of the asked machine. No machine argument is passed, so machine detection is part of the measurement.

| Metric | Result |
|---|---|
| Recall@1 | 83.9% |
| Recall@3 | 96.8% |
| Recall@5 | 98.4% |
| Recall@10 | 100.0% |
| MRR@10 | 0.904 |
| Answer value present in top 5 (9 queries with a checked value) | 100.0% |
| Gold section present in the context given to the model | 98.4% |
| Machine isolation, top 5 | 100.0% |
| Multi-step queries: mean stage coverage in context (12 queries) | 86.1% |
| Multi-step queries: all stages covered | 66.7% |

### 3.1 Ablation

| Ranking | Recall@1 | Recall@3 | Recall@5 | Recall@10 | MRR@10 |
|---|---|---|---|---|---|
| Hybrid + rerank (used) | 83.9% | 96.8% | 98.4% | 100.0% | 0.904 |
| Dense only | 79.0% | 95.2% | 98.4% | 100.0% | 0.878 |
| BM25 only | 59.7% | 80.6% | 85.5% | 95.2% | 0.714 |

### 3.2 Recall@5 by group

| Group | Queries | Recall@5 |
|---|---|---|
| case_based | 6 | 100.0% |
| component_identification | 2 | 100.0% |
| diagnostic_procedure | 6 | 100.0% |
| fault_differentiation | 2 | 50.0% |
| fault_identification | 7 | 100.0% |
| maintenance | 8 | 100.0% |
| multi_step_diagnostic | 12 | 100.0% |
| operating_conditions | 5 | 100.0% |
| press-stamp-01 | 31 | 100.0% |
| robot-weld-01 | 31 | 96.8% |
| telemetry_interpretation | 4 | 100.0% |
| threshold | 6 | 100.0% |
| troubleshooting | 4 | 100.0% |

### 3.3 Multi-step diagnostic queries: stage coverage

Share of the labelled stages (threshold, fault, action and similar) with evidence in the context given to the model.

| ID | Machine | Context size | Stage coverage | First relevant rank |
|---|---|---|---|---|
| RD01 | press-stamp-01 | 8 | 100.0% | 1 |
| RD02 | press-stamp-01 | 8 | 100.0% | 1 |
| RD03 | press-stamp-01 | 8 | 100.0% | 1 |
| RD04 | press-stamp-01 | 8 | 33.3% | 1 |
| RD05 | press-stamp-01 | 8 | 100.0% | 1 |
| RD06 | press-stamp-01 | 8 | 66.7% | 3 |
| RD07 | robot-weld-01 | 8 | 100.0% | 1 |
| RD08 | robot-weld-01 | 8 | 66.7% | 1 |
| RD09 | robot-weld-01 | 8 | 100.0% | 1 |
| RD10 | robot-weld-01 | 8 | 66.7% | 1 |
| RD11 | robot-weld-01 | 8 | 100.0% | 1 |
| RD12 | robot-weld-01 | 8 | 100.0% | 1 |

### 3.4 Every retrieval query

| ID | Category | Query | Detected machine | First relevant rank | Hit@5 |
|---|---|---|---|---|---|
| RP01 | threshold | What are the warning and alarm limits for lube oil pressure on press-stamp-01? | press-stamp-01 (explicit) | 1 | yes |
| RP02 | threshold | At what bearing vibration RMS value does the stamping press reach the critical level? | press-stamp-01 (explicit) | 1 | yes |
| RP03 | operating_conditions | What is the healthy baseline for the 60 s mean main motor current on the press? | press-stamp-01 (inferred) | 2 | yes |
| RP04 | threshold | How long must lube oil pressure stay low before a warning opens on the press, and at what pressure does the warning clear? | press-stamp-01 (inferred) | 1 | yes |
| RP05 | operating_conditions | What operating states does press-stamp-01 have and how do they gate the diagnosis? | press-stamp-01 (explicit) | 1 | yes |
| RP06 | operating_conditions | How do the press channels behave during startup and shutdown? | press-stamp-01 (inferred) | 1 | yes |
| RP07 | telemetry_interpretation | Which spectrum frequencies reveal a bearing outer race defect on the stamping press? | press-stamp-01 (explicit) | 1 | yes |
| RP08 | fault_identification | Lube oil pressure is falling while vibration rises and the spectrum gains a broadband floor above 300 Hz. Which fault is this on the stamping press? | press-stamp-01 (explicit) | 2 | yes |
| RP09 | fault_differentiation | How do I tell a clogged lube filter apart from bearing wear on press-stamp-01? | press-stamp-01 (explicit) | 4 | yes |
| RP10 | fault_identification | Why does a plain threshold alarm miss bearing wear on the press? | press-stamp-01 (inferred) | 1 | yes |
| RP11 | fault_identification | What does fault F06, a stuck relief valve, look like in the press telemetry? | press-stamp-01 (inferred) | 1 | yes |
| RP12 | diagnostic_procedure | What rules separate flat floor evidence from discrete family evidence in the press diagnostic procedure? | press-stamp-01 (inferred) | 1 | yes |
| RP13 | diagnostic_procedure | How is the severity score calculated and when is an alert raised one level for press-stamp-01? | press-stamp-01 (explicit) | 1 | yes |
| RP14 | diagnostic_procedure | How is diagnostic confidence assigned and when must a specialist be involved for the press? | press-stamp-01 (inferred) | 1 | yes |
| RP15 | maintenance | What are the steps to replace the lube filter cartridge? | press-stamp-01 (inferred) | 1 | yes |
| RP16 | maintenance | What safety precautions and lock-out checks are required before working on the press main drive? | press-stamp-01 (inferred) | 1 | yes |
| RP17 | maintenance | After replacing the filter, which readings confirm the press repair was successful? | press-stamp-01 (inferred) | 1 | yes |
| RP18 | troubleshooting | Pressure dropped but swapping the filter did not help. What should be checked next on the press? | press-stamp-01 (inferred) | 1 | yes |
| RP19 | maintenance | Which tools, spare parts and consumables are needed for press lubrication and bearing work? | press-stamp-01 (inferred) | 1 | yes |
| RP20 | troubleshooting | The press gateway shows as stale and there are sequence gaps. How do I troubleshoot the data path? | press-stamp-01 (inferred) | 1 | yes |
| RP21 | case_based | Is there a worked case where bearing wear was at full severity on the press but never raised an alarm? | press-stamp-01 (inferred) | 2 | yes |
| RP22 | case_based | What happened in the case where a single vibration spike turned out to be a false alarm on the stamping press? | press-stamp-01 (explicit) | 1 | yes |
| RP23 | case_based | Two situations with bearing vibration near 2.9 mm/s had different causes. How were they separated? | press-stamp-01 (inferred) | 1 | yes |
| RP24 | component_identification | Where does the pressure transducer sit relative to the lube filter, and which component does each press sensor monitor? | press-stamp-01 (inferred) | 1 | yes |
| RP25 | telemetry_interpretation | How quickly does lube oil pressure fall per unit of fault ramp and how long until the alarm threshold is reached? | press-stamp-01 (inferred) | 1 | yes |
| RR01 | threshold | What are the warning and alarm limits for axis 4 servo torque on robot-weld-01? | robot-weld-01 (explicit) | 2 | yes |
| RR02 | threshold | Why is 34 Nm proposed as the critical threshold for the robot? | robot-weld-01 (inferred) | 1 | yes |
| RR03 | operating_conditions | What is the normal operating range of the axis 4 servo torque during a healthy weld cycle? | robot-weld-01 (inferred) | 1 | yes |
| RR04 | threshold | How many consecutive cycles must the per-cycle peak stay above the limit before a warning opens on robot-weld-01? | robot-weld-01 (explicit) | 1 | yes |
| RR05 | operating_conditions | How does a cold start or warm-up affect the axis 4 torque readings? | robot-weld-01 (inferred) | 1 | yes |
| RR06 | telemetry_interpretation | What do the sixth-harmonic amplitude A6 and the cycle mean M tell me, and what are their watch levels? | robot-weld-01 (inferred) | 1 | yes |
| RR07 | telemetry_interpretation | How are trend rates of the cycle mean torque classified, for example a step change versus gradual drift? | robot-weld-01 (inferred) | 1 | yes |
| RR08 | fault_identification | The cycle mean torque rose, a 0.75 Hz ripple appeared and TCP deviation is climbing. What fault is this on the welding robot? | robot-weld-01 (explicit) | 2 | yes |
| RR09 | fault_identification | What is the telemetry signature of brake drag on axis 4? | robot-weld-01 (inferred) | 1 | yes |
| RR10 | fault_differentiation | How can gearbox wear be distinguished from lubrication degradation on robot-weld-01? | robot-weld-01 (explicit) | 8 | no |
| RR11 | fault_identification | Which faults can lubrication loss turn into in the robot gearbox if it is left uncorrected? | robot-weld-01 (inferred) | 1 | yes |
| RR12 | fault_identification | What does a flatlined or saturated Sensor 1 signal look like and how is it recognised? | robot-weld-01 (inferred) | 2 | yes |
| RR13 | diagnostic_procedure | Which data validity checks must pass before the robot torque signal is diagnosed? | robot-weld-01 (inferred) | 1 | yes |
| RR14 | diagnostic_procedure | Who is notified, and how quickly, when the robot reaches the alarm or critical level? | robot-weld-01 (inferred) | 1 | yes |
| RR15 | diagnostic_procedure | How is the time to the next threshold predicted for robot-weld-01? | robot-weld-01 (explicit) | 1 | yes |
| RR16 | maintenance | When should the axis 4 gear set or gearbox be replaced? | robot-weld-01 (inferred) | 1 | yes |
| RR17 | maintenance | What does the preventive inspection checklist for the robot forearm axis cover? | robot-weld-01 (inferred) | 1 | yes |
| RR18 | maintenance | What are the post-maintenance verification criteria for the axis 4 servo torque? | robot-weld-01 (inferred) | 1 | yes |
| RR19 | troubleshooting | The per-cycle torque peak sits between 26 and 30 Nm in every cycle. What is the likely cause and the corrective action? | robot-weld-01 (inferred) | 3 | yes |
| RR20 | maintenance | Which maintenance mistakes can corrupt the diagnosis of Sensor 1? | robot-weld-01 (inferred) | 1 | yes |
| RR21 | case_based | What happened in the collision case where a single torque sample reached 41.3 Nm? | robot-weld-01 (inferred) | 1 | yes |
| RR22 | case_based | Describe the case of a false alarm after a robot program change. | robot-weld-01 (inferred) | 1 | yes |
| RR23 | case_based | How was the repair verified in the case that followed the gearbox replacement? | robot-weld-01 (inferred) | 1 | yes |
| RR24 | component_identification | Which component and twin mesh does Sensor 1 on robot-weld-01 relate to? | robot-weld-01 (explicit) | 1 | yes |
| RR25 | troubleshooting | How do I troubleshoot the data path when Sensor 1 telemetry is stale or has gaps? | robot-weld-01 (inferred) | 1 | yes |
| RD01 | multi_step_diagnostic | On press-stamp-01 the lube oil pressure has dropped to 3.4 bar and bearing vibration is 3.0 mm/s with a broadband spectrum floor. What level is this, what is the fault, and what should I inspect and do? | press-stamp-01 (explicit) | 1 | yes |
| RD02 | multi_step_diagnostic | Bearing vibration V60 on the stamping press has crept up to 2.9 mm/s, lube pressure is steady at 4.5 bar and there are discrete spectral lines. Interpret the reading against the limits, name the likely fault, and give the inspection, corrective action and verification. | press-stamp-01 (explicit) | 1 | yes |
| RD03 | multi_step_diagnostic | Stroke peak motor current is 182 A in every stroke on press-stamp-01 but vibration and oil pressure are normal. Is that a warning, what is causing it and what do I check? | press-stamp-01 (explicit) | 1 | yes |
| RD04 | multi_step_diagnostic | Lube oil pressure on the press reads flat with no pulsation while vibration and the spectrum are unchanged. Is this a real lubrication fault, and what should be verified first? | press-stamp-01 (inferred) | 1 | yes |
| RD05 | multi_step_diagnostic | Lube oil pressure fell to 2.4 bar and vibration is 4.8 mm/s on press-stamp-01. How severe is this, who must be told, and what action and post-repair checks apply? | press-stamp-01 (explicit) | 1 | yes |
| RD06 | multi_step_diagnostic | Pressure is slightly low at 4.2 bar, vibration is 2.7 mm/s and I see both a raised floor and some discrete lines on the press. Which fault do I treat first and how do I confirm afterwards? | press-stamp-01 (inferred) | 3 | yes |
| RD07 | multi_step_diagnostic | On robot-weld-01 the per-cycle torque peak is 27 Nm for several cycles, the cycle mean is 18 Nm and A6 is 1.6 Nm. What level is this, which fault explains it, and what inspection, corrective action and verification follow? | robot-weld-01 (explicit) | 1 | yes |
| RD08 | multi_step_diagnostic | Axis 4 torque mean rose 3 Nm with no ripple and the offset is bigger after a cold start on the welding robot. Interpret it, differentiate the candidate faults and tell me what to inspect and how to verify the fix. | robot-weld-01 (explicit) | 1 | yes |
| RD09 | multi_step_diagnostic | A single torque sample of 41 Nm was recorded on robot-weld-01 and then the values returned to normal. Is this critical, what could have caused it, and what should be inspected? | robot-weld-01 (explicit) | 1 | yes |
| RD10 | multi_step_diagnostic | The robot shows axis 4 torque elevated by about 3 Nm at idle and hold with the ripple unchanged. Which fault is likely, how do I separate it from a drive offset, and what is the corrective action? | robot-weld-01 (inferred) | 1 | yes |
| RD11 | multi_step_diagnostic | The per-cycle peak has been at 31 Nm for two consecutive cycles on robot-weld-01. Which level opens, who is notified, and what are the required response and the return-to-service check? | robot-weld-01 (explicit) | 1 | yes |
| RD12 | multi_step_diagnostic | Sensor 1 on robot-weld-01 shows one constant torque value for several cycles. Should a mechanical fault be diagnosed, and which checks come first? | robot-weld-01 (explicit) | 1 | yes |

## 4. Generation

64 questions, one generation call each, scored with deterministic checks: values that must appear, alternatives of which one must appear, values that must not appear.

| Metric | Result |
|---|---|
| Answer correctness | 92.2% |
| Answerable questions only | 90.7% |
| Multi-step diagnostic correctness (n=16) | 75.0% |
| Diagnostic headings used | 95.8% |
| Threshold accuracy (n=17) | 100.0% |
| Insufficient-information accuracy (n=10) | 100.0% |
| False refusals on answerable questions | 0.0% |
| Groundedness (every number in the evidence, and a citation) | 98.4% |
| Unsupported claims (answers with a number not in the evidence) | 0.0% |
| Citation rate | 98.4% |
| Context from the asked machine only | 100.0% |
| Answers containing a value of the other machine | 0.0% |

### 4.1 Correctness by category

| Category | Questions | Correct |
|---|---|---|
| action | 6 | 100.0% |
| component | 3 | 100.0% |
| diagnostic | 16 | 75.0% |
| fault | 5 | 80.0% |
| inspection | 3 | 100.0% |
| insufficient | 8 | 100.0% |
| isolation | 6 | 100.0% |
| threshold | 17 | 100.0% |

### 4.2 Correctness by machine

| Machine | Correct |
|---|---|
| press-stamp-01 | 90.6% |
| robot-weld-01 | 93.8% |

### 4.3 Prompt versions

The same 64 questions and the same checks were run with three versions of the system prompt. The checks were not changed between runs. From v2 onward the retriever also reserves one context slot for the limits table when a question contains a reading.

| Prompt | Answer correctness | Multi-step diagnostic | Threshold | Insufficient | Groundedness | Failed questions |
|---|---|---|---|---|---|---|
| v1 | 92.2% | 75.0% | 100.0% | 100.0% | 100.0% | GP20, GD01, GD04, GD07, GD10 |
| v2 | 90.6% | 68.8% | 100.0% | 100.0% | 98.4% | GP10, GP13, GR18, GD01, GD07, GD10 |
| v3 (final) | 92.2% | 75.0% | 100.0% | 100.0% | 98.4% | GP10, GD01, GD04, GD07, GD10 |

### 4.4 Gemini judge (second opinion)

64 answers judged in batched calls. The judge is more lenient than the deterministic checks: it accepted every answer the checks failed. No pass or fail decision uses it.

| Metric | Result |
|---|---|
| Correct | 100.0% |
| Correct or partial | 100.0% |
| Unsupported claims | 0.0% |

### 4.5 Failed questions (final run)

**GP10** (fault, press-stamp-01)

- Question: Does BEARING_WEAR ever reach the 4.0 mm/s vibration alarm on press-stamp-01?
- Reference: No. BEARING_WEAR peaks at about 3.2 mm/s (mean about 2.9 mm/s) at full severity and never reaches the 4.0 mm/s alarm.
- Missing from the answer: 3.2
- Judge: yes

```text
Direct answer: No, BEARING_WEAR never reaches the 4.0 mm/s vibration alarm on press-stamp-01 [S1].
```

**GD01** (diagnostic, press-stamp-01)

- Question: On press-stamp-01 the 10 s mean lube oil pressure has fallen to 2.4 bar and bearing vibration is 4.8 mm/s with a flat broadband floor. Classify the level, name the likely fault and give the action and the post-repair checks.
- Reference: Pressure at or below 2.5 bar is critical (L4); vibration 4.8 mm/s is above the 4.0 mm/s alarm. Severe CLOGGED_FILTER (F01) with likely oil starvation of the bearings. Controlled stop; replace the filter cartridge (lock-out, relieve line pressure), then check bearings. Verify P60 4.35 to 4.65 bar (about 4.5) and V60 1.20 to 1.45 mm/s (about 1.3).
- Missing from the answer: controlled stop | stop
- Judge: yes

```text
Direct answer: The readings indicate an alarm/critical condition (level L3 for pressure at 2.5 bar or lower [S1]; level L3 for vibration between 4.0 and 6.99 mm/s [S3]) caused by a clogged lubrication filter (F01) [S2, S4].

Condition / Observed evidence
- Lube oil pressure 10 s mean has fallen to 2.4 bar [question, S1]
- Bearing vibration is 4.8 mm/s with a flat broadband floor [question, S2, S3]

Threshold interpretation
- Pressure of 2.4 bar is at or below 2.5 bar, breaching the low alarm limit, which is level L4 (oil starvation of the bearings likely) in Table 22 [S1], and corresponds to level L3 (alarm, P60 below 3.0 bar) in Table 23 [S3].
- Vibration of 4.8 mm/s is in the 4.0 to 6.99 mm/s range, breaching the high alarm limit, which is level L3 (alarm) [S3].

Possible faults
- F01 CLOGGED_FILTER (clogged lube filter) [S2, S4]

Recommended inspection
- Confirm P trend over the last hour, spectrum shape, and that other channels are normal; check filter cartridge [S2].

Recommended action
- Replace filter this shift [S1] / Replace cartridge now [S2, S7, S8].
- Follow the OEM procedure with lock-out and tag-out and relieve line pressure [S2].
- Inspect the main bearings after replacement because the starved period was short but severe [S8].

Verification
- P returns to about 4.5 bar and V settles to about 1.3 mm/s; HB300 back to about 0.03 mm/s [S2, S7].
- If V stays above 1.45 mm/s, treat as bearing damage (T2) [S8].
- Extra spectrum check for lines [S8].
```

**GD04** (diagnostic, press-stamp-01)

- Question: On press-stamp-01 P60 is 4.25 bar, V60 is 2.7 mm/s, and the spectrum shows both a raised broadband floor and some discrete lines. Which fault should be treated first and how is the result confirmed?
- Reference: Mixed evidence between a lubrication fault and a bearing fault (F01 or combined F16): lubrication first. V60 is at warning (at or above 2.5 mm/s), P60 at watch (at or below 4.30 bar). Replace the filter first, then re-check the spectrum; if lines remain, follow the bearing procedure.
- Missing from the answer: warning | L2
- Judge: yes

```text
Direct answer: A clogged filter should be treated first because the evidence is mixed, and the result is confirmed when the pressure is restored, lines are absent, and verification criteria are met [S1, S3, S7].

Condition / Observed evidence
P60 is 4.25 bar, V60 is 2.7 mm/s, and the spectrum shows both a raised broadband floor and some discrete lines [User message].

Threshold interpretation
P60 is 4.25 bar and V60 is 2.7 mm/s [User message].

Possible faults
F01 or F16 (mixed evidence between a lubrication fault and a bearing fault) [S3, S4].

Recommended action
Replace the filter first, then re-check the spectrum [S3, S5].

Verification
P restored; lines absent [S7].
```

**GD07** (diagnostic, robot-weld-01)

- Question: On robot-weld-01 the per-cycle torque peak has been 31 Nm for two consecutive cycles. Which level opens, who is notified, how fast must action follow and what is the response?
- Reference: Peak at or above 30 Nm for 2 consecutive cycles opens the alarm (L3). Maintenance supervisor; intervention within the current shift; recommend intervention, reduced duty and stop planning. It escalates to critical if the alarm persists 10 minutes or a sample reaches 34 Nm.
- Missing from the answer: supervisor
- Judge: yes

```text
Direct answer: An L3 Alarm level opens.

Condition / Observed evidence
- The per-cycle torque peak has been 31 Nm for two consecutive cycles [S1].

Threshold interpretation
- Compared against the L2 Warning limit of at or above 26 Nm, the reading is breached [S1].
- Compared against the L3 Alarm limit of at or above 30 Nm, the reading is breached [S1].
- The resulting level is L3 Alarm (severity S4, status alarm, red pulsing on twin) [S1, S3, S5, S6].

Recommended inspection
- Intervention within the current shift [S3].
- Recommended maintenance request: intervention within the shift; lock-out and OEM procedure; schedule stop and spare parts (gear set, lubricant, seals) [S2, S3].

Recommended action
- Operational advice: reduce speed override or duty if the process allows; do not run to failure [S2, S3].
- Escalation: escalate to L4 if the alarm persists 10 minutes or a sample reaches 34 Nm [S1].
```

**GD10** (diagnostic, robot-weld-01)

- Question: On robot-weld-01 the cycle mean had been raised by a friction offset from lubrication loss, and now A6 has appeared and grown to 0.6 Nm on top of that offset. What does this indicate and what should be done?
- Reference: A transition from lubrication loss (F02) to gearbox wear (F01): A6 appearing and growing above 0.4 Nm on top of a friction offset. Relubricate early and check the oil for particles; if particles are found switch the working diagnosis to F01 and plan the gearbox inspection.
- Missing from the answer: 0.4
- Judge: yes

```text
Direct answer: This indicates that the machine has transitioned from lubrication loss to emerging gearbox wear (F01 stage 1 to 2).

Condition / Observed evidence
- Three days after lubricant service, the cycle mean torque falls from 17.0 to 15.2 Nm but not to baseline, A6 rises from 0.12 to 0.70 Nm (and has grown to 0.6 Nm on top of the offset), TCP is 0.17 mm, and the oil sample taken during service showed fines on the magnet [S5].

Threshold interpretation
- M is above the 15.0 Nm early-degradation boundary, with no limit crossed [S5].

Possible faults
- F01 emerging wear (GEARBOX_WEAR stage 1 to 2), residual F02, or F04 [S5].

Fault differentiation
- A purely friction fault would have returned to baseline after service [S5]. Removing the friction contribution exposes the underlying wear: the part of the shift that did not respond to lubrication is the part with ripple, carrying the ripple ratio of F01 (A6 / dM 0.32) with swing unchanged [S5].

Recommended inspection
- Perform oil particle analysis and backlash measurements (tasks T1 and T2), and trend A6 [S5].

Recommended action
- Plan gear inspection and replacement before alarm, and shorten the oil sampling interval [S5].

Verification
- Gear replacement is planned at the next stop, with the A6 trend monitored until then [S5]. Features return to baseline only after gear replacement [S5].
```

### 4.6 Every generation question (final run)

| ID | Category | Machine | Question | Correct | Grounded | Declined | Sources cited | Judge |
|---|---|---|---|---|---|---|---|---|
| GP01 | threshold | press-stamp-01 | What is the warning threshold for lube oil pressure on press-stamp-01? | yes | yes | no | 3 | yes |
| GP02 | threshold | press-stamp-01 | At what bearing vibration RMS value should an alarm be raised on press-stamp-01? | yes | yes | no | 3 | yes |
| GP03 | threshold | press-stamp-01 | Is a bearing vibration of 8.2 mm/s within the normal range for press-stamp-01? | yes | yes | no | 1 | yes |
| GP04 | threshold | press-stamp-01 | What is the critical threshold for the main motor current stroke peak on the stamping press? | yes | yes | no | 3 | yes |
| GP05 | threshold | press-stamp-01 | What is the normal operating range of lube oil pressure for press-stamp-01? | yes | yes | no | 2 | yes |
| GP06 | threshold | press-stamp-01 | The 10 s mean lube oil pressure on press-stamp-01 is 2.8 bar. Which level is this and what action is recommended? | yes | yes | no | 6 | yes |
| GP07 | action | press-stamp-01 | What action is recommended after bearing vibration exceeds the critical threshold on press-stamp-01? | yes | yes | no | 3 | yes |
| GP08 | threshold | press-stamp-01 | Below what stroke peak value does the main motor current warning clear on press-stamp-01? | yes | yes | no | 1 | yes |
| GP09 | threshold | press-stamp-01 | What is the watch level for the 60 s mean lube oil pressure P60 on press-stamp-01? | yes | yes | no | 1 | yes |
| GP10 | fault | press-stamp-01 | Does BEARING_WEAR ever reach the 4.0 mm/s vibration alarm on press-stamp-01? | no | yes | no | 1 | yes |
| GP11 | component | press-stamp-01 | Which component is affected by the CLOGGED_FILTER fault on press-stamp-01 and what is the corrective action? | yes | yes | no | 1 | yes |
| GP12 | diagnostic | press-stamp-01 | On press-stamp-01 the lube oil pressure is normal at 4.50 bar, V60 is 1.94 mm/s and discrete spectrum lines appear at about 88, 175 and 263 Hz. What is the likely fault and what should be inspected? | yes | yes | no | 6 | yes |
| GP13 | diagnostic | press-stamp-01 | On press-stamp-01, P60 is 3.4 bar, V60 is 3.0 mm/s and the spectrum shows a flat broadband floor with no discrete lines. Diagnose the condition and recommend an action. | yes | yes | no | 6 | yes |
| GP14 | action | press-stamp-01 | When the evidence is mixed between a lubrication fault and a bearing fault on the press, what should be done first? | yes | yes | no | 7 | yes |
| GP15 | inspection | press-stamp-01 | Which P60 and V60 readings confirm a successful repair on press-stamp-01? | yes | yes | no | 3 | yes |
| GP16 | fault | press-stamp-01 | At which frequencies do the bearing defect lines appear on press-stamp-01? | yes | yes | no | 2 | yes |
| GP17 | diagnostic | press-stamp-01 | On press-stamp-01 the stroke peak current Ipk is 182 A in every stroke while the idle level, vibration and pressure are normal. What is the likely cause and what should be inspected? | yes | yes | no | 6 | yes |
| GP18 | action | press-stamp-01 | Who is notified and how fast must action be taken at an L3 alarm on press-stamp-01? | yes | yes | no | 5 | yes |
| GP19 | fault | press-stamp-01 | By how much does motor current rise for CLOGGED_FILTER compared with BEARING_WEAR on the press? | yes | yes | no | 3 | yes |
| GP20 | inspection | press-stamp-01 | What should be checked on press-stamp-01 if the pressure is not restored after a filter swap? | yes | yes | no | 1 | yes |
| GR01 | threshold | robot-weld-01 | What is the warning threshold for axis 4 servo torque on robot-weld-01? | yes | no | no | 0 | yes |
| GR02 | threshold | robot-weld-01 | At what torque value should an alarm be raised on robot-weld-01? | yes | yes | no | 3 | yes |
| GR03 | threshold | robot-weld-01 | Is a torque sample of 24.5 Nm within the normal range for robot-weld-01? | yes | yes | no | 1 | yes |
| GR04 | threshold | robot-weld-01 | What is the proposed critical threshold for the axis 4 torque on robot-weld-01? | yes | yes | no | 1 | yes |
| GR05 | threshold | robot-weld-01 | What are the declared minimum and maximum (clamp range) of AXIS_4_SERVO_TORQUE? | yes | yes | no | 1 | yes |
| GR06 | threshold | robot-weld-01 | What is the healthy band of the cycle mean torque M on robot-weld-01? | yes | yes | no | 1 | yes |
| GR07 | threshold | robot-weld-01 | Below what per-cycle peak value does the L2 warning clear on robot-weld-01? | yes | yes | no | 1 | yes |
| GR08 | action | robot-weld-01 | What action is required when a torque sample reaches 34 Nm or more on robot-weld-01? | yes | yes | no | 3 | yes |
| GR09 | threshold | robot-weld-01 | At what fault severity r does gearbox wear start to cross the warning limit and the alarm limit on robot-weld-01? | yes | yes | no | 1 | yes |
| GR10 | threshold | robot-weld-01 | How long may an alarm persist on robot-weld-01 before it escalates to critical? | yes | yes | no | 3 | yes |
| GR11 | component | robot-weld-01 | Which component is affected by the GEARBOX_WEAR fault on robot-weld-01? | yes | yes | no | 1 | yes |
| GR12 | diagnostic | robot-weld-01 | On robot-weld-01 the cycle mean torque rose by 3 Nm with the swing unchanged, A6 stays below 0.4 Nm and the offset is largest right after a cold start. What is the likely fault and what should be inspected? | yes | yes | no | 4 | yes |
| GR13 | diagnostic | robot-weld-01 | On robot-weld-01 one torque sample of 41.3 Nm occurred with healthy values before and after it and the TCP deviation stepped up. What is the likely cause? | yes | yes | no | 2 | yes |
| GR14 | fault | robot-weld-01 | How do I separate gearbox wear (F01) from lubrication degradation (F02) on robot-weld-01? | yes | yes | no | 5 | yes |
| GR15 | inspection | robot-weld-01 | What are the post-maintenance pass criteria for the cycle mean, the per-cycle peak and A6 on robot-weld-01? | yes | yes | no | 2 | yes |
| GR16 | action | robot-weld-01 | What is the recommended corrective action for a confirmed gearbox wear diagnosis on robot-weld-01? | yes | yes | no | 4 | yes |
| GR17 | fault | robot-weld-01 | What is the typical idle offset caused by brake drag on axis 4, and above what idle offset is it escalated? | yes | yes | no | 1 | yes |
| GR18 | diagnostic | robot-weld-01 | On robot-weld-01 the cycle mean M is 14.4 Nm right after a weekend restart and falls back to 13.2 Nm after 20 minutes, with A6 and TCP unchanged. Is this a fault? | yes | yes | no | 1 | yes |
| GR19 | action | robot-weld-01 | Who is notified at L4 critical on robot-weld-01 and what is the time target? | yes | yes | no | 2 | yes |
| GR20 | component | robot-weld-01 | How long is the weld cycle and what is the publish interval of Sensor 1 on robot-weld-01? | yes | yes | no | 1 | yes |
| GU01 | insufficient | robot-weld-01 | What is the gear ratio of the axis 4 gearbox on robot-weld-01? | yes | yes | yes | 1 | yes |
| GU02 | insufficient | robot-weld-01 | Which manufacturer and model is robot-weld-01? | yes | yes | yes | 1 | yes |
| GU03 | insufficient | press-stamp-01 | What is the tonnage rating of press-stamp-01? | yes | yes | yes | 1 | yes |
| GU04 | insufficient | press-stamp-01 | Which ISO viscosity grade of oil must be used in the lubrication circuit of press-stamp-01? | yes | yes | yes | 2 | yes |
| GU05 | insufficient | press-stamp-01 | What is the part number of the lube filter cartridge for press-stamp-01? | yes | yes | yes | 2 | yes |
| GU06 | insufficient | press-stamp-01 | What is the alarm limit for oil temperature on press-stamp-01? | yes | yes | yes | 0 | yes |
| GU07 | insufficient | robot-weld-01 | What is the alarm threshold for weld current on robot-weld-01? | yes | yes | yes | 0 | yes |
| GU08 | insufficient | robot-weld-01 | After how many operating hours must the axis 4 gearbox of robot-weld-01 be relubricated? | yes | yes | yes | 1 | yes |
| GX01 | isolation | robot-weld-01 | What is the lube oil pressure warning threshold on robot-weld-01? | yes | yes | yes | 0 | yes |
| GX02 | isolation | press-stamp-01 | What is the axis 4 servo torque alarm limit for press-stamp-01? | yes | yes | yes | 0 | yes |
| GX03 | isolation | press-stamp-01 | What are the warning thresholds for each monitored channel? | yes | yes | no | 1 | yes |
| GX04 | isolation | robot-weld-01 | What are the warning and alarm thresholds of the monitored channel? | yes | yes | no | 2 | yes |
| GX05 | isolation | press-stamp-01 | Vibration is rising. Which bearing-related fault should I suspect and what should I inspect? | yes | yes | no | 7 | yes |
| GX06 | isolation | robot-weld-01 | Which lubrication-related fault should I suspect when the mean rises without ripple, and what is the corrective action? | yes | yes | no | 2 | yes |
| GD01 | diagnostic | press-stamp-01 | On press-stamp-01 the 10 s mean lube oil pressure has fallen to 2.4 bar and bearing vibration is 4.8 mm/s with a flat broadband floor. Classify the level, name the likely fault and give the action and the post-repair checks. | no | yes | no | 6 | yes |
| GD02 | diagnostic | press-stamp-01 | On press-stamp-01 V60 is 2.9 mm/s continuously, P60 is 4.50 bar, I60 is 102.3 A and there are strong lines at the bearing defect orders. Give the level, the fault, how it differs from a clogged filter, and the inspection, action and verification. | yes | yes | no | 8 | yes |
| GD03 | diagnostic | press-stamp-01 | On press-stamp-01 the lube oil pressure reads a flat 4.1 bar with no pulsation at all, while V60 is 1.3 mm/s and the spectrum floor is unchanged. What is the likely cause and what should be checked first? | yes | yes | no | 5 | yes |
| GD04 | diagnostic | press-stamp-01 | On press-stamp-01 P60 is 4.25 bar, V60 is 2.7 mm/s, and the spectrum shows both a raised broadband floor and some discrete lines. Which fault should be treated first and how is the result confirmed? | no | yes | no | 5 | yes |
| GD05 | diagnostic | press-stamp-01 | After the filter cartridge was replaced on press-stamp-01, P60 is back at 4.50 bar but V60 stays at 1.9 mm/s and discrete lines are present. Is the repair verified, and what is the next step? | yes | yes | no | 5 | yes |
| GD06 | diagnostic | robot-weld-01 | On robot-weld-01 the per-cycle torque peak is 27 Nm in every cycle, the cycle mean M is 18 Nm, A6 is 1.6 Nm and TCP deviation is rising. Classify the level, name the fault and give the inspection, corrective action and verification. | yes | yes | no | 8 | yes |
| GD07 | diagnostic | robot-weld-01 | On robot-weld-01 the per-cycle torque peak has been 31 Nm for two consecutive cycles. Which level opens, who is notified, how fast must action follow and what is the response? | no | yes | no | 5 | yes |
| GD08 | diagnostic | robot-weld-01 | On robot-weld-01 the axis 4 torque is elevated by about 3 Nm even at idle and hold, the cycle shape is preserved, A6 and noise are unchanged and the brake area is warm. What is the likely fault, what should be inspected and what is the corrective action? | yes | yes | no | 2 | yes |
| GD09 | diagnostic | robot-weld-01 | Sensor 1 on robot-weld-01 has shown one constant torque value for several cycles while the robot is in production. Should a mechanical fault be diagnosed, and what should be done first? | yes | yes | no | 1 | yes |
| GD10 | diagnostic | robot-weld-01 | On robot-weld-01 the cycle mean had been raised by a friction offset from lubrication loss, and now A6 has appeared and grown to 0.6 Nm on top of that offset. What does this indicate and what should be done? | no | yes | no | 1 | yes |

## 5. Threshold accuracy

17 of 17 numeric questions correct (100.0%).

| ID | Machine | Question | Expected | Correct |
|---|---|---|---|---|
| GP01 | press-stamp-01 | What is the warning threshold for lube oil pressure on press-stamp-01? | Warning at or below 3.6 bar (project warn limit), evaluated on the 10 s mean. | yes |
| GP02 | press-stamp-01 | At what bearing vibration RMS value should an alarm be raised on press-stamp-01? | Alarm at or above 4.0 mm/s. | yes |
| GP03 | press-stamp-01 | Is a bearing vibration of 8.2 mm/s within the normal range for press-stamp-01? | No. Normal is about 1.0 to 1.7 mm/s (V60 1.2 to 1.45). 8.2 mm/s is above the 7.0 mm/s critical level (L4): controlled stop, check for real damage or a sensor fault. | yes |
| GP04 | press-stamp-01 | What is the critical threshold for the main motor current stroke peak on the stamping press? | Critical at or above 220 A (proposed, [I]). | yes |
| GP05 | press-stamp-01 | What is the normal operating range of lube oil pressure for press-stamp-01? | Healthy band P60 4.35 to 4.65 bar (samples 4.40 to 4.59 bar), about 4.5 bar nominal. | yes |
| GP06 | press-stamp-01 | The 10 s mean lube oil pressure on press-stamp-01 is 2.8 bar. Which level is this and what action is recommended? | 2.8 bar is at or below the 3.0 bar alarm limit and above the 2.5 bar critical limit: alarm (L3). Severe restriction; replace the filter this shift. | yes |
| GP08 | press-stamp-01 | Below what stroke peak value does the main motor current warning clear on press-stamp-01? | The warning clears when Ipk is below 170 A for 10 s. | yes |
| GP09 | press-stamp-01 | What is the watch level for the 60 s mean lube oil pressure P60 on press-stamp-01? | Watch when P60 is at or below 4.30 bar. | yes |
| GR01 | robot-weld-01 | What is the warning threshold for axis 4 servo torque on robot-weld-01? | warnHigh 26 Nm. | yes |
| GR02 | robot-weld-01 | At what torque value should an alarm be raised on robot-weld-01? | alarmHigh 30 Nm (per-cycle peak for 2 consecutive cycles under the persistence rule). | yes |
| GR03 | robot-weld-01 | Is a torque sample of 24.5 Nm within the normal range for robot-weld-01? | No. Normal is 3.1 to 23.1 Nm. 24.5 Nm falls in the watch band (23.2 to 25.9 Nm), below the 26 Nm warning. | yes |
| GR04 | robot-weld-01 | What is the proposed critical threshold for the axis 4 torque on robot-weld-01? | 34 Nm on any sample (proposed, [I]). | yes |
| GR05 | robot-weld-01 | What are the declared minimum and maximum (clamp range) of AXIS_4_SERVO_TORQUE? | min 0 Nm, max 45 Nm. | yes |
| GR06 | robot-weld-01 | What is the healthy band of the cycle mean torque M on robot-weld-01? | 12.5 to 13.5 Nm (normal range 12.7 to 13.3 Nm, healthy mean 13.0 Nm). | yes |
| GR07 | robot-weld-01 | Below what per-cycle peak value does the L2 warning clear on robot-weld-01? | Peak below 25 Nm for 2 cycles. | yes |
| GR09 | robot-weld-01 | At what fault severity r does gearbox wear start to cross the warning limit and the alarm limit on robot-weld-01? | Warn begins at r 0.48 and alarm at r 0.82. | yes |
| GR10 | robot-weld-01 | How long may an alarm persist on robot-weld-01 before it escalates to critical? | An alarm lasting more than 10 minutes escalates to critical. | yes |

## 6. Hallucination tests

10 of 10 questions with no answer in the documents were declined without an invented value (100.0%).

| ID | Machine | Question | Declined | Forbidden value given | Answer |
|---|---|---|---|---|---|
| GU01 | robot-weld-01 | What is the gear ratio of the axis 4 gearbox on robot-weld-01? | yes | no | Direct answer: The available technical documentation does not provide sufficient information to determine this. The gear ratio of the axis 4 gearbox is not specified in the repository [S5]. |
| GU02 | robot-weld-01 | Which manufacturer and model is robot-weld-01? | yes | no | Direct answer: The available technical documentation does not provide sufficient information to determine this.   The robot make and model are not specified in the repository [S1]. |
| GU03 | press-stamp-01 | What is the tonnage rating of press-stamp-01? | yes | no | Direct answer: The available technical documentation does not provide sufficient information to determine this.   The repository does not state the press make, model, tonnage, drive type, die or serial number [P]; none i |
| GU04 | press-stamp-01 | Which ISO viscosity grade of oil must be used in the lubrication circuit of press-stamp-01? | yes | no | The available technical documentation does not provide sufficient information to determine this. The repository does not specify the oil grade [S1, S2]. |
| GU05 | press-stamp-01 | What is the part number of the lube filter cartridge for press-stamp-01? | yes | no | Direct answer: The available technical documentation does not provide sufficient information to determine this. The part number of the lube filter cartridge is not specified in the repository [S4, S5]. |
| GU06 | press-stamp-01 | What is the alarm limit for oil temperature on press-stamp-01? | yes | no | Direct answer: The available technical documentation does not provide sufficient information to determine this. Oil temperature is not mentioned in the sources. |
| GU07 | robot-weld-01 | What is the alarm threshold for weld current on robot-weld-01? | yes | no | Direct answer: The available technical documentation does not provide sufficient information to determine this. The provided sources only describe torque limits for Sensor 1 and do not contain any information regarding w |
| GU08 | robot-weld-01 | After how many operating hours must the axis 4 gearbox of robot-weld-01 be relubricated? | yes | no | Direct answer: The available technical documentation does not provide sufficient information to determine this. The interval basis is OEM-specific [S1]. |
| GX01 | robot-weld-01 | What is the lube oil pressure warning threshold on robot-weld-01? | yes | no | Direct answer: The available technical documentation does not provide sufficient information to determine this. Lube oil pressure warning thresholds are not mentioned in the technical documentation. |
| GX02 | press-stamp-01 | What is the axis 4 servo torque alarm limit for press-stamp-01? | yes | no | Direct answer: The available technical documentation does not provide sufficient information to determine this. The documents do not mention an axis 4 servo torque alarm limit for press-stamp-01. |

## 7. Cross-machine isolation

100.0% of 126 queries (62 retrieval, 64 generation) retrieved chunks from the asked machine only. 0.0% of answers contained a value belonging to the other machine.

| ID | Asked machine | Question | Context from asked machine only | Other machine's value in answer | Correct |
|---|---|---|---|---|---|
| GX01 | robot-weld-01 | What is the lube oil pressure warning threshold on robot-weld-01? | yes | no | yes |
| GX02 | press-stamp-01 | What is the axis 4 servo torque alarm limit for press-stamp-01? | yes | no | yes |
| GX03 | press-stamp-01 | What are the warning thresholds for each monitored channel? | yes | no | yes |
| GX04 | robot-weld-01 | What are the warning and alarm thresholds of the monitored channel? | yes | no | yes |
| GX05 | press-stamp-01 | Vibration is rising. Which bearing-related fault should I suspect and what should I inspect? | yes | no | yes |
| GX06 | robot-weld-01 | Which lubrication-related fault should I suspect when the mean rises without ripple, and what is the corrective action? | yes | no | yes |

## 8. API usage

From `logs/api_usage.jsonl`, for the whole build and evaluation.

| Model | Requests logged | Successful | HTTP 429 | HTTP 503 | Other errors |
|---|---|---|---|---|---|
| gemini-3.5-flash-lite | 243 | 204 | 0 | 38 | 1 |
| gemini-embedding-2 | 393 | 393 | 0 | 0 | 0 |

Daily budgets configured: 350 generation requests (hard limit 500) and 800 embedding inputs (hard limit 1000). Every 503 was retried sequentially with exponential backoff. The one other error is an HTTP 400 from an unsupported config option during the first smoke test.

## 9. Caveats

- The benchmark is small and has no held-out split. The questions were written from the same PDFs by the author of the system, and the ranking weights and prompt versions were chosen while looking at these questions, so the numbers are optimistic for unseen questions.
- With 16 multi-step scenarios, one scenario is 6.25 points.
- Retrieval gold is section-level: a hit means a chunk from a section known to hold the answer, not an exact passage.
- Deterministic correctness is a required-value check. It can fail a correct answer that omits an expected value (GP10, GD10) and can pass an answer whose values are right around a wrong sentence.
- Groundedness checks numbers and citations, not prose claims.
- The judge runs on the same model that wrote the answers and agreed with every answer.

