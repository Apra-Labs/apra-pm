# pm-lite e2e scenario -- fleet-e2e-toy sprint

You are the orchestrator. Use the **pm-lite** skill to drive a full sprint on the
repository already cloned at `{{REPO}}` (base branch: `main`, remote `origin` ->
the toy). Run the track on branch `{{BRANCH}}`. Do not write code yourself; dispatch
the planner, plan-reviewer, doer, and reviewer subagents per the skill. Push your
work to `origin`; at the end raise a PR and do NOT merge it.

## Checkpoints

Record each checkpoint by APPENDING one JSON object per line to `checkpoints.json`
in `{{REPO}}`. Do NOT print CHECKPOINT lines as plain text -- some CLIs exit on that.

```
# unix
printf '%s\n' '{"id":"repo-setup","status":"PASS","notes":"one short note"}' >> {{REPO}}/checkpoints.json
```
```
# windows
Add-Content -Path {{REPO}}\checkpoints.json -Value '{"id":"repo-setup","status":"PASS","notes":"one short note"}'
```

Step ids in order: `repo-setup`, `discover`, `plan`, `sprint`, `verify`, `pr`,
`done`. Write `done` last. If a step fails, write that id with `"status":"FAIL"` and
a note, then stop. After each checkpoint, immediately continue to the next step.

## T1 -- repo-setup

Confirm `{{REPO}}` is on `main` with a clean tree and a working `origin` remote.
Detect the project's test/build command. -> checkpoint `repo-setup`.

## T2 -- discover

Run `bd ready` in `{{REPO}}`. Pick 3 ready P1 issues. Write `requirements.md`
capturing exactly those issues (full detail, not summaries). -> checkpoint `discover`.

## T3 -- plan

Run the pm-lite plan loop: create the track worktree for branch `{{BRANCH}}` off
`main`, dispatch the planner (which assigns a model per task), then loop the
plan-reviewer until APPROVED. Create the beads tasks from PLAN.md and generate
`progress.json`. -> checkpoint `plan`.

## T4 -- sprint

Run the doer-review loop to completion: the doer implements the planned tasks and
stops at the VERIFY checkpoint with the project's test suite passing; the reviewer
reviews the diff and returns a verdict; iterate doer<->reviewer until the reviewer
APPROVES. -> checkpoint `sprint`.

## T5 -- verify

Confirm `{{BRANCH}}` carries the committed work and the project's test suite passes
against it. -> checkpoint `verify`.

## T6 -- pr

Push `{{BRANCH}}` to `origin` and raise a pull request from `{{BRANCH}}` into `main`
(`gh pr create`). Do NOT merge it. Confirm the branch is on `origin` and the PR
exists; record the PR URL in the note. -> checkpoint `pr`, then checkpoint `done`.
