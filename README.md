# apra-pm-lite

A provider-agnostic **Project Manager** skill. One orchestrator session drives four
subagents -- `planner`, `plan-reviewer`, `doer`, `reviewer` -- across one or more
parallel git worktrees, runs each task on a planner-chosen, complexity-matched
model, and loops the plan-review and doer-review cycles to APPROVED and a PR.

Sprint state lives in git (on each track's branch) and in a beads (`bd`) task DB.
There is no server and no MCP -- the orchestrator and all four agents run in one
session under a single provider, sharing the local filesystem.

## Layout

```
skills/pm-lite/     the skill (SKILL.md + sub-docs the orchestrator reads on demand)
agents/             planner, plan-reviewer, doer, reviewer definitions
install.mjs         installer: copies the skill + agents into a provider config dir
e2e/                end-to-end suite: drive the skill headless on the toy repo
docs/               direction and design intent
.githooks/          pre-commit (ASCII-only guard)
```

## Install

Installs the skill and agents into your harness's config directory and grants the
minimal permissions the orchestrator needs.

```
node install.mjs --llm claude     # or: gemini | agy   (default: claude)
```

This writes:
- `<configDir>/skills/pm-lite/` -- the skill
- `<configDir>/agents/*.md` -- the four agents
- `<configDir>/settings.json` -- minimal permissions (merged, non-destructive)

Requires `git` and beads (`bd`) on PATH.

## Use

Invoke the `pm-lite` skill in your agent harness and give it a requirement. It
drives the lifecycle: requirements -> design -> plan -> execute (doer-review loop)
-> deploy (if applicable) -> PR. See `skills/pm-lite/SKILL.md` and its sub-docs.

## E2E

`e2e/run-e2e.mjs` clones the toy repo, renders the scenario with the repo path,
invokes the provider CLI headless with the skill installed, and reads the
`checkpoints.json` the orchestrator writes.

```
node install.mjs --llm claude
node e2e/run-e2e.mjs --provider claude          # all claude suites for this host OS
node e2e/run-e2e.mjs --suite s1.2               # one suite
```

Suites are grouped by provider: `s1`=Claude, `s7`=Gemini, `s8`=AGY, with `.1/.2/.3`
as the Windows/Linux/macOS matrix (`e2e/suites.json`). CLI flags vary by
tool; override a provider's command with e.g.
`PMLITE_E2E_CMD_CLAUDE="claude -p {PROMPT} --permission-mode acceptEdits"`.

CI: `.github/workflows/pm-lite-e2e.yml` (manual trigger; needs a self-hosted runner
with the provider CLI authenticated, plus node 20+ and `bd`).

## Contributing

Enable the ASCII guard once after cloning:

```
git config core.hooksPath .githooks
```
