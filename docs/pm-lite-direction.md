# pm-lite -- Direction and Design Intent

Status: direction agreed, not yet implemented. This doc is the north star for
evolving `skills/pm-lite`; it records decisions so later work does not re-litigate
them. It deliberately does not prescribe implementation detail.

## Vision

`pm-lite` plus the four agents (`planner`, `plan-reviewer`, `doer`, `reviewer`)
will **replace** the current `pm` skill. The orchestrator and all four agents run
in one session under a single provider (all Claude, or all AGY -- never mixed),
and drive a sprint through the plan-review and doer-review loops to APPROVED and a
PR. The orchestrator never writes code.

## State model -- git and beads only

There are **no orchestrator-side status files**. The `pm` skill's `status.md`
(per-project tracker) and `projects.md` (multi-project registry) are dropped
entirely. All sprint state lives in exactly two places:

- **git, on the feature branch:** `requirements.md`, `design.md`, `PLAN.md`,
  `progress.json`, `feedback.md`. These are the message bus between agents and the
  durable record of plan, progress, and review.
- **beads (`bd`):** the task database -- epic, tasks, dependencies, assignees,
  findings, backlog, PR link.

Recovery after an orchestrator restart reads from these two sources only -- never
from a status file and never from conversation memory.

## Scope -- one PM, one project

A pm-lite orchestrator manages exactly **one project**. There is no central PM
root, no portfolio view, no cross-project registry. The beads DB is therefore
per-project (lives with the project), with one epic per sprint. The multi-project
orchestration that `pm` supported is out of scope by design.

## Beads as the backbone (Group B)

beads is required, not optional. It owns all tracking that used to be split
between `status.md` and beads:

- One epic per sprint; one task per PLAN.md item, with dependencies wired.
- Lifecycle hooks: claim/in_progress on dispatch, close at VERIFY.
- **Reviewer HIGH findings become tracked tasks** assigned back to the doer, so no
  finding is lost between review and fix.
- **Backlog management:** deferred items and unaddressed MEDIUM/LOW findings become
  low-priority tasks with structured detail; re-prioritize / promote / close.
- Cross-sprint dependencies and PR linking via beads notes.
- Recovery and "what is in flight" come from `bd` queries, not a status file.

## Single-sprint completeness to build (Group A)

Bring one pm-lite sprint to full parity with pm's single-pair sprint:

- **Design phase:** a `design.md` step between requirements and plan; the planner
  consumes it and the reviewer checks code against it. (This is a git artifact on
  the branch -- consistent with the state model, not a status file.)
- **Deploy phase:** a `deploy.md` runbook with execute / verify / rollback steps.
- **Simple-sprint variant + selection:** a lightweight path for 1-3 task work that
  skips the full PLAN/progress harness, plus guidance on choosing simple vs full
  vs parallel-track.
- **Command surface:** explicit verbs (plan / start / status / resume / recover /
  deploy / backlog / cleanup) -- but every verb reads and writes state through
  beads and git, NOT a status file. `status` is a `bd` query plus `git log`;
  `recover` is `bd` plus on-disk `progress.json`/`feedback.md`.

Note: the `status.md` item from the original Group A list is **replaced** by
beads + git, not built.

## Fleet's residual role (optional, not a loop dependency)

pm-lite's core doer-review loop is fully local -- it does not depend on the fleet
skill or its MCP server for dispatch. Fleet remains available for three specific
needs, used only when a sprint requires them:

- **Secrets / credentials:** the fleet credential store for tasks that need API
  keys or tokens.
- **`execute_command`:** running a shell command on a remote member when work is
  not local.
- **`execute_prompt` on remote members or other Claude instances:** delegating to a
  worker that is not in the local session.

This residual role connects to the `enhancements/skill-reorg` branch work. It is an
optional capability layer, not the transport for the doer-reviewer loop. A sprint
that needs none of these never touches fleet.

## Explicitly dropped from pm

- `status.md` (per-project tracker) and `projects.md` (registry).
- Central PM root and multi-project management.
- Permission composition for the local loop (the harness governs local subagent
  permissions; role tool-scoping is already in the agent definitions). Permission
  handling only matters when reaching out to fleet for remote work.

## Open questions (decide before/while implementing)

- Where exactly the per-project beads DB lives relative to the repo and worktrees.
- Whether `design.md` is mandatory for every sprint or only when complexity
  warrants it (likely: required for full sprints, skipped for simple-sprints).
- Exact command-verb surface and how `recover` reconstructs in-flight state from
  beads + git after a cold start.
