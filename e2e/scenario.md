# pm-lite e2e -- drive one disciplined sprint on the toy

You are the orchestrator. Use the **pm-lite** skill to run ONE full sprint on the
repository already cloned at `{{REPO}}` (base branch `main`, remote `origin` -> the
toy), as a single track on branch `{{BRANCH}}`. Do not write code yourself -- run the
pm-lite commands below and let the skill's planner / plan-reviewer / doer / reviewer
agents do the work.

Keep it simple: run the three commands in order and keep your turn alive until each
finishes. Do not stop or wait for the user between them.

## 1. plan

Run `bd ready` in `{{REPO}}` and take the top **3 ready P1 issues**. Run the pm-lite
**plan** command with those 3 issues as the requirement (list their ids and full
text). This writes `requirements.md`, dispatches the planner, loops the plan-reviewer
to APPROVED, creates the beads epic + tasks, and writes `progress.json` -- all on
`{{BRANCH}}`.

## 2. start

Run the pm-lite **start** command to drive the doer-review loop for every phase to
APPROVED. The doer implements one task at a time and commits each; the reviewer
returns a verdict; iterate until APPROVED.

## 3. cleanup

Run the pm-lite **cleanup** command: close the beads epic and the 3 delivered issues,
drop the sprint scaffolding files, push `{{BRANCH}}` to `origin`, and raise a PR from
`{{BRANCH}}` into `main`. Do NOT merge it.

That is the whole run. Success is judged independently from the resulting branch and
PR -- a real PR with 10+ commits, the scaffolding files present in history but not in
the PR's net diff, and the 3 picked issues closed. So just run the three commands
faithfully and let the skill keep the sprint disciplined.
