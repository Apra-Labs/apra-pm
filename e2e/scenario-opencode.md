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

4. **Plan commit:**
   Write `plan.md` with 10 concrete implementation tasks.
   Write `progress.json` tracking those tasks (all status=pending initially).
   `git add plan.md progress.json && git commit -m "plan: P1 sprint"`

5. **Implement (10+ commits):**
   Complete each of the 10 tasks with real code changes. One commit per task minimum.
   Update `progress.json` as tasks complete and commit the update with each task commit.
   Target: `git commit -m "feat: <task description>"` x10+.

6. **Review commit:**
   Write `feedback.md` with verdict APPROVED covering each implemented task.
   `git add feedback.md && git commit -m "review: APPROVED"`

7. **Close issues:**
   `bd close <id1> <id2> ...` for every P1 issue you worked on.

8. **Clean up scaffolding:**
   The process files are scaffolding only -- remove them before the final push:
   ```
   git rm requirements.md plan.md progress.json feedback.md
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
- requirements.md, plan.md, progress.json, feedback.md must appear in intermediate commits AND be removed before the PR push (step 8 does this).
