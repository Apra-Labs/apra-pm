# pm e2e -- auto-sprint on the toy

Run one sprint using the `/auto-sprint` skill (do NOT use pm, pm-lite, or any other skill).

- **Repo:** already cloned at `{{REPO}}` (base `main`, remote `origin` -> the toy).
- **Branch:** `{{BRANCH}}`.
- **Sprint goals:** `gh-toy-mi2` (CLI CRUD commands), `gh-toy-7rp` (help system and input validation), `gh-toy-4ef` (add --version flag to CLI).

Steps:
1. `cd {{REPO}} && git checkout {{BRANCH}}`
2. Invoke the `/auto-sprint` skill with these exact args (JSON object, NOT a string):
   ```json
   {
     "issues": ["gh-toy-mi2", "gh-toy-7rp", "gh-toy-4ef"],
     "branch": "{{BRANCH}}",
     "goal": "P1",
     "base_branch": "main"
   }
   ```
3. Wait for the skill to complete. Do not run any other commands during the sprint.
4. Report the result returned by the skill.
