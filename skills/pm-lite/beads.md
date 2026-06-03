# Beads -- the task-DB backbone

beads (`bd`) is pm-lite's tracking backbone. It holds what is in flight, what is
blocked, what was deferred, and what each review found. git holds the work (plan,
progress, review); beads holds the tracking.

## One project, one DB

An orchestrator manages one project, so there is one beads DB for that project and
one **epic per sprint**. Run `bd` from the project repo root (`bd init` once,
idempotent). Tasks reference their track via assignee or label.

## Lifecycle hooks (not optional)

The orchestrator calls `bd` at these points:

**Sprint setup** -- create the epic, reusing an existing one if present:
```
bd search "sprint: <name>" --status all   # reuse the id if found
bd create "sprint: <name>" -p 1            # else create -> <epic-id>
```

**After the plan is APPROVED** -- one task per `PLAN.md` item, dependencies wired,
the assigned model and track recorded:
```
bd create "T1.1: <title>" -p 1 --parent <epic-id> --assignee <track>   # -> task-id
bd create "T1.2: <title>" -p 2 --parent <epic-id> --assignee <track>
bd dep add <T1.2-id> <T1.1-id>             # T1.2 blocked until T1.1 done
```
Record each task's beads id in `progress.json` (`tasks[i].bead`).

**On doer dispatch** -- claim the task (check first; never steal a claimed task):
```
bd show <task-id> --json | jq -r .status   # dispatch only if "open"
bd update <task-id> --status in_progress --assignee <track>
```

**At a VERIFY checkpoint** -- close the phase's completed tasks:
```
bd close <task-id> [<task-id> ...]
bd ready                                   # confirm what is unblocked next
```

**Reviewer returns CHANGES NEEDED** -- one task per HIGH finding, assigned to the
track, so no finding is lost:
```
bd create "fix: <finding>" -p 0 --parent <epic-id> --assignee <track>
```
Close it when the reviewer clears the finding.

**At completion** -- close the epic and link the PR:
```
bd close <epic-id>
bd note <epic-id> "PR: <url>"
```

## Findings are never lost

Every HIGH review finding becomes a tracked task. MEDIUM/LOW findings and any scope
deferred mid-sprint become low-priority backlog tasks. A finding either gets fixed
(`bd close`) or is explicitly carried as backlog -- it is never dropped silently.

## Backlog

Deferred work lives as low-priority tasks under the epic, with enough detail to act
on later without re-investigation:
```
bd create "<headline>" -p 3 --parent <epic-id> --description "Impact / Source / Detail / Cost of not doing it"
```
Manage it:
```
bd list --status open --pretty     # review
bd update <id> -p 1                 # promote
bd close <id> --reason "<why>"      # retire as stale/superseded
bd dep add <id> <blocker-id>        # gate behind another item
```

## Status and recovery via beads

To see position at any time:
```
bd ready                  # everything unblocked right now, across tracks
bd list --tree <epic-id>  # full sprint tree: tasks, status, assignee
bd show <task-id>         # full context on one item
```
beads reflects orchestrator actions (claim/close), not on-disk completion -- always
confirm against `git log` and the track's `progress.json` before acting (a task
marked in_progress may be incomplete on disk if a dispatch was interrupted). See
`sprint.md` Recovery.

## Rules

- **Check before create** (epic and task) -- `bd search ... --status all`; reuse if
  found, never duplicate.
- **Check before claim** -- dispatch only if the task is `open`.
- `bd init` / `bd close` are idempotent and safe to re-run.
- Premature close -> `bd reopen <id>`.
- Never use `bd edit` -- it opens an interactive editor and blocks. Use
  `bd update --status/--assignee/--notes` inline.
