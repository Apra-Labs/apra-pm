# pm -- Design Intent

The decisions behind pm's design, recorded so later work does not
re-litigate them. For how to use the skill, see `skills/pm/SKILL.md`.

## Lineage

pm descends from the fleet `pm` skill and runs the same plan -> doer -> review
workflow. The rework: it runs from a single session with local subagents and git
worktrees rather than remote members over a server, and keeps all state in git and
beads. If you know the `pm` skill, pm is its standalone, server-free successor;
this doc and the skill itself otherwise stand on their own.

## What pm is

One orchestrator session drives a project's development by dispatching four
subagents -- `planner`, `plan-reviewer`, `doer`, `reviewer` -- through the
plan-review and doer-review loops to APPROVED and a PR. The orchestrator and all
four agents run in one session under a single provider, sharing the local
filesystem. The orchestrator never writes code.

## State model -- git and beads

All sprint state lives in two places:

- **git, on each track's branch:** `requirements.md`, `design.md`, `PLAN.md`,
  `progress.json`, `feedback.md` -- the message bus between agents and the durable
  record of intent, plan, progress, and review.
- **beads (`bd`):** the task database -- epic, tasks, dependencies, assignees,
  review findings, backlog, PR link.

Recovery after a restart reads from these two sources, so a compaction or crash is
survivable: position is always re-derivable from git and beads.

## Scope -- one project per orchestrator

An orchestrator manages exactly one project. The beads DB is therefore per-project,
with one epic per sprint. This keeps the model simple: one repo, one task DB, one
sprint at a time (single or multi-track).

## Beads as the backbone

beads is required, not optional. It owns all tracking:

- One epic per sprint; one task per plan item, with dependencies wired.
- Lifecycle: claim on dispatch, close at VERIFY.
- Reviewer HIGH findings become tracked tasks assigned back to the track, so no
  finding is lost between review and fix.
- Deferred work and unaddressed MEDIUM/LOW findings become low-priority backlog
  tasks; promote / re-prioritize / close as needed.
- "What is in flight" and recovery come from `bd` queries.

## Parallelism via worktrees

A project may split into independent tracks. Each track gets its own branch and git
worktree and runs its own full pipeline (`planner` -> `plan-reviewer` -> `doer` ->
`reviewer`) concurrently with the others. Worktrees share one object database, so a
commit in one is instantly visible to the orchestrator and to other tracks. Within
a track the pipeline is sequential; across tracks everything runs in parallel. The
orchestrator fans out, drives each track's loop, and integrates the tracks at the
end.

## Model assignment

The planner assigns each task the exact model to run it on -- a weaker, faster model
for mechanical work, the strongest for high-ambiguity design -- chosen from the
models available in the current environment, and writes it into `PLAN.md`. The
orchestrator dispatches each doer with that model. The planner, plan-reviewer, and
reviewer always run on the strongest model available, since planning and review are
the quality gates. Making the planner's model choices smarter is a later refinement.

## Lifecycle

```
requirements -> design -> plan (loop) -> execute (doer-review loop)
             -> deploy (if applicable) -> complete -> PR
```

A lightweight path exists for small, low-risk work (1-3 tasks): a concise
requirements file, a small beads epic, a single doer-review cycle, no full
plan/progress harness.

## Open questions

- Whether `design.md` is mandatory for every sprint or only when complexity warrants
  it (likely: required for full sprints, skipped for lightweight ones).
- The exact command-verb surface and how `recover` reconstructs in-flight state from
  beads + git after a cold start.
