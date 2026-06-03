# Doer-Reviewer Loop

The execute-phase loop for one track. Every dispatch is a background subagent call;
every handoff is a file committed on the track's branch; every task transition is
recorded in beads. (The plan loop that precedes this -- planner / plan-reviewer --
is in `sprint.md`.)

## The loop (per track, per phase)

```
PLAN approved, beads tasks created, progress.json written
  for each phase in PLAN.md:
    1. Claim the phase's first pending task in beads (status in_progress).
       Dispatch the doer (background) with the task's assigned model -> doer executes
       the phase's pending tasks in order, commits each, STOPS at the VERIFY checkpoint.
    2. On doer completion: read progress.json. If a task is blocked -> handle the
       blocker. Otherwise close the phase's completed tasks in beads and dispatch
       the reviewer (background, strongest model).
    3. On reviewer completion: read the feedback.md verdict.
         APPROVED       -> advance to the next phase (or Completion if last).
         CHANGES NEEDED -> create one beads task per HIGH finding (assigned to the
                           track), dispatch the doer to fix (background) -> back to
                           step 2. Close each finding task when the reviewer clears it.
  All phases APPROVED -> Completion (see sprint.md).
```

The orchestrator does nothing between a doer finishing and a reviewer starting
except read `progress.json`, update beads, and dispatch. Never pause for the user
mid-loop.

## Model per task

The planner assigned each task an exact `model` in `PLAN.md`, copied into
`progress.json`. Read the next pending task's `model` and dispatch the doer with it
verbatim. A phase may span models across its tasks; run one doer dispatch per model
streak (a run of consecutive tasks sharing a model), in dependency order. A phase
with three model groups becomes up to three doer dispatches, each on its own model.
The dispatch whose streak reaches the VERIFY task carries through it. The reviewer is
always dispatched on the strongest model available.

## Dispatch in the background

Dispatch each subagent non-blocking so the orchestrator stays responsive; the
harness re-invokes the orchestrator when the agent finishes. With multiple tracks,
fan out a batch of background dispatches (one per active track) and handle each
completion as it arrives -- track A's reviewer can run while track B's doer is
still working.

When an agent finishes, the orchestrator's FIRST action is to read state from git
and beads (`progress.json`, `feedback.md`, `git log <base>..<branch>`, `bd show`);
those are the source of truth for what was dispatched and where it landed.

## Telemetry -- token cost per dispatch

A dispatch is the metering unit: one `Agent` call runs one subagent and returns one
usage figure for everything it did (a single task or a same-model streak). When the
harness reports usage on completion, append one record to the `dispatches` ledger in
`progress.json` (see `tpl-progress.json`):

```
{ "seq": N, "role": "doer", "model": "<model>", "phase": P,
  "tasks": ["T2","T3"], "tokens": <subagent tokens>, "toolUses": <n>, "ms": <n> }
```

Cost is attributed to the dispatch (the streak), not to individual tasks -- so no
per-task dispatch overhead is needed. The three cost buckets fall out by grouping
the ledger by role: **doer** dispatches (implementation), **plan-reviewer +
reviewer** dispatches (review), and the orchestrator's own main-loop usage
(orchestration), which is not a subagent and so is tracked at the session level, not
in this ledger. If the harness does not report per-subagent usage, record what it
provides and leave the rest null.

## Per-role prompt templates

Everything the agent needs is in the prompt plus the committed files in its
worktree. Every prompt pins the worktree path. `<transport line>` is decided once
per repo (see `worktrees.md` Transport): remote present => "Push your commits." ;
local-only => "This is a local-only worktree -- commit every turn and skip pushing."

### planner

```
You are planning a track. Your worktree is <abs worktree path> on branch <branch>
(base <base>). cd there first; use absolute paths. Read requirements.md (and
design.md if present). Follow your planner instructions: explore, draft, front-load
foundations, self-critique, refine. Assign every work task the exact model to run
it on (a weaker/faster model for mechanical tasks, the strongest for hard design),
chosen from the models available in this environment, and write it as the task's
Model in PLAN.md. Commit PLAN.md to <branch>. <transport line>. The worktree and
branch already exist -- do not create or switch branches.
```

### plan-reviewer

```
You are reviewing a plan. Your worktree is <abs worktree path> on branch <branch>.
cd there; use absolute paths. Read requirements.md, design.md (if present), and
PLAN.md. Follow your plan-reviewer instructions. Overwrite feedback.md with your
verdict (APPROVED or CHANGES NEEDED) and commit it. <transport line>.
```

### doer

```
You are executing a plan. Your worktree is <abs worktree path> on branch <branch>
(base <base>). cd there; use absolute paths. Read progress.json and PLAN.md.
Execute ONLY task(s) <task scope> in phase <N>, one at a time: implement, run fast
tests after each, commit, update progress.json. If your scope reaches the phase <N>
VERIFY checkpoint, run it -- build, linter, and full test suite -- record results in
progress.json, then stop. Otherwise stop after the last task in <task scope>.
<transport line>. Do not start anything beyond <task scope>. The worktree and branch
already exist -- do not create branches.
[If fixing review findings:] feedback.md says CHANGES NEEDED. Address every HIGH
finding, annotate each fixed section in feedback.md with "Doer: fixed in commit
<sha> -- <what>", commit, then stop for re-review.
```

### reviewer

```
You are reviewing code. Your worktree is <abs worktree path> on branch <branch>
(base <base>). cd there; use absolute paths. Review all phases up to and including
phase <N> -- read PLAN.md, progress.json, requirements.md, design.md (if present),
and git diff <base>...<branch>. Run the build, linter, and full test suite. Read
the prior feedback.md history (git log -- feedback.md) so you account for how
earlier findings were addressed. Overwrite feedback.md with your verdict (APPROVED
or CHANGES NEEDED) and commit it. <transport line>.
```

## Continuity between dispatches

Each dispatch is a fresh subagent run; continuity comes from the files it reads.
Two ways to continue:

- **Default: fresh dispatch.** Dispatch a new agent of the right role; it
  reconstructs context from `progress.json`, `PLAN.md`, `feedback.md`, and
  `git log`. This is robust and the right choice across phase boundaries and role
  switches -- the agents begin with a context-recovery `git log`.
- **Tight iteration: continue the same agent.** For a quick same-worktree, same-role
  turn -- e.g. the doer addressing review findings it just produced context for --
  continue the SAME agent instance, which keeps its context. Use this within one
  worktree and one role; switch roles with a fresh dispatch.

## Safeguards

| Safeguard            | Trigger                          | Orchestrator action                                              | Limit            |
|----------------------|----------------------------------|------------------------------------------------------------------|------------------|
| Dispatch retry       | Agent errors or returns nothing  | Re-dispatch the same role fresh; after 3 fails, pause + flag user | 3 per dispatch   |
| Doer-reviewer cycle  | Reviewer returns CHANGES NEEDED  | Doer fixes, re-review; if 3 cycles leave HIGH items, pause + flag | 3 cycles/phase   |
| Zero progress        | Two fresh dispatches, no commits | Escalate to a stronger model; still stuck after the strongest => flag | 2 per model  |
| Blocked task         | progress.json task = "blocked"   | Read the blocker note; resolve if mechanical, else flag user      | --               |

Escalate to the user only after a safeguard limit trips, on a genuine requirements
ambiguity, or on a risky/irreversible action. Otherwise keep the loop running.
