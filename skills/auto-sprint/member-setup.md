# auto-sprint member setup

One-time registration of all fleet members required by the auto-sprint runner.

## Prerequisites

- apra-fleet MCP server installed and configured
- At least one LLM provider configured in apra-fleet
- The `register_member` tool available via the apra-fleet MCP

> NOTE: The runner selects members by fixed name. Names MUST match exactly
> as listed below. Any mismatch will cause a dispatch failure.

---

## Members to register

### pm-planner

Drives the Plan phase: builds the feature+task DAG in beads, assigns tiers,
and wires dependencies. Also drives deploy setup in the Test phase.

```json
{
  "name": "pm-planner",
  "description": "Sprint planner: builds and maintains the beads feature+task DAG. Assigns tier and dependency wiring for each task. Drives deployer steps in the Test phase.",
  "tags": ["planner"]
}
```

Tier note: dispatched at premium tier (most capable model). Tier-to-model
resolution is fleet server-side; the runner never hardcodes model IDs.

---

### pm-reviewer

Validates the DAG in the Plan phase and reviews doer output in the Develop
phase. Also handles feedback.md writes and plan-commit shell steps.

```json
{
  "name": "pm-reviewer",
  "description": "Sprint reviewer: validates beads DAG quality (coverage, task size, acceptance criteria, bucket assignment). Reviews committed work from doers and returns APPROVED or CHANGES NEEDED verdicts.",
  "tags": ["reviewer"]
}
```

Tier note: dispatched at standard tier for plan review and develop review.
Escalates to premium if the doer used a premium tier task.

---

### pm-doer-cheap

Handles mechanical Develop-phase tasks: renames, config tweaks, file moves,
simple wiring.

```json
{
  "name": "pm-doer-cheap",
  "description": "Sprint doer (cheap tier): implements low-complexity beads tasks such as renames, config keys, file moves, and simple wiring. Claims tasks, implements, commits, and closes each task.",
  "tags": ["doer"]
}
```

Tier note: mapped to the cheap tier. Fleet resolves this to the least-expensive
capable model configured for your provider.

---

### pm-doer-std

Handles standard Develop-phase tasks: new functions, test suites, API endpoints,
focused refactors.

```json
{
  "name": "pm-doer-std",
  "description": "Sprint doer (standard tier): implements medium-complexity beads tasks such as new API endpoints, test suites, and focused refactors. Claims tasks, implements, commits, and closes each task.",
  "tags": ["doer"]
}
```

Tier note: mapped to the standard tier.

---

### pm-doer-premium

Handles hard Develop-phase tasks: architecture changes, multi-file design,
ambiguous requirements.

```json
{
  "name": "pm-doer-premium",
  "description": "Sprint doer (premium tier): implements high-complexity beads tasks such as architectural changes, multi-file design decisions, and ambiguous or cross-cutting requirements. Claims tasks, implements, commits, and closes each task.",
  "tags": ["doer"]
}
```

Tier note: mapped to the premium tier (most capable model).

---

### pm-harvester

Handles the Harvest phase: updates docs and CHANGELOG, opens or updates a PR,
writes sprint summary and cost analysis files to sprint-logs/.

```json
{
  "name": "pm-harvester",
  "description": "Sprint harvester: updates documentation and CHANGELOG, opens or updates a GitHub PR, and writes the sprint summary and cost analysis to sprint-logs/. Runs once per sprint after the Develop and Test phases complete.",
  "tags": ["harvester"]
}
```

Tier note: dispatched at standard tier.

---

## How to register

Use the apra-fleet MCP `register_member` tool for each member. Example for
pm-planner:

```
register_member(
  name="pm-planner",
  description="Sprint planner: builds and maintains the beads feature+task DAG...",
  tags=["planner"]
)
```

Repeat for all six members using the JSON blocks above.

---

## Verification

After registering all members, run:

```
list_members
```

Confirm that all six names appear in the output:

- pm-planner
- pm-reviewer
- pm-doer-cheap
- pm-doer-std
- pm-doer-premium
- pm-harvester

If any name is missing, re-run `register_member` for that member.