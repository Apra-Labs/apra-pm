# Roadmap

A living list of where apra-pm-lite is headed. See `docs/pm-lite-direction.md` for
the design intent behind these.

## Near term

- **Smarter planner model assignment.** The planner assigns each task an exact
  model; make that choice more deliberate (cost/complexity aware) rather than a
  rough weak/mid/strong split.
- **Deploy runbook template.** A starter `deploy.md` structure for the deploy phase.
- **Per-task telemetry.** Surface tokens/cost per task from the harness's dispatch
  records into the beads task or progress.json (see below).

## Open questions

- Where the per-project beads DB lives relative to the repo and worktrees.
- Whether `design.md` is required for every full sprint or only when complexity
  warrants it.
- The exact command-verb surface and how `recover` reconstructs in-flight state
  from beads + git after a cold start.

## Later

- Broader e2e coverage across providers and the OS matrix.
- A lightweight way to inspect a running sprint's track/worktree/beads state.
