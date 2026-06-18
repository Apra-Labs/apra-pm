# apra-pm

A provider-agnostic **Sprint Workflow** for AI coding harnesses. The `auto-sprint`
workflow drives eight specialised agents through a repeating cycle -- plan, develop,
test, deploy, integrate -- until a user-defined quality bar (zero P1 issues, zero
P1/P2 issues, etc.) is met or the cycle limit is reached.

Sprint state lives entirely in beads (`bd`). There is no PLAN.md. Beads owns all
work items (epics, features, tasks, bugs) and is the exit signal for each cycle.
The workflow is deterministic JavaScript -- no agent decides whether to continue.

## How it works

```
while (open issues above goal threshold > 0 AND cycles < max):
  Plan       -- planner (opus) creates feature+task DAG in beads
               plan-reviewer (sonnet) validates coverage and acceptance criteria
  Develop    -- doer (sonnet) works bd-ready tasks; reviewer (sonnet) approves or reopens
  Deploy     -- deployer (sonnet) follows deploy.md + integ-test-playbook.md
  Test Run   -- integ-test-runner (sonnet) closes passing features, files bugs for failures
  Teardown   -- deployer resets the test environment
  Exit check -- beads query: are open issues above threshold? same set as last cycle?

CI check (haiku, non-blocking): poll after Develop; gate before Harvest
Harvest (once): harvester (sonnet) updates docs/README/CHANGELOG and raises PR
Final review (opus): quality gate before harvest
```

Model tiers: haiku for scaffolding/queries, sonnet for development/review/testing,
opus for planning and final review only.

See `docs/sprint-workflow.md` for the full user guide: what to prepare, how to
load backlogs from GitHub Issues / Azure DevOps / Jira, deploy.md and
integ-test-playbook.md schemas, and all eight phases explained.

## Layout

```
skills/pm/               the pm skill (SKILL.md + sub-docs)
agents/                  eight sprint agent definitions
.claude/workflows/       auto-sprint.js -- deterministic Claude Code workflow
install.mjs              installer: copies skill + agents + workflow into provider config dir
e2e/                     end-to-end suite: drive the skill headless on the toy repo
docs/                    sprint-workflow.md user guide + design intent
.githooks/               pre-commit (ASCII-only guard)
```

## Install

Installs the skill, agents, and workflow into your harness's config directory.

```
node install.mjs --llm claude     # or: gemini | agy | opencode   (default: claude)
```

This writes:
- `<configDir>/skills/pm/` -- the skill
- `<configDir>/agents/*.md` -- eight agents
- `<configDir>/settings.json` -- minimal permissions (merged, non-destructive)
- `~/.claude/workflows/auto-sprint.js` -- the workflow (claude only)

Requires `git`, `gh` (GitHub CLI), and beads (`bd`) on PATH.

## Use

Trigger the `auto-sprint` workflow from a Claude Code session in the project repo:

```
/auto-sprint {"branch": "feat/auth-overhaul", "issues": ["BD-12", "BD-15"], "goal": "P1/P2"}
```

| Argument | Required | Default | Description |
|---|---|---|---|
| `branch` | yes | -- | Sprint branch. Created if it does not exist. |
| `issues` | yes | -- | Beads epic IDs to implement this sprint. |
| `goal` | no | `P1/P2` | Exit criterion: `P1`, `P1/P2`, or `P1/P2/P3`. |
| `max_cycles` | no | `5` | Hard ceiling on sprint cycles. |
| `requirementsFile` | no | -- | Additional context file for the planner. |
| `base_branch` | no | `main` | PR target branch. |

The workflow checks out or creates `branch`, verifies epics exist in beads, and
begins the sprint loop. Deploy and integration test phases require `deploy.md` and
`integ-test-playbook.md` in the project root; without them the workflow skips
those phases and proceeds directly to harvest.

## E2E

`e2e/run-e2e.mjs` clones the toy repo, renders the scenario with the repo path and
a unique branch, invokes the provider CLI headless with the skill installed, and
reads the `checkpoints.json` the orchestrator writes. The sprint runs the full
lifecycle -- it pushes the branch and raises a real PR on the toy (no merge); the
runner closes that PR and deletes the branch afterward (use `--keep-pr` to retain).

```
node install.mjs --llm claude
node e2e/run-e2e.mjs --provider claude          # all claude suites for this host OS
node e2e/run-e2e.mjs --suite s1.2               # one suite
```

Suites are grouped by provider: `s1`=Claude, `s7`=Gemini, `s8`=AGY, with `.1/.2/.3`
as the Windows/Linux/macOS matrix (`e2e/suites.json`). CLI flags vary by tool;
override a provider's command with e.g.
`PMLITE_E2E_CMD_CLAUDE="claude -p {PROMPT} --permission-mode acceptEdits"`.

Pushing the branch and opening the PR needs write access to the toy: set
`GH_TOKEN` / `E2E_GH_TOKEN`, or rely on the runner's ambient git + gh credentials.

CI: `.github/workflows/pm-e2e.yml` (manual trigger; needs a self-hosted runner
with the provider CLI authenticated, plus node 20+, `bd`, and `secrets.E2E_GH_TOKEN`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Enable the ASCII pre-commit guard once after
cloning:

```
git config core.hooksPath .githooks
```

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues
per the [Security Policy](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
