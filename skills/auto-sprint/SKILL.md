---
name: auto-sprint
description: Multi-cycle sprint workflow driven by a deterministic Node.js runner - plan, develop, test, and harvest a beads backlog without spending orchestrator tokens on routing decisions.
runner: runner.js
---

# auto-sprint

Provider-agnostic skill that runs a full sprint against a beads backlog.
All routing is deterministic Node.js. Fleet members (pre-registered once via
member-setup.md) handle the AI work. No LLM token is spent deciding which task
to run next or whether to continue.

## Invocation forms

All four forms are accepted:

```
/auto-sprint BD-7
/auto-sprint BD-1 BD-2
/auto-sprint ["BD-1","BD-2"]
/auto-sprint {"issues":["BD-7"],"branch":"feat/x","goal":"P1"}
```

The JSON object form gives full control over all parameters:

| Field            | Required | Default   | Description                                      |
|------------------|----------|-----------|--------------------------------------------------|
| issues           | yes      | -         | Array of beads issue IDs (sprint roots)          |
| branch           | yes      | -         | Sprint branch name; created if missing           |
| goal             | no       | P1/P2     | Exit criterion: P1, P1/P2, or P1/P2/P3          |
| max_cycles       | no       | 5         | Hard cycle ceiling                               |
| base_branch      | no       | main      | PR target branch                                 |
| requirementsFile | no       | (none)    | Path to extra context file for the planner       |
| skip_dolt_push   | no       | false     | Skips the bd dolt push step when true (useful for CI) |



## How it works

The runner executes one or more sprint cycles until either the goal priority
threshold is met or the max_cycles ceiling is hit.

### Phases (per cycle)

```
Plan -> Develop -> Test -> Harvest
```

- **Plan** - pm-planner builds or updates the feature+task DAG in beads;
  pm-reviewer validates DAG quality and assigns complexity buckets (S/M/L)
  and tier (cheap/standard/premium) to each task. Up to 3 rounds; proceeds
  on approval or after 3 rounds regardless.
- **Develop** - ready tasks are dispatched in tier-homogeneous streaks to the
  correct doer member (pm-doer-cheap / pm-doer-std / pm-doer-premium). After
  each streak, pm-reviewer reviews committed work. Loops until no ready tasks
  remain or MAX_DEV_ITER (20) is reached.
- **Test** - if deploy.md and integ-test-playbook.md both exist in the repo,
  pm-planner drives the deployer and integ-test-runner agents to deploy,
  execute integration tests, close features on pass, file bugs on fail, and
  teardown the environment.
- **Harvest** - pm-harvester updates docs and CHANGELOG, opens or updates a PR,
  writes a sprint summary to sprint-logs/, and returns a cost analysis.

### Agent roster (8 agents)

| Role              | Fleet member       | Tier     |
|-------------------|--------------------|----------|
| planner           | pm-planner         | premium  |
| plan-reviewer     | pm-reviewer        | standard |
| doer (cheap)      | pm-doer-cheap      | cheap    |
| doer (standard)   | pm-doer-std        | standard |
| doer (premium)    | pm-doer-premium    | premium  |
| reviewer          | pm-reviewer        | standard |
| integ-test-runner | pm-planner         | standard |
| harvester         | pm-harvester       | standard |

Beads is the exit signal. The runner never asks an LLM whether to continue;
it reads open issue counts locally with execSync.

## One-time setup

Before running the skill, register all fleet members by following:

```
skills/auto-sprint/member-setup.md
```

Prerequisites: apra-fleet MCP installed and at least one provider configured.

## Running

After member setup, invoke the skill from your chat interface:

```
/auto-sprint BD-7
/auto-sprint BD-1 BD-2
/auto-sprint ["BD-1","BD-2"]
/auto-sprint {"issues":["BD-7"],"branch":"feat/my-feature","goal":"P1"}
```

The runner prints `[RUNNER] <ISO timestamp> <msg>` progress lines to stdout
and writes a cost summary when the sprint ends.

Sprint state is checkpointed to `sprint-logs/.state/<branch>.state.json`.
If a run crashes, re-invoking with the same branch resumes from the last
good phase instead of restarting.