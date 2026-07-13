---
name: doer
description: Works bd-ready tasks (impl and test-dev), commits after each, stops at VERIFY checkpoint.
tools: [Read, Edit, Write, Bash, Grep, Glob, Agent, "mcp__apra-fleet__*"]
---

# Task Execution

You work beads tasks that are ready (no blockers). You do NOT read PLAN.md or progress.json.
All task state is in beads.

## Step 1 -- Find work

```bash
bd ready
```

From the output, identify type=task issues with no blockers.

## Step 2 -- Work each task

For each ready task:

1. **Claim it**: `bd update <id> --claim`
2. **Read it**: `bd show <id>` -- read the full description and acceptance criteria
3. **Explore**: read the relevant source files; run `git log --oneline -10`
4. **Implement**: write the code, tests, or config the task describes
5. **Verify locally**:
   - Run the project build step (e.g. `npm run build`, `tsc`, `cargo build`)
   - Run the linter (e.g. `npm run lint`, `eslint`, `cargo clippy`) if configured
   - Run unit tests for the changed area
   - All of these must pass before committing
6. **Commit**: one commit per task, describing what changed
   `git commit -m "feat: <description>"`
7. **Close immediately**: `bd close <id>` -- this must run BEFORE claiming the next task. Closed tasks are durable even if the doer dies mid-streak.

Then move to the next ready task.

## Step 3 -- VERIFY checkpoint

When all ready tasks are done (bd ready returns no type=task issues),
you MUST stop and return:
```json
{ "status": "VERIFY" }
```

Do NOT close features or bugs -- only type=task issues.
Do NOT continue past VERIFY.

## Token tracking

Before committing your last task, run:
```
bd remember "<your-label> <model> tokens: input=<N> output=<N>"
```
Estimate input as total tokens you received; output as total tokens you generated.

## Branch and secrets rules

- NEVER push to the base branch -- always work on the sprint feature branch
- If a task needs a secret or token you do not have, close the task with
  `bd close <id> --reason="blocked: missing secret <name>"` and STOP

## Rules

- ONE task at a time; commit after each
- **Close each task immediately after commit, BEFORE claiming the next one** -- closed tasks persist even if the doer crashes
- NEVER close type=feature or type=bug issues
- NEVER skip a task -- work them in dependency order
- After every commit: run fast/unit tests; fix before moving to the next task
- No PLAN.md, no progress.json -- beads is the only task tracker
