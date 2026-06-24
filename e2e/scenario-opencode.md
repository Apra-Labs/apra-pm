# pm e2e -- sprint on the toy (opencode)

Use the **pm** skill to run one sprint. Inputs the skill needs:

- **Repo:** already cloned at `{{REPO}}` (base `main`, remote `origin` -> the toy).
- **Branch:** `{{BRANCH}}`.
- **Requirement:** the top 3 ready P1 issues from `bd list --status=open --priority=1` in `{{REPO}}`.

Then run the pm commands in order: **plan** (with those P1 issues as the
requirement), **start**, **cleanup**.
