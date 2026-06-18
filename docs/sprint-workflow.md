# Sprint Workflow -- User Guide

A deterministic, multi-cycle sprint workflow that takes a prioritised backlog,
plans and implements work, verifies it through integration testing, and delivers
a reviewed pull request. Each cycle repeats until a user-defined quality bar is
met or the cycle limit is reached.

---

## How it works

The workflow drives eight specialised agents through a repeating loop:

```
while (open issues above goal threshold > 0):
  Plan     -- break open work into small, actionable tasks
  Develop  -- implement tasks, reviewed before merge
  Test Dev -- write integration tests for each feature, reviewed before running
  Deploy   -- bring up the test environment and deploy the build
  Test Run -- execute integration tests; close passing features, file bugs for failures
  Teardown -- reset the test environment to pristine state
  Check    -- has the goal been met? any progress since last cycle?

Harvest  -- update documentation, CHANGELOG, raise PR
```

The workflow does not write code or make decisions. It dispatches agents,
reads beads to determine progress, and routes work accordingly. All routing
is deterministic JavaScript -- no agent decides whether to continue.

---

## Key concepts

**Epic** -- a business requirement the team wants to implement. Epics come from
the backlog. One sprint may target several related epics.

**Feature** -- a concrete deliverable derived from an epic by the planner. A feature
is verifiable: integration tests either pass or fail against it.

**Task** -- the smallest unit of work assigned to a developer agent. A task belongs
to one feature and can be completed in a single agent session. Tasks can block
other tasks.

**Sprint goal** -- the exit criterion, expressed as a priority threshold:
- `P1` -- sprint exits when no P1 issues remain open
- `P1/P2` -- sprint exits when no P1 or P2 issues remain open
- `P1/P2/P3` -- tightest bar; exits only when no P1, P2, or P3 issues remain

Lower-priority issues found during testing are tracked in beads and carried
forward to a future sprint.

**Cycle** -- one full pass through the loop. A sprint may run multiple cycles
if integration testing finds defects that require further development.

---

## What teams must prepare

### 1. A beads backlog

Beads (`bd`) is the task database. All epics, features, tasks, bugs, and
enhancements live there. Before triggering a sprint, the target epics must
exist in beads with enough description that the planner can decompose them.

Minimum per epic:
- A clear title
- A description: what the feature does, who uses it, what done looks like
- A priority (P0-P4)

The planner will create features and tasks from the epic descriptions. If a
description is too thin, the plan-reviewer will send the planner back to refine.

### 2. deploy.md

A runbook describing how to deploy the build to a test environment. The workflow
follows this file step by step without making assumptions about the target -- it
could be a local Docker container, a cloud VM, or a shared test server.

Required sections:

```markdown
## Permissions

List every shell command prefix the deployer agent needs to run, one per line.
The installer reads this section and merges the entries into .claude/settings.json
before the deployer is dispatched. Without this section the agent will hit
interactive permission prompts and block the sprint.

Example:
  Bash(docker *)
  Bash(docker-compose *)
  Bash(npm run *)
  Bash(curl *)
  Bash(kubectl *)

## Deploy

Step-by-step commands to deploy the build.

## Smoke test

A single command (or URL check) that confirms the deployment is alive.
Exit 0 = healthy. Any other exit = deployment failed.

## CI

trigger: auto         # CI fires automatically on push (default)
# or:
trigger: manual
manual_command: gh workflow run ci.yml --ref <branch>
```

If CI is not configured for the project, the workflow creates a beads task
to add it and notifies the team. Setting up CI is treated as an engineering
task like any other: it has a developer and a reviewer.

### 3. integ-test-playbook.md

A runbook for the integration test environment itself -- separate from the
application deployment. Teams write this once per project; agents follow it
every cycle.

Required sections:

```markdown
## Permissions

List every shell command prefix the setup, reset, and teardown steps need,
one per line. Same format as deploy.md Permissions. Both files are merged
into .claude/settings.json before any agent runs.

Example:
  Bash(docker *)
  Bash(psql *)
  Bash(redis-cli *)

## Setup

Commands to bring the test environment up from scratch.
(Install fixtures, seed databases, start mock services, etc.)

## Reset

Commands to restore the environment to a pristine state between test cycles
without a full teardown. Faster than Setup; used on cycle 2+.

## Teardown

Commands to fully shut down and clean up the test environment.
```

