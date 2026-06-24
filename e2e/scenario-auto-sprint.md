# pm e2e -- auto-sprint on the toy

Use the **auto-sprint** workflow to run one sprint.

- **Repo:** already cloned at `{{REPO}}` (base `main`, remote `origin` -> the toy).
- **Branch:** `{{BRANCH}}`.
- **Issues:** one P1 issue -- read it from `bd list --status=open --priority=1` in `{{REPO}}`.

Check out `{{BRANCH}}` in the repo, pick the first P1 issue ID, then invoke the
auto-sprint workflow with that single issue, branch `{{BRANCH}}`, goal `P1`,
and base_branch `main`. Wait for the workflow to complete.
