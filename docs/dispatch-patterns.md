# auto-sprint Dispatch Patterns

Architectural decisions governing how `auto-sprint.js` dispatches agents and
shells, recorded so future contributors understand the invariants and do not
re-litigate them.

---

## Core concepts

### dispatchShell vs agent dispatch

The workflow has two dispatch modes:

- **Agent dispatch** -- dispatches a named agent (planner, doer, etc.) with a
  prompt and a model. The agent is a full LLM session that can read files,
  run tools, and reason. Use for tasks that require judgment.

- **dispatchShell(cmds, opts)** -- dispatches a Haiku agent with a
  pre-built list of shell commands and a strict `maxTurns` ceiling.
  `maxTurns` is `cmds.length + 1` by default (`shellMaxTurns(cmds)`).
  The agent runs each command in order and writes outputs. Use for
  deterministic, judgment-free operations.

**The rule:** any block of operations that can be fully pre-specified as a
list of shell commands must be a single `dispatchShell`, not multiple
sequential agent dispatches. Multiple dispatches compound context-switch
overhead and are harder to reason about for `maxTurns` budgeting.

### parallel()

`parallel([...dispatches])` runs a list of dispatches concurrently and waits
for all to complete. Use it whenever two dispatches have no data dependency
on each other. Current parallel groups:

- Cycle start: per-cycle checkpoint write + `checkCycleState` run
- Sprint end: `calibration-update` + `close-sprint-goals`

Downstream operations that depend on the parallel group's results must run
after the `await parallel(...)` call -- not inside it.

### Fire-and-forget (write-only dispatches)

Some dispatches write a single file and do not produce outputs that the
workflow reads. These must be fire-and-forget: dispatched but not awaited.

Current fire-and-forget dispatches:
- `appendNewEntries` -- flushes new sprint-log entries to disk. The file is
  later committed in `beads-export-cleanup` with an unconditional `git add
  sprint-logs/`.
- Dev-loop `commitFeedback` -- writes `feedback.md` only (no commit, no push).
  The file is evicted in `beads-export-cleanup` with `git rm -f` + `rm -f`.

**Invariant:** fire-and-forget dispatches must never commit or push. They
write to disk; the cleanup step owns all git index operations. Mixing
git operations across fire-and-forget and cleanup steps creates index races.

---

## Setup: dispatchShell for deterministic steps

The setup phase has two parts:

1. **Deterministic steps** -- branch creation/checkout, `git pull`, and other
   fixed operations are consolidated into a single `dispatchShell` (named
   `setup-shell`). Outputs are addressed by fixed index, so the workflow
   never needs to parse shell output by position guesswork.

2. **Free-form setup** -- the deployer agent reads `integ-test-playbook.md`
   and executes the `## Setup` section. This is a full agent dispatch with
   `maxTurns: 20` as a backstop (not the default `shellMaxTurns` formula,
   because the command count is not known ahead of time).

---

## Merged dispatches with strict output-index contracts

When a `dispatchShell` produces multiple outputs, every callsite must address
outputs by the exact index they were assigned at dispatch time. Implicit
positional assumptions (e.g. "second output is always headSha") are fragile.

Patterns established this sprint:

- **push + head-sha:** a single `dispatchShell` runs `git push ... && git
  rev-parse HEAD`. The SHA is always at `outputs[1]`.

- **exit-check (getReadyStreaks + countBeadsBlockers):** merged into a single
  `dispatchShell` with an explicit fallback when `outputs.length < rootCount + 2`.
  `parseBlockers` and `parseReadyStreaks` each accept explicit `index` parameters
  so callsites can be updated without hunting implicit assumptions.

- **orphan reset:** in-progress task resets at cycle start are merged into a
  single `dispatchShell([...resetCmds])`. The command list is derived from
  `inProgressIds`; `maxTurns` defaults to `shellMaxTurns(cmds)` which equals
  `inProgressIds.length + 1`. Zero in-progress tasks produces an empty array
  and no dispatch.

---

## Plan-commit: pre-built command list

`write-quote` and `plan-commit` were formerly two separate dispatches.
They are now one `dispatchShell` whose command list is pre-built in
`taskAssignments` by the planner session. This means:

- The command list is deterministic and testable before any dispatch runs.
- `maxTurns` is `planCommitCmds.length + 2` (extra turn for bd export).
- The reviewer still awaits `commitFeedback(...)` which commits and pushes
  (this is the one place a commit+push legitimately lives in a dispatch).

---

## CI watcher: post-PR placement

The `ci-watcher` dispatch was moved from its previous pre-PR position to
after the PR is created. Rationale:

- CI runs are associated with a PR number via `gh run list --pr N`.
  Without a PR the query returns an empty list, causing a false
  `not_configured` classification.
- CI annotates the PR body (via `gh pr comment`) when CI is not green,
  so the annotation target must already exist.

**Classification rule (ci-watcher.md):** if CI runs exist for the branch
but none match the current HEAD SHA, classify as `pending` (CI is running or
queued), not `not_configured`. `not_configured` means no CI runs exist at all
for the PR.

---

## Cycle-start checkpoint

The checkpoint written at the start of each cycle uses `type: 'cycle-start'`,
distinct from the one-time sprint metadata record which uses `type: 'meta'`.
Both records land in the same sprint JSONL file. Consumers that join log
entries to cycles must filter on `type` to distinguish them.

---

## Harvester: sprint analysis as Step 1

The sprint-analysis-write dispatch was removed from `auto-sprint.js`.
Instead:

- The `harvester` agent writes the analysis artifact as its **first action**
  (Step 1 of `agents/harvester.md`) before any other doc updates.
- If the harvester returns `null` (crash or timeout), the JS workflow writes
  `.analysis.md` itself via a `dispatchShell` using the pre-computed
  `analysisText`. This guarantees the artifact is always committed to the
  branch, independent of harvester success.

The analysis file path is `sprint-logs/<branch>-<timestamp>.analysis.md`.
