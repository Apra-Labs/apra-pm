You are an automated sprint runner. Your job is to execute one full sprint on a
fleet-e2e-toy repository using the auto-sprint workflow. Do not use the pm skill.
Do not spawn manual agents. Use only the three steps below.

Repository: {{REPO}}
Sprint branch: {{BRANCH}}

---

Step 1 - Check out the sprint branch

Run this bash command:

  git -C {{REPO}} checkout -b {{BRANCH}}

---

Step 2 - Read one open P1 issue ID

Run this bash command:

  cd {{REPO}} && bd list --status=open --priority=1

Pick only the FIRST beads ID from the output. This is the single sprint goal
the workflow will implement. Do not pass more than one ID.

---

Step 3 - Invoke the sprint workflow

Use the Workflow tool with:
  name: "auto-sprint"
  args (as a JSON object):
    branch:       "{{BRANCH}}"
    issues:       [<the single beads ID from step 2, e.g. ["BD-1"]>]
    goal:         "P1"
    base_branch:  "main"

The workflow handles everything: planning tasks in beads, implementing them,
deploying to a test environment (if deploy.md and integ-test-playbook.md exist),
updating project docs, and creating a pull request. Wait for it to complete
before doing anything else. Do not take any additional actions.
