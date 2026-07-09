# Auto-Sprint Skill Architecture & Knowledge Harvest

This document archives the key architectural decisions, constraints, and gotchas discovered during the initial implementation and refactoring of the provider-agnostic `auto-sprint` skill.

## 1. Core Constraints & Philosophy

*   **Deterministic Routing (Zero LLM Orchestration Tokens):** The orchestrator (`runner.js`) is pure Node.js. It does NOT use an LLM to decide which task to run next, evaluate verdicts, or make exit/continue decisions. All control flow is determined by local shell commands (e.g., `bd` issue status) and strict JSON schema adherence.
*   **Provider-Agnostic Dispatch:** Instead of hardcoding Anthropic APIs (as done in the legacy `.claude/workflows`), all LLM interactions are dispatched via the `apra-fleet` MCP client. The runner requests generic roles (e.g., `pm-planner`, `pm-doer-std`, `pm-reviewer`), and the fleet server resolves these to specific models based on the one-time `member-setup.md` configuration.
*   **Identical Input Grammar:** The `runner.js` entry point is strictly backwards compatible with the legacy workflow, accepting the same 4 invocation forms (bare IDs, arrays, JSON objects).

## 2. Modular ES Architecture (Refactoring from Monolith)

The original legacy `auto-sprint.js` was a ~2000 line monolith. To ensure long-term testability and maintainability, this skill was architected into a modular ES architecture:
*   `runner.js`: The lightweight entry-point orchestrator that manages the state machine.
*   `lib/pure.mjs`: Contains all the pure arithmetic, token counting, bucket assignment logic, and `truncateStreakToCeiling` logic.
*   `lib/plan.js`, `lib/develop.js`, `lib/test-phase.js`, `lib/harvest.js`: Encapsulate the specific logic and prompts for each sprint phase.
*   `lib/status-server.js` & `lib/status-html.js`: Handle real-time telemetry and browser-based status reporting.

**Testing Gotcha:** Because the legacy unit tests originally ran against the monolith by hacking out a `PURE_FUNCTIONS` block via regex `eval()`, we had to patch all legacy `test/*.test.mjs` files to use standard ES native `import { ... } from 'lib/pure.mjs'`. 

## 3. Fault Tolerance & Edge Cases

Several critical fault-tolerance measures are implemented to ensure the runner never crashes blindly and always leaves the workspace in a recoverable state:
*   **Harvest Guarantee:** The `while (devIter < MAX_DEV_ITER)` loop is wrapped in a `try/catch`, guaranteeing that the `Harvest` phase executes even if the Develop phase throws a fatal exception.
*   **Crash Reporting:** The top-level IIFE catch block utilizes `safeWriteFile` to output a `crash-report.json` to the `.state/` directory before closing the status server and cleanly exiting `process.exit(1)`.
*   **Unhandled Rejections:** `process.on('unhandledRejection')` and `uncaughtException` handlers are hoisted to the module top-level to prevent silent death from floating async promises.
*   **AGY Timeout Limits:** The `truncateStreakToCeiling` logic was overridden in our runner to strictly return `[streakIds[0]]` (a hard 1-task batch limit). This is a known gotcha implemented specifically to bypass the AGY backend MCP execution limit (120 seconds) which would time out on larger batches.

## 4. Phase Workflow Summary
1.  **Setup**: Auto-detects git context, initializes `sprint-logs/`, and dispatches `setup` agent.
2.  **Plan**: Planner/reviewer loop (max 3 iterations). Generates a DAG of tasks using `bd`.
3.  **Develop**: Doer/reviewer loop (max 20 iterations). Pulls ready streaks, dispatches matching tier models based on complexity. Checks for deadlocks (`openCount > 0` but none ready) and no-progress aborts (`prevOpenIds === currentOpenIds`).
4.  **Test**: Detects `deploy.md` and `integ-test-playbook.md` purely via local `fs.existsSync`.
5.  **Harvest**: Summarizes output, updates calibration JSON, pushes dolt state, creates PR, and triggers `ci-watcher`.
