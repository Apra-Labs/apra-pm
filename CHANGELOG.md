# Changelog

## feature/enhance_parallelism -- 2026-06-26 (cycle 2)

**Sprint goal:** Doer context-limit resilience, Develop-phase progress visibility, and exit-check scoping to sprint roots. 3 sprint goals targeted; goal was not met (root feature issues remain open per sprint convention -- subtasks all closed, work is releasable).

**What was implemented:**

- `agents/doer.md` + doer dispatch prompt: JIT task close -- doer must `bd close <id>` immediately after each commit, before claiming the next task.
- `auto-sprint.js`: `truncateStreakToCeiling()` -- truncates a ready streak to the longest prefix whose summed estimated output tokens stays under `calibration.doer_token_ceiling[tier]`. Wired into the develop loop before each doer dispatch.
- `sprint-logs/calibration.json` + `DEFAULT_CALIBRATION`: `doer_token_ceiling` map keyed by tier (`cheap: 40000`, `standard: 80000`, `premium: 150000`).
- `auto-sprint.js`: doer-null recovery -- when doer returns null, orphaned in_progress tasks are reset to open and the loop retries (no abort). `MAX_DEV_ITER=20` bound prevents infinite loops.
- `auto-sprint.js`: `labelTaskIds()` helper (<=3 ids, `+Nmore`); doer/reviewer agent labels carry task ids; structured log() calls before doer dispatch (ids + est USD), at iter entry (ready count), and after reviewer verdict (APPROVED/CHANGES NEEDED + ids).
- `auto-sprint.js` + `parseBlockers()`: optional `rootIds` argument scopes exit-check open-issue counting to sprint roots only; both callsites updated.
- 6 new test files; test suite: 243 pass, 0 fail.

**Carried forward:** `apra-pm-99a` (root), `apra-pm-bdy` (root), `apra-pm-jf9` (root) -- open as feature roots per sprint convention; subtasks all closed.

Reviewed feature/enhance_parallelism against the three sprint goals (apra-pm-99a, apra-pm-bdy, apra-pm-jf9). All implementation and test subtasks are closed; the three root features remain OPEN, which is correct for an early-ended sprint (roots are type=feature and are closed by the workflow's close-sprint-goals step at sprint end, never by the doer/reviewer). Test suite: 243 pass, 0 fail. The completed work is releasable and ready to harvest.

#### Sprint cost analysis
Calibration: historical (1 sprint)   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     20,400 |     56,496 | +177% |   $0.330 |   $0.891 |
| reviewer   |      4,634 |     17,676 | +281% |   $0.079 |   $0.361 |
| overhead   |      7,150 |    105,718 | +1379% |   $0.121 |   $1.433 |
| TOTAL      |     32,184 |    179,890 | +459% |   $0.530 |   $2.684 |
True-cost estimate (output x 4x): $2.119

Outliers (>200% variance): reviewer, overhead
Calibration failures (>500%): overhead

---

## feature/enhance_parallelism -- 2026-06-26

**Sprint goal:** Reduce workflow overhead by consolidating agent dispatches, introducing parallelism at cycle boundaries, and making write-only dispatches fire-and-forget. 12 sprint goals targeted; goal was not met (one P1 epic remains open -- `apra-pm-8aq` CI-watcher parent, subtasks closed).

**What was implemented:**

- `auto-sprint.js`: Fire-and-forget `appendNewEntries` and dev-loop `commitFeedback` -- both write to disk only; all git index operations deferred to `beads-export-cleanup`.
- `auto-sprint.js`: Orphaned in-progress task resets merged into a single `dispatchShell` at cycle start.
- `auto-sprint.js`: `write-quote` + `plan-commit` replaced by one `dispatchShell` with a pre-built command list and a fixed `maxTurns` formula.
- `auto-sprint.js`: `push` + `head-sha` merged into a single `dispatchShell`; SHA addressed by fixed output index.
- `auto-sprint.js`: Cycle-start per-cycle checkpoint write and `checkCycleState` run concurrently via `parallel()`.
- `auto-sprint.js`: `calibration-update` and `close-sprint-goals` run concurrently via `parallel()` at sprint end.
- `auto-sprint.js`: `parseBlockers` / `parseReadyStreaks` given explicit `index` parameters; exit-check merged into one `dispatchShell` with fallback.
- `auto-sprint.js`: Deterministic setup steps converted to a single `dispatchShell`; free-form setup agent capped at `maxTurns: 20`.
- `auto-sprint.js`: `ci-watcher` dispatch moved post-PR; annotates PR body via `gh pr comment` when CI is not green.
- `agents/ci-watcher.md`: Reclassifies "runs exist but SHA unmatched" as `pending`, not `not_configured`.
- `agents/harvester.md`: Harvester writes sprint analysis artifact as Step 1; JS fallback writes it when harvester returns null.
- `install.mjs`: `Bash(*)` added as the first entry in `claudeOnlyPermissions()`; fire-and-forget dependency documented. Installer now exports its functions and guards `main()` with an `import.meta.url` check for testability.
- 11 new test files covering all dispatch consolidations (209 tests pass).

**Carried forward:** `apra-pm-8aq` (CI-watcher parent epic), `apra-pm-99a` (doer context-limit resilience), `apra-pm-bdy` (progress log() calls in Develop), CI pipeline issues (`apra-pm-4qg`, `apra-pm-5mk`, `apra-pm-efq`), pm-skill taxonomy epics (`apra-pm-06d`, `apra-pm-bgo`).

#### Sprint cost analysis
Calibration: defaults   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |    157,553 |   n/a |   $0.000 |   $2.118 |
| reviewer   |          0 |     35,842 |   n/a |   $0.000 |   $0.538 |
| overhead   |      7,150 |    132,681 | +1756% |   $0.121 |   $1.976 |
| TOTAL      |      7,150 |    326,076 | +4461% |   $0.121 |   $4.633 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead
