APPROVED

## Plan Review: skills/auto-sprint sprint (apra-pm-lmx)

Overall verdict: APPROVED. The plan is well-structured, covers all requirements, and
has no blocking defects. Two minor wording issues are noted below; neither blocks
execution but should be corrected by the doer in-place.

---

## Criterion-by-criterion findings

### 1. COVERAGE [PASS]
All 4 deliverables from requirements.md Deliverables section are addressed:
- SKILL.md -> T1.1
- runner.js -> T2.1-T2.7, T3.1-T3.5
- member-setup.md -> T1.2
- install.mjs gaps -> T4.1, T4.2, T4.3

All 5 Constraints from requirements.md are addressed:
- Constraint 1 (identical input grammar): T2.1 (arg parsing), T5.3 checklist
- Constraint 2 (same inner logic): T2.3-T2.7, T3.1-T3.5, T5.3
- Constraint 3 (zero orchestrator tokens): T2.4 (pure JS dispatch), T2.2 (bd helpers)
- Constraint 4 (fleet dispatch, no model IDs): T2.4, T2.7 (tier->member mapping)
- Constraint 5 (install.mjs integration): T4.1, T4.2, T4.3

### 2. PARITY [PASS with minor note]

Phase order Plan->Develop->Test->Harvest: present (T2.6, T2.7, T3.1, T3.3).

All 6 schema names present in T2.3:
  REVIEW_SCHEMA, PLAN_REVIEW_SCHEMA, DOER_STATUS_SCHEMA,
  HARVEST_SCHEMA, CI_SCHEMA, INTEG_RUN_SCHEMA. [PASS]

SHELL_DISPATCH_PROMPT_HEADER: present in T2.4 acceptance criteria. [PASS]

deploy.md + integ-test-playbook.md detection via fs.existsSync: T3.1. [PASS]

No-progress abort: present in T2.7 and T3.2. [PASS - see note N1 below]

Cost summary table: T3.5 (dispatchLedger grouping, per-role lines, TOTAL). [PASS]

fitStreakToContext / truncateStreakToCeiling: MINOR WORDING ISSUE (see N2 below).

buildSprintSummary, computeUpdatedCalibration, computeSprintQuote: T3.3, T3.5. [PASS]

### 3. SIZING [PASS]
All tasks are completable in one doer turn. The largest task (T2.7, Develop phase)
is bounded by a clear scope: one phase, one while-loop, ~100 lines. T3.5 is
appropriately assigned flash. No trivially small tasks.

### 4. DEPENDENCIES [PASS]
VERIFY checkpoints at end of each phase: Phase 1, 2, 3, 4, 5. [PASS]
Phase N tasks do not reference Phase N+1 outputs. T2.x tasks only consume what
prior T2.x tasks produce. T3.x consume T2.x runner.js skeleton. [PASS]

### 5. MODEL ASSIGNMENT [PASS]
- Flash: T1.1 (scaffold), T1.2 (scaffold), T3.5 (cost summary - mechanical port),
  T4.2 (audit/verify), T4.3 (audit/verify), T5.1, T5.2, T5.4, T5.5
- Pro: T2.1-T2.7 (arg parsing, parsers, fleet dispatch, Plan, Develop),
  T3.1-T3.4 (Test, Harvest, PR, CI), T4.1 (step numbering fix), T5.3 (parity check)
Assignments are appropriate.

### 6. NO DUPLICATION [PASS]
PLAN.md correctly lists what is already in install.mjs under "Already done - DO NOT
re-implement": agyOnlyPermissions(), [5/5] AGY deploy block, uninstall block,
post-install message, providerConfig('agy'). Tasks T4.1-T4.3 are scoped only to
the confirmed gaps (step label inconsistency, missing JSON array invocation form).

Confirmed gaps are real (verified against install.mjs):
- Step labels: [1/4]...[4/4] then [5/5] for AGY path (T4.1 fixes to [1/5]...[5/5])
- Missing invocation form in AGY post-message: ["BD-1","BD-2"] absent (T4.1 adds it)
- Uninstall already handles AGY (install.mjs:207-213) -> T4.2 is a verify-only task [OK]

### 7. NO NON-ASCII [PASS]
Select-String scan of PLAN.md for [^\x00-\x7F] -> zero matches. [PASS]

---

## Notes (non-blocking)

N1 - No-progress abort split across T2.7 and T3.2:
  T2.7 mentions "No-progress abort: if prevOpenIds === currentOpenIds after cycle N>1".
  T3.2 also describes "No-progress check (after cycle 1): compares current open IDs".
  In auto-sprint.js the comparison happens at the cycle level after the Test phase,
  not inside the Develop loop. The doer should implement it once in T3.2 (cycle exit
  gate) and the T2.7 reference should be treated as context only. The PHASE 2 VERIFY
  does not check for this function, so there is no risk of a false-pass; the PHASE 3
  VERIFY grep for "no-progress" will catch omission. No task change needed.

N2 - fitStreakToContext vs truncateStreakToCeiling wording in T2.3:
  T2.3 acceptance criteria say: "fitStreakToContext(...) -- exact port; NOTE: renamed
  from truncateStreakToCeiling if that name appears in auto-sprint.js".
  Verified: auto-sprint.js defines ONLY truncateStreakToCeiling (line 925); there is
  no fitStreakToContext anywhere in the file. The wording is inverted: the function
  to port is truncateStreakToCeiling, not fitStreakToContext. The doer should use
  truncateStreakToCeiling as the canonical name. Requirements.md mentions both names
  (Constraint 2) so using truncateStreakToCeiling satisfies the requirement.
  The T5.3 checklist correctly says "truncateStreakToCeiling or fitStreakToContext"
  which is permissive enough. Risk is low; the doer will read auto-sprint.js directly.

N3 - Claude post-message missing JSON array form (existing gap, not a plan gap):
  install.mjs Claude block (lines 475-477) also does not show the JSON array form
  but the requirements.md and PLAN.md scope fix only to the AGY block. This is
  out of scope for this sprint and the plan correctly ignores it.

---

## Summary

The plan is complete, well-scoped, and internally consistent. The two wording notes
(N1, N2) are informational and do not require plan changes. Proceed to execution.