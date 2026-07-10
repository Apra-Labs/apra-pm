# Apra Fleet Client SDK & Workflow Engine

This package provides the core integration layer and declarative workflow engine for interfacing with Apra Fleet grids. 

## Structure
- `src/client/`: The foundational MCP JSON-RPC transport and wrapper (`ApraFleet` API) that sends instructions to the remote grids.
- `src/workflow/`: The robust, declarative infrastructure-as-code orchestration engine.
- `src/viewer/`: A live real-time HTML dashboard tracking workflow metrics securely.
- `src/common/`: Shared utilities and helpers.
- `docs/`: In-depth architecture specifications.
- `test/`: Integration and security testing suite.

## Development

```bash
npm install
npm run test
```

## Workflows
To run custom agentic logic on the fleet, use the exported `WorkflowEngine`. Workflow files are written in pure Javascript and interact with the remote network via exposed `agent()` and `command()` functions. 

See `docs/apra-fleet-workflow-architecture.md` for more details on security vetting and JSON Schema injection rules.
