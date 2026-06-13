# Running a Sprint

Full lifecycle for a pm sprint on a single project, driven from one session.

```
requirements -> design -> plan (loop) -> execute (doer-review loop)
             -> deploy (if applicable) -> complete -> PR
```

State lives in git (on each track's branch) and in beads. See `beads.md` for the
task-DB backbone and `worktrees.md` for
worktree mechanics.

## Sprint selection

Choose the shape before starting:

| Condition | Shape |
|-----------|-------|
| 1-3 tasks, one sitting, low risk, no phasing | Lightweight (see Lightweight sprint) |
| Work splits into independent, low-coupling units | Parallel tracks (see Parallel tracks) |
| Default | Single track, full lifecycle below |

Tightly coupled work stays a single track -- splitting it costs more coordination
than it saves.

## Setup (once per sprint)

1. Detect transport: `git -C <repo> remote` (empty => local-only). This decides the
   `<transport line>` in every dispatch prompt (see `worktrees.md`).
2. Create the beads epic for the sprint and record its id:
   `bd create "sprint: <name>" -p 1` -> `<epic-id>` (see `beads.md`).
3. Create the track worktree(s) off the base branch (one per track):
   `git -C <repo> worktree add -b <branch> <repo>-wt/<track> <base-ref>`.

## Phase 1 -- Requirements

Write `<worktree>/requirements.md` on the track branch. Quality bar: full detail
(code locations, root causes, impact), risk front-loaded (the riskiest assumption
must become Task 1 of the plan), no 2-3 line summaries. Commit it.

## Phase 2 -- Design

When the work involves non-trivial architecture, shared interfaces, or a decision
with more than one reasonable answer, write `<worktree>/design.md` capturing the
architecture and the binding decisions, and commit it. The planner consumes it and
the reviewer checks code against it. For mechanical or single-obvious-path work,
skip design and note in `requirements.md` that none was needed.

## Phase 3 -- Plan (loop)

1. Dispatch `planner` (inline, strongest model). It explores, drafts,
   self-critiques, writes `PLAN.md` with an exact `model` assigned to every work
   task, and commits.
2. Loop: dispatch `plan-reviewer` (inline, strongest model). Read the
   `feedback.md` verdict. `CHANGES NEEDED` -> dispatch `planner` to revise ->
   re-review. `APPROVED` -> continue.
3. Push the plan into beads: one task per `PLAN.md` item under the epic, with
   dependencies wired (see `beads.md`). Generate `progress.json` from `PLAN.md`
   using `tpl-progress.json` -- copy each task's assigned `model` and its beads id
   into the task entry. Commit `progress.json`. This is the living execution state.

## Phase 4 -- Execute

Run the doer-review loop in `doer-reviewer-loop.md` for each phase. For each doer
dispatch, read the next pending task's `model` from `progress.json` and dispatch
with it. Claim tasks in beads on dispatch and close them at VERIFY; turn reviewer
HIGH findings into beads tasks (see `beads.md`). Record `lastDispatchedPhase` in
`progress.json`.

## Phase 5 -- Deploy

If the project ships (not just merges), run its deployment runbook. Look for
`deploy.md` in the worktree (or repo root / `docs/`). If absent and the project
deploys, write one capturing the exact execute / verify / rollback steps and commit
it. Run each step, then the verify section. On failure, run the rollback steps and
flag the user. Deployment that needs remote machines, credentials, or shell access
beyond the local environment is out of scope for pm itself -- note it as a
manual or external step in `deploy.md`.

## Completion

When every phase (of every track) is APPROVED:

1. **Docs harvest (recommended)** -- dispatch a doer to extract durable knowledge
   (architecture, design decisions, API contracts) into `docs/`, then a reviewer to
   check it. Iterate to APPROVED.
2. **Close the epic and the delivered issues** -- `bd close <epic-id>`; also close
   any source beads issues this sprint implemented -- the ready backlog items the
   requirement was drawn from -- with `bd close <issue-id> ...`. Closing the epic
   alone leaves those open. Record the PR link on the epic once raised (see
   `beads.md`). Then **persist the closures durably**: with a db backend (e.g. dolt)
   `bd close` updates only the db and leaves `.beads/issues.jsonl` stale, so export
   the refreshed state into the track worktree and commit it on the branch --
   `bd export -o <track-worktree>/.beads/issues.jsonl` (a bare `bd export` only prints
   to stdout; you MUST pass `-o`), then commit that file in the worktree as `pm`.
   This carries the closed state into the PR regardless of backend.
3. **Clean sprint scaffolding from the PR** -- the PR's net diff must be product
   only. The tracking files (`requirements.md`, `design.md`, `PLAN.md`,
   `progress.json`, `feedback.md` -- and any case variant such as `plan.md`/
   `progress.md` the repo itself may already ship) are the inter-agent message bus,
   not product; beads holds the durable record, and they stay visible in the branch
   history as proof the loop ran. For each such file, decide by whether it existed on
   the base branch:
   - **Sprint created it** (absent on base): `git rm` it.
   - **The repo already had it** (present on base, the sprint only touched it):
     restore it to base content -- `git checkout <base> -- <file>` -- so the diff
     shows no change. Never delete a file the repo shipped.

   Commit as the orchestrator identity `pm`. Then VERIFY:
   `git diff --name-only <base>...<branch>` must list no tracking-file name in any
   case. If one remains, repeat until the net diff is product only. (Same drop the
   parallel-track flow does before integrating.)
4. **Raise the PR** -- run the PR command directly: open a PR from the (integration)
   branch to the base, then watch checks until CI is green. For a local-only sprint
   there is no PR -- report the branch and its `git diff <base>...<branch>` instead.
5. **Do NOT merge.** Surface the PR URL and CI status; await explicit user
   instruction to merge.
6. **Remove worktrees** -- `git -C <repo> worktree remove <repo>-wt/<track>` for
   each track once the PR is raised (or the branch is merged).

## Parallel tracks

Use multiple tracks when the work splits into independent, low-coupling units. Each
track runs its OWN full pipeline (`planner` -> `plan-reviewer` -> `doer` ->
`reviewer`) in its OWN worktree and branch, concurrently with the others.

1. **Contracts first.** Identify shared interfaces (APIs, data models, schemas) up
   front; write them to `contracts.md`, commit to the base branch, and base every
   track worktree on that commit. Contracts are immutable mid-sprint; if one must
   change, that track stops and the orchestrator serializes the revision (one track
   revises; dependents wait until it merges).
2. **Fan out.** Create one worktree + branch per track. Run each track's plan loop
   and execute loop independently. Dispatch one pipeline per track and poll them to
   completion within the turn -- track A's reviewer may run while track B's doer
   works -- keeping the turn alive until their results are in. In
   beads, every task carries its track (assignee or label) so the tree shows which
   track owns what.
3. **Integrate.** When a track is APPROVED, merge its branch into the integration
   base branch (never the trunk): `git -C <repo> merge <track-branch>`. Merge code
   only -- the per-track tracking files (`PLAN.md`, `progress.json`, `feedback.md`,
   `requirements.md`, `design.md`) are sprint scaffolding for that one track and stay
   on its branch. Drop them before the merge (e.g. `git rm` on the track branch, or
   resolve the merge in favour of removing them) so two tracks never collide on a
   same-named tracking file. beads holds the cross-track record, so nothing durable
   is lost. Notify dependent tracks to rebase on the updated base.
4. **Finish.** When all tracks are merged: raise one PR from the integration branch,
   confirm CI, remove all worktrees.

## Lightweight sprint

For 1-3 tasks completable in one sitting, skip the full harness:

1. Write a concise `requirements.md` on the branch and commit.
2. Create a small beads epic + a task per item.
3. Dispatch the `doer` (model sized to the work) for the task(s); it commits.
4. Dispatch the `reviewer` (strongest model); read the verdict. `CHANGES NEEDED` ->
   doer fixes -> re-review. `APPROVED` -> close the beads tasks and the delivered
   source issues, clean the sprint scaffolding from the PR (see Completion step 3 --
   `git rm` sprint-created tracking files, restore any the repo already shipped, then
   verify the net diff is product only) and commit as `pm`, raise the PR (or
   report the diff for local-only), remove the worktree.

No `PLAN.md`/`progress.json` harness; beads + git carry the state. Promote to a full
sprint if the work turns out larger than expected.

## Recovery after an orchestrator restart

State is in git and beads -- no status file, no memory. To re-orient:

1. `bd list --tree <epic-id>` (or `bd ready`) -- what is open, in progress, blocked.
   Beads reflects orchestrator actions (claim/close), not on-disk completion, so
   confirm against git next.
2. Per track worktree: `git -C <repo> log --oneline <base>..<branch>` (what is
   committed) and `cat <worktree>/progress.json` (tasks completed / pending /
   blocked, `lastDispatchedPhase`). On a track mid-review, also
   `git -C <repo> log --oneline -- feedback.md` for reviewer progress.
3. `git -C <repo> -C <worktree> status` -- uncommitted changes?

Then act:

- **VERIFY reached, no review yet** -> dispatch the reviewer now.
- **Mid-phase with commits, clear next task** -> dispatch the doer for the next
  pending task (its assigned model).
- **Idle, no progress** -> re-dispatch from the last known task.
- **Uncommitted work of unknown origin, or beads/progress.json disagree with git**
  -> STOP and flag the user; do not guess.

Each dispatch reads its context from files, so recovery is just "read git + beads,
dispatch the right next role." Every dispatch starts fresh from that state.
