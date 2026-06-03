# Roadmap

A living list of where apra-pm-lite is headed. See `docs/pm-lite-direction.md` for
the design intent behind these.

## Near term

- **Smarter planner model assignment.** The planner assigns each task an exact
  model; make that choice more deliberate (cost/complexity aware) rather than a
  rough weak/mid/strong split.
- **Agent definitions native to pm-lite.** The four agents carry phrasing from their
  origin (model tiers, push-to-remote transport). Align them with pm-lite's model
  (planner emits a concrete model; local-only worktree transport) so no dispatch
  prompt override is needed.
- **Deploy runbook template.** A starter `deploy.md` structure for the deploy phase.

## Open questions

- Where the per-project beads DB lives relative to the repo and worktrees.
- Whether `design.md` is required for every full sprint or only when complexity
  warrants it.
- The exact command-verb surface and how `recover` reconstructs in-flight state
  from beads + git after a cold start.

## Later

- Broader e2e coverage across providers and the OS matrix.
- A lightweight way to inspect a running sprint's track/worktree/beads state.
