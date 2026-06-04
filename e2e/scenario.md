# pm-lite e2e -- sprint on the toy

Use the **pm-lite** skill to run one sprint. Inputs the skill needs:

- **Repo:** already cloned at `{{REPO}}` (base `main`, remote `origin` -> the toy).
- **Branch:** `{{BRANCH}}`.
- **Requirement:** the top 3 ready P1 issues from `bd ready` in `{{REPO}}`.

Then run the pm-lite commands in order: **plan** (with those 3 issues as the
requirement), **start**, **cleanup**.
