# pm e2e -- sprint on the toy (opencode, solo mode)

You are a solo engineer implementing P1 issues directly. No fleet dispatch -- work with
bash, git, and bd only.

- **Repo:** `{{REPO}}` (cloned, git user configured, remote origin ready)
- **Branch:** `{{BRANCH}}`

## Steps (follow in order, complete all steps)

1. `cd {{REPO}} && git checkout -b {{BRANCH}}`

2. **Pick issues:** `bd ready` -- take ALL open P1 issues shown (there may be 1-3).
   Use `bd show <id>` on each to read the requirements.

3. **Requirements commit:**
   Write `requirements.md` summarising the P1 issues and their acceptance criteria.
   `git add requirements.md && git commit -m "requirements: P1 sprint"`

4. **Plan tasks in beads:**
   Run `bd list --type=epic --status=open` to find open epics.
   Create at least 5 concrete implementation tasks:
   ```
   bd create --title="<task name>" --type=task --priority=1 --description="<what to implement>"
   ```
   Record the task IDs for use in step 5.

5. **Implement (10+ commits):**
   For each task: implement the code, commit it, then close the task:
   ```
   git add <files> && git commit -m "feat: <task description>"
   bd close <task-id>
   ```
   One commit per task minimum. Target 10+ total commits.

6. **Export beads state:**
   ```
   bd export -o {{REPO}}/.beads/issues.jsonl
   git add .beads/issues.jsonl && git commit -m "chore: update beads sprint state"
   ```

7. **Review commit:**
   Write `feedback.md` with verdict APPROVED covering each implemented task.
   `git add feedback.md && git commit -m "review: APPROVED"`

8. **Clean up scaffolding:**
   ```
   git rm requirements.md feedback.md
   git commit -m "chore: remove sprint scaffolding"
   ```

9. **Push and PR:**
   ```
   git push -u origin {{BRANCH}}
   gh pr create -B main -t "Sprint: P1 CLI features" -b "Implements open P1 issues"
   ```

## Rules

- Do NOT use fleet dispatch tools (execute_prompt, send_files, etc.) -- they are not available.
- Work directly in the repo with bash tools.
- All 10+ implementation commits must be on `{{BRANCH}}` and pushed before creating the PR.
- requirements.md and feedback.md must appear in intermediate commits AND be removed before the PR push (step 8 does this).
- .beads/issues.jsonl must be committed with closed issue status (step 6 does this).