If the playbook does not exist, the workflow skips the integration test phase
and proceeds to harvest. The team will not receive integration test feedback
that cycle.

### 4. .claude/settings.json permissions

The sprint workflow reads the `## Permissions` sections from both `deploy.md`
and `integ-test-playbook.md` at startup and merges them into the project's
`.claude/settings.json`. This happens before the deployer agent is dispatched,
so no interactive prompts interrupt the sprint.

If a `## Permissions` section is missing or incomplete, the deployer will
encounter permission prompts and block. The workflow will fail with a clear
message listing which commands need to be whitelisted rather than silently
waiting. Fix: add the missing entries to the `## Permissions` section and
re-trigger the sprint.

You can inspect what is currently allowed at any time:

```bash
cat .claude/settings.json | jq '.permissions.allow'
```

---

## Loading a backlog from an external system

Teams with existing backlogs in Azure DevOps, GitHub Issues, Jira, or
Bitbucket should export them to beads before triggering the sprint. Beads
is local -- it does not sync to these systems automatically.

### From GitHub Issues

```bash
# Export open issues labelled "sprint-candidate" via gh CLI, then create in beads
gh issue list --label sprint-candidate --json number,title,body,labels \
  | jq -r '.[] | "bd create --title=\"\(.title)\" --description=\"\(.body)\" --type=feature --priority=2"' \
  | bash
```

### From Azure DevOps

```bash
# Export a work item query to JSON, then map fields to beads
az boards query --wiql "SELECT [Id],[Title],[Description] FROM WorkItems WHERE [State]='Active'" \
  --output json \
  | jq -r '.workItems[] | "bd create --title=\"\(.fields["System.Title"])\" --description=\"\(.fields["System.Description"] // "")\" --type=feature --priority=2"' \
  | bash
```

### From Jira

Export a sprint or filter to CSV from Jira's export menu, then:

```bash
# With a CSV: summary,description,priority columns
tail -n +2 jira-export.csv | while IFS=, read -r summary description priority; do
  bd create --title="$summary" --description="$description" --priority=2
done
```

### From a plain list

For teams without a structured tool:

```bash
bd create --title="User can reset password via email" \
          --description="Send a time-limited reset link. Expires in 1 hour." \
          --type=feature --priority=1
```

The description is the most important field. A one-line title with no
description produces a weak plan. Invest a sentence or two per epic.

---

## Triggering a sprint

From a Claude Code session in the project repository:

```
/auto-sprint {"branch": "feat/auth-overhaul", "issues": ["BD-12", "BD-15"], "goal": "P1"}
```

| Argument | Required | Default | Description |
|---|---|---|---|
| `branch` | yes | -- | Sprint branch. Created if it does not exist. |
| `issues` | yes | -- | Beads epic IDs to implement this sprint. |
| `goal` | no | `P1/P2` | Exit criterion: `P1`, `P1/P2`, or `P1/P2/P3`. |
| `max_cycles` | no | `5` | Hard ceiling on cycles. Prevents runaway sprints. |
| `requirementsFile` | no | `requirements.md` | Additional context file for the planner. |
| `base_branch` | no | `main` | PR target branch. |

The workflow checks out or creates `branch`, verifies all referenced beads
issues exist, and begins the sprint loop.

---

## What happens in each phase

### Plan

The planner reads every open epic, feature, bug, and enhancement in beads.
Its job is decomposition: it breaks open items into tasks small enough for
a developer agent to complete in one session, wires dependencies, and ensures
every feature has both implementation tasks and integration test tasks.

The plan-reviewer critiques the breakdown -- are the tasks too large? are
acceptance criteria clear? does the plan address the open issues without
adding out-of-scope work? The loop repeats until the reviewer approves.

On cycle 2+, the planner focuses on unresolved issues from the previous cycle.
It does not re-plan completed work.

### Develop

