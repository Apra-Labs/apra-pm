# Apra Fleet Integration & Migration Plan

This document outlines the final steps required to finalize the `auto-sprint` and `/pm` skills' integration with the `apra-fleet` MCP architecture, addressing necessary cleanup, CLI installer upgrades, and runner hardening.

## 1. Installation Script Upgrade (`install.mjs`)
**Current state:** The skill is installed into a specific provider's directory (`.gemini`, `.claude`, etc.).
**Planned changes:** The `--llm` flag must be expanded, not removed. Users need to install the skill into their host orchestrators (AGY, Claude, OpenCode). We will update `install.mjs` to support:
- Multiple `--llm` flags (e.g., `--llm claude --llm agy`)
- Comma-separated values (e.g., `--llm claude,agy,opencode`)
- A catch-all `--llm all` option
- Ensure sandbox permissions and configurations are correctly applied across all 3 main provider directories.

## 2. Research Task: Fleet JSONL Streaming
**Current state:** `apra-fleet` currently does not stream JSONL. The E2E tests (`e2e/run-e2e.mjs`) rely on polling the disk for transcripts to validate test steps.
**Planned changes:** We will retain the transcript polling logic in `e2e/run-e2e.mjs` as a necessary testing facility for now. We are adding a research task to investigate how `apra-fleet` can eventually stream JSONL/events natively over MCP (e.g., via notifications) so we can eventually retire disk-polling in tests.

## 3. Retain E2E Result Extraction Logic
**Current state:** `e2e/extract-results.mjs` contains provider-specific logic to extract metrics correctly depending on the CLI host.
**Planned changes:** Keep this logic intact. Since `apra-fleet` is an MCP server (not an LLM replacement), tests still execute on top of the host CLIs (like `agy` or `claude`), which each emit metrics slightly differently.

## 4. Test Suite Validations (`e2e/suites.json`)
**Current state:** The E2E suites validate different combinations of skills and providers.
**Planned changes:** No deletions here. `s8` is critical for testing the core `/pm` skill on `agy`, and `s10` tests `auto-sprint` on `claude`. Both must remain intact to ensure we don't regress core functionality on any provider.

## 5. CI/CD Pipeline Retention (`.github/workflows/pm-e2e.yml`)
**Current state:** CI downloads `agy` binaries to run the test suites.
**Planned changes:** Do not remove the `agy` binaries. `apra-fleet` is merely an MCP tool server that the LLMs use; it does not provide the LLM engine itself. The CI runners still strictly require the host CLI binaries (`agy`, `claude`) to execute the E2E test suites.

## 6. Crucial `runner.js` Hardening
**Current state:** The runner has basic hardcoded MCP transport wiring (`http://127.0.0.1:7523/sse`) and lacks dynamic configuration for the fleet integration.
**Planned changes:** 
- **Dynamic Fleet URL:** Remove the hardcoded `127.0.0.1:7523` URL in `getFleetClient()`. The runner must accept the fleet MCP URL via environment variables (e.g., `APRA_FLEET_URL`) or CLI arguments to support custom ports and remote hosts.
- **Authentication/Headers:** Ensure the SSE transport can accept and pass authentication headers if the fleet server requires them.
- **Timeout & Error Handling:** Improve the transport initialization logic to fail gracefully with a descriptive error if the `apra-fleet` server is unreachable, rather than hanging the runner indefinitely.
- **Legacy Comment Cleanup:** Remove outdated comments referencing the old AGY CLI tool dispatch path, ensuring the documentation accurately reflects the direct SSE network connection to `apra-fleet`.
