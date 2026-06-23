## apra-pm-r40 -- APPROVED

All 5 acceptance criteria are met with passing tests (tests 65-75 in the suite):
1. `computeUpdatedCalibration: populates bucket_avg_tokens for exercised buckets` covers the per-bucket average assertion with a real taskId->bucket map and doer log entries.
2. `accumulateBucketTokens: tokens split evenly across listed task IDs` covers multi-task entry token splitting.
3. `computeUpdatedCalibration: blends bucket_avg_tokens against prior history` covers the blend-across-sprints case with correct arithmetic.
4. `computeUpdatedCalibration: bucket join populated value flows into computeSprintQuote` covers the round-trip to computeSprintQuote using historical over default.
5. `computeUpdatedCalibration: no doer log entries leaves bucket_avg_tokens unchanged` covers absent-bucket fallback.

All 89 tests pass under `npm test`.

---

## apra-pm-4k0 -- CHANGES NEEDED (reopened)

File: `test/sprint-cost.test.mjs`, `buildSprintSummary` section (lines 409-530).

**Gap 1 -- AC criterion 1 missing string assertions (test line 418-430):**
The test `buildSprintSummary: returns summaryText string` asserts for header, branch name, goal text, 'MET', and suggestions section. It does NOT assert for:
- "cycles estimated X actual Y" -- the AC explicitly requires `'cycles estimated X actual Y'` in the output (implementation: `**Cycles:** estimated ${estCycles}, actual ${cycleCount}` at auto-sprint.js line 646).
- "tasks completed C open O" -- the AC explicitly requires `'tasks completed C open O'` (implementation: `**Tasks:** ${tasksCompleted} completed, ${tasksOpen} open/carried-forward` at line 647).
- The cost table header row (e.g. `| role |` or `#### Sprint cost analysis`).

Add assertions to this test (or a dedicated criterion-1 test) for these three required output fragments.

**Gap 2 -- AC criterion 4 not-met wording unasserted:**
AC criterion 4: "Goal-not-met path (epicDone=false) renders the not-met wording." Multiple tests pass `epicDone: false` (lines 447, 469, 495, 525) but none of them asserts that the string 'NOT MET' appears in `summaryText`. The implementation is correct (auto-sprint.js line 645: `${epicDone ? 'MET' : 'NOT MET'}`), but the AC requires the test to explicitly verify this path. Add: `assert.ok(summaryText.includes('NOT MET'), 'epicDone=false must render NOT MET')` to any one of the existing `epicDone: false` tests.

---

**File hygiene note (not blocking):** `feedback.md` (commit `7cf80f1`) was written by the previous reviewer cycle and is present on the branch. It is not justified by apra-pm-r40 or apra-pm-4k0 and should be removed before merge, but this is a workflow artefact issue rather than a task deliverable issue.
