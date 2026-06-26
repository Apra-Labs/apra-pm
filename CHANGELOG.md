# Changelog

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
