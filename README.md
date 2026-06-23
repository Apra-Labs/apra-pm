# apra-pm

A project management package for AI coding harnesses. It ships two complementary
surfaces that share the same eight agents:

| Surface | Provider | Entry point | State store |
|---|---|---|---|
| **`pm` skill** | Any (Claude, AGY, OpenCode, Gemini, ...) | `/pm` in your harness | beads + git |
| **`auto-sprint` workflow** | Claude Code only | `/auto-sprint` in Claude Code | beads (no PLAN.md) |

The `pm` skill is the provider-agnostic path: invoke it in any harness and it
drives the full plan -> develop -> harvest lifecycle via natural language.

The `auto-sprint` workflow is Claude-only and fully deterministic: a JavaScript
loop drives eight agents through repeating cycles until a user-defined quality
bar (zero P1 issues, zero P1/P2 issues, etc.) is met or the cycle limit is reached.
No agent ever decides whether to continue -- all routing is in the workflow script.

## auto-sprint (Claude Code)

```
while (open issues above goal threshold > 0 AND cycles < max):
  Plan       -- planner (opus) decomposes epics into a feature+task DAG in beads
               plan-reviewer validates coverage, acceptance criteria, and assigns
               a complexity bucket (S/M/L) and model to every task
  Develop    -- doer works bd-ready tasks on the model the planner assigned;
               reviewer approves or reopens (reviewer model >= sonnet)
  Deploy     -- deployer follows deploy.md + integ-test-playbook.md
  Test Run   -- integ-test-runner closes passing features, files bugs for failures
  Teardown   -- deployer resets the test environment
  Exit check -- beads query: are open issues above threshold? same set as last cycle?

CI check (haiku, non-blocking): polls after Develop; gates before Harvest
Harvest (once): harvester updates docs/CHANGELOG and raises PR
```

### Cost estimation and calibration

After the plan is approved, the workflow produces a cost quote for the sprint --
three scenarios (optimistic / expected / pessimistic) -- using per-task complexity
buckets and the model each task was assigned. All arithmetic is pure JavaScript;
no agent does any calculation.

At sprint end, actual token spend (from the durable sprint log) is compared against
the quote and written to CHANGELOG. The harvester then updates
`sprint-logs/calibration.json` with rolling-average actuals, so each successive
sprint produces tighter estimates. The calibration loop targets +-50% accuracy;
500%+ deviation triggers a calibration failure flag.

Model prices used for estimation: haiku $5/M, sonnet $15/M, opus $25/M output tokens.

Sprint logs are durable per-branch outputs named
`sprint-logs/<branch>-<yyyymmdd_hhmmss>.jsonl` and are never deleted.

See `docs/sprint-workflow.md` for the full user guide.

## pm skill (all providers)

The `pm` skill drives the same agents via natural language from any harness.
See `skills/pm/SKILL.md` and its sub-docs for the full workflow.

## Layout

```
skills/pm/               the pm skill (SKILL.md + sub-docs)
agents/                  eight sprint agent definitions (shared by both surfaces)
.claude/workflows/       auto-sprint.js -- deterministic Claude Code workflow
lib/                     sprint-cost.mjs -- testable cost arithmetic module
test/                    sprint-cost.test.mjs -- 45 unit tests (npm test)
sprint-logs/             calibration.json + per-sprint JSONL cost logs (durable)
install.mjs              installer: copies skill + agents + workflow into provider config dir
e2e/                     end-to-end suite: drive the skill headless on the toy repo
docs/                    sprint-workflow.md user guide + design intent
.githooks/               pre-commit (ASCII-only guard)
```

## Install

Installs the skill, agents, and (for Claude) the workflow into your harness config.

```
node install.mjs --llm claude     # or: gemini | agy | opencode   (default: claude)
```

This writes:
- `<configDir>/skills/pm/` -- the pm skill
- `<configDir>/agents/*.md` -- eight agents
- `<configDir>/settings.json` -- minimal permissions (merged, non-destructive)
- `~/.claude/workflows/auto-sprint.js` -- the auto-sprint workflow (claude only)

Requires `git`, `gh` (GitHub CLI), and beads (`bd`) on PATH.

## Use

**Claude Code** -- trigger the deterministic multi-cycle workflow:

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

Deploy and integration test phases require `deploy.md` and `integ-test-playbook.md`
in the project root; without them the workflow skips those phases and proceeds
directly to harvest.

**Other providers** -- invoke the pm skill:

```
/pm implement the auth overhaul epic (BD-12, BD-15) on branch feat/auth-overhaul
```

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
