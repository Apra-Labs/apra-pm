# apra-pm-lite

A provider-agnostic **Project Manager** skill for AI coding harnesses. One
orchestrator session drives four subagents -- `planner`, `plan-reviewer`, `doer`,
`reviewer` -- across one or more parallel git worktrees, runs each task on a
planner-chosen, complexity-matched model, and loops the plan-review and doer-review
cycles to APPROVED and a PR.

Sprint state lives in git (on each track's branch) and in a beads (`bd`) task DB.
The orchestrator and all four agents run in one session under a single provider,
sharing the local filesystem -- no server, no MCP.

## How it works

The orchestrator never writes code. It dispatches subagents and drives two loops:

```
requirements -> design -> plan (loop) -> execute (doer-review loop) -> deploy -> PR
```

- **Plan loop.** The `planner` writes `PLAN.md` (phase-ordered tasks, each with an
  assigned model); the `plan-reviewer` approves or sends it back.
- **Doer-review loop.** The `doer` implements one task at a time and stops at a
  VERIFY checkpoint with tests passing; the `reviewer` reviews the diff and approves
  or returns findings. Findings become tracked beads tasks so none are lost.
- **Model per task.** The planner assigns each task a concrete model -- a fast model
  for mechanical work, the strongest for hard design. Review and planning always run
  on the strongest model.
- **Parallel tracks.** Independent work splits into tracks, each with its own branch,
  worktree, and full pipeline, running concurrently and integrated at the end.

See `skills/pm-lite/SKILL.md` and its sub-docs (`worktrees.md`,
`doer-reviewer-loop.md`, `sprint.md`, `beads.md`) for the full workflow, and
`docs/pm-lite-direction.md` for the design intent.

## Layout

```
skills/pm-lite/     the skill (SKILL.md + sub-docs the orchestrator reads on demand)
agents/             planner, plan-reviewer, doer, reviewer definitions
install.mjs         installer: copies the skill + agents into a provider config dir
e2e/                end-to-end suite: drive the skill headless on the toy repo
docs/               design intent
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

Invoke the `pm-lite` skill in your harness and give it a requirement. It drives the
lifecycle above to a PR (or, for a local-only repo, a reviewed branch). For small,
low-risk work it uses a lightweight single-cycle path instead of the full harness.

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
as the Windows/Linux/macOS matrix (`e2e/suites.json`). CLI flags vary by tool;
override a provider's command with e.g.
`PMLITE_E2E_CMD_CLAUDE="claude -p {PROMPT} --permission-mode acceptEdits"`.

CI: `.github/workflows/pm-lite-e2e.yml` (manual trigger; needs a self-hosted runner
with the provider CLI authenticated, plus node 20+ and `bd`).

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