Developer agents work through implementation tasks in dependency order.
Each agent stops at a VERIFY checkpoint when its tasks are complete and tests
pass locally. A reviewer agent inspects the diff and either approves or sends
the work back with specific findings. Tasks can only be closed by the developer;
the reviewer can reopen them.

### Test development

Integration test tasks run in parallel across features -- each feature's tests
are written independently. A reviewer agent checks the test code before any
tests execute: are the tests actually exercising the feature? do they cover
the failure cases? are they maintainable?

### Deploy

The deployer agent follows `deploy.md` to push the build to the test
environment, then confirms the smoke test passes. If the smoke test fails,
the cycle aborts with a clear error before any tests run.

### Integration test run

The test runner executes the integration tests feature by feature:
- **All tests pass** -- feature is closed in beads
- **Tests fail** -- a bug or enhancement request is created in beads with
  a priority reflecting the severity, and the feature remains open
- **Inconclusive** -- feature stays open; description is updated with findings

The test runner does not close tasks -- only features and bugs. Defects
found here flow into the next cycle's plan phase.

### Teardown

The deployer follows `integ-test-playbook.md` to clean up the test environment.
On subsequent cycles it runs `Reset` rather than a full teardown/setup to save time.

### Exit check

After teardown, the workflow queries beads for all open issues in the sprint's
scope: the original epics, their features and tasks, and any bugs or
enhancements created during testing. It filters to the goal priority threshold.

If the count hits zero, the sprint exits successfully. If the set of open
issue IDs has not changed since the previous cycle (nothing was resolved),
the sprint aborts -- something structural is blocking progress and human
attention is needed.

---

## CI integration

The workflow records the git commit SHA at the end of the Develop phase. CI
is expected to trigger automatically from the push. The workflow runs the
integration test loop while CI runs in parallel. Before harvest, the ci-watcher
polls until CI reports green.

If CI is not configured, the workflow creates a P2 beads task:
`Add CI pipeline to project`. This task enters the normal develop loop in
the next cycle and requires a reviewer like any other engineering work.

---

## What you get at the end

When the sprint goal is met:
- All targeted features are closed in beads
- A reviewed pull request is open against `base_branch`
- `docs/` is updated with architecture decisions and feature documentation
- `CHANGELOG.md` has a new entry summarising the sprint
- Scaffold files (`PLAN.md`, `progress.json`, etc.) are removed from the branch
- Token usage across all agents and cycles is summarised in the PR description

If the sprint exits via `max_cycles` without meeting the goal:
- A PR is still raised, clearly marked as partial
- All open issues remain in beads for the next sprint
- The PR description explains what was completed and what remains

---

## Cost and model usage

The workflow uses three model tiers:

| Tier | Model | Used for |
|---|---|---|
| Fast | haiku | setup, scaffolding, beads queries, CI polling |
| Standard | sonnet | development, review, testing, deployment |
| Strong | opus | planning (cycle start), final review (before harvest) |

A typical sprint with two features and one cycle runs approximately:
1 opus plan, 1 opus final review, 4-8 sonnet develop/review passes,
2-4 sonnet test/deploy passes. Token totals are tracked per agent and
per cycle in beads for cost analysis.

---

## Failure modes and what to do

| Symptom | Likely cause | Action |
|---|---|---|
| Plan loop does not converge | Epic descriptions too thin | Add detail to beads issue descriptions before re-triggering |
| Smoke test fails every cycle | Deploy steps broken | Fix `deploy.md`; test manually before re-triggering |
| Same issues open across two cycles | Defects deeper than tasks can fix | Review the open issues; consider re-scoping the epic |
| CI always red | CI config broken | Address the CI beads task first; it blocks harvest |
| `max_cycles` reached | Sprint is too large | Split the epics into smaller targeted sprints |

---

## Working with the beads backlog between sprints

Between sprints, the backlog is a live beads database. Teams can:

```bash
bd list --status=open          # see everything pending
bd list --priority=1           # P1 items only
bd show BD-42                  # inspect one issue
bd update BD-42 --priority=2   # re-prioritise
bd create --title="..."        # add new items
bd close BD-42                 # remove resolved items
```

P3/P4 items carried forward from a sprint are visible alongside new
work items. Prioritise before triggering the next sprint so the planner
has a clear signal about what matters most.
