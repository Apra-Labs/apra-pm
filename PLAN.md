# PLAN.md - AGY auto-sprint skill (apra-pm-lmx)

## Context

Epic: `apra-pm-lmx`
Branch: `feat/agy-auto-sprint-skill`
Ref: `requirements.md`, `.claude/workflows/auto-sprint.js` (1946 lines), `install.mjs` (441 lines)

### Already done in install.mjs (DO NOT re-implement)
- `agyOnlyPermissions()` - returns `['Skill(auto-sprint)']`
- Step [5/5] AGY-only deploy block: `clearDir + copyDir skills/auto-sprint -> configDir/skills/auto-sprint`
- `--uninstall --llm agy` block (removes auto-sprint skill dir)
- Post-install message for AGY: shows 4 invocation forms + USP
- `providerConfig('agy')` -> `~/.gemini/antigravity-cli`

### Missing (what we must build)
1. `skills/auto-sprint/SKILL.md` - skill entry point with frontmatter + arg spec
2. `skills/auto-sprint/runner.js` - deterministic Node.js orchestrator (~450 lines)
3. `skills/auto-sprint/member-setup.md` - one-time fleet member registration guide
4. `install.mjs` gaps: verify step numbering is correct ([4/4] vs [5/5] logic), ensure
   post-message includes the 4th invocation form (`/auto-sprint ["BD-1","BD-2"]`).

---

## Phase 1 - Scaffold (mechanical)

**Goal:** Create the directory skeleton and the two prose deliverables. No logic yet.

### T1.1 - Create skills/auto-sprint/ directory and SKILL.md
- **Model:** gemini-2.5-flash
- **Acceptance criteria:**
  - File exists at `skills/auto-sprint/SKILL.md`
  - YAML frontmatter: `name: auto-sprint`, `description: <one-liner matching requirements.md>`,
    `runner: runner.js`
  - Body documents the 4 invocation forms verbatim from requirements.md Constraint 1
  - Body lists all 5 constraints in summary form (identical input grammar, same inner logic,
    zero orchestrator tokens, fleet dispatch, install.mjs integration)
  - Body has a "How it works" section: phases (Plan -> Develop -> Test -> Harvest),
    agent roster (8 agents), beads as exit signal
  - Body has a "One-time setup" section pointing to `member-setup.md`
  - Body has a "Running" section: `/auto-sprint BD-7` etc.
  - No non-ASCII characters in file
  - File is valid markdown (no broken links or unclosed code fences)

### T1.2 - Create skills/auto-sprint/member-setup.md
- **Model:** gemini-2.5-flash
- **Acceptance criteria:**
  - File exists at `skills/auto-sprint/member-setup.md`
  - Documents one-time `apra-fleet register_member` calls for each of the 6 named members:
    `pm-planner`, `pm-reviewer`, `pm-doer-cheap`, `pm-doer-std`, `pm-doer-premium`,
    `pm-harvester`
  - Each member registration block includes: name, description, suggested tags
    (e.g. `['planner']`, `['reviewer']`, `['doer']`), and a note that
    tier->model resolution is fleet server-side
  - Includes a note: "The runner selects members by fixed name -- names MUST match exactly"
  - Includes a prerequisite: apra-fleet MCP installed and at least one provider configured
  - Includes a verification step: `list_members` to confirm each member appears
  - No non-ASCII characters in file

### PHASE 1 VERIFY
- Read both files; confirm no non-ASCII; confirm frontmatter parses; confirm all 6 member
  names are present in member-setup.md; confirm 4 invocation forms appear in SKILL.md.

---

## Phase 2 - runner.js core (arg parsing, helpers, pure parsers, fleet dispatch, Plan + Develop)

**Goal:** Build the first ~250 lines of runner.js covering setup through the Develop phase.
The file must be valid Node.js (no syntax errors) when this phase ends.

### T2.1 - runner.js: file header, imports, arg parsing
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - File created at `skills/auto-sprint/runner.js`
  - Shebang: `#!/usr/bin/env node`
  - Top comment documents: purpose, constraints (zero orchestrator tokens), usage
  - `require`/`import` block: `node:child_process` (execSync), `node:fs`, `node:path`,
    `node:os`, `node:process`
  - `const { MCP } = require` or equivalent for apra-fleet MCP client (uses
    `apra-fleet` MCP tools via the runner's own tool access)
  - Arg parsing: reads `process.argv[2]` as raw args string; implements the 4 parsing
    forms from auto-sprint.js verbatim (bare ID, space/comma-separated IDs, JSON array,
    JSON object); extracts `issues`, `branch`, `goal`, `max_cycles`, `requirementsFile`,
    `base_branch` with same defaults as auto-sprint.js
  - Validates `rootIds.length > 0`; logs error and exits 1 if missing
  - `log()` function: outputs `[RUNNER] <ISO timestamp> <msg>` to stdout
  - `const TIER_CHEAP`, `TIER_STANDARD`, `TIER_PREMIUM` string constants
  - No non-ASCII characters

### T2.2 - runner.js: bd helper functions (execSync wrappers)
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - `bdExec(args, opts)` - wraps `execSync('bd ' + args, {encoding:'utf-8', ...opts})`;
    returns stdout string; throws on non-zero exit
  - `bdJson(args)` - calls `bdExec(args + ' --json')`; JSON.parse result; returns parsed
  - `bdReadyTasks()` - `bdJson('list --ready --type=task')`; returns array
  - `bdOpenCount(rootIds, threshold)` - counts open issues at/above priority threshold
    in sprint subtree; uses `bd list --status=open --json` + filter by priority
  - `shellExtract(jsonStr, extractFn)` - parse jsonStr with try/catch, call extractFn,
    return result or empty fallback
  - All functions use only `child_process.execSync` - no LLM, no MCP
  - No non-ASCII characters

### T2.3 - runner.js: port pure parsers from auto-sprint.js
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - `parseBlockers(outputs, rootCount, expectedLen, threshold, roots)` - exact port
    from auto-sprint.js; returns `{count, openIds}`
  - `parseReadyStreaks(outputs, rootCount, expectedLen, defaultModel)` - exact port
    from auto-sprint.js; returns `{totalCount, streaks}`
  - `parseCycleState(outputs, rootCount)` - exact port from auto-sprint.js; returns
    `{planDone, inProgressIds}`
  - `fitStreakToContext(streakIds, bucketById, calibration, model)` - exact port; NOTE:
    renamed from `truncateStreakToCeiling` if that name appears in auto-sprint.js -
    match the auto-sprint.js name exactly
  - `approved(review)` - returns true if `review && review.verdict === 'APPROVED'`
  - All schema constants ported:
    `REVIEW_SCHEMA`, `PLAN_REVIEW_SCHEMA`, `DOER_STATUS_SCHEMA`,
    `HARVEST_SCHEMA`, `CI_SCHEMA`, `INTEG_RUN_SCHEMA`, `SHELL_OUTPUTS_SCHEMA`
  - No non-ASCII characters

### T2.4 - runner.js: fleet dispatch wrapper with schema+retry
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - `dispatchFleet(memberName, prompt, opts)` async function:
    - Calls `apra-fleet` MCP tool `execute_prompt` with `{member: memberName, prompt}`
    - If `opts.schema` is set: appends `\nRESPOND WITH ONLY VALID JSON matching this
      schema:\n<JSON.stringify(opts.schema, null, 2)>` to the prompt
    - Retries up to 3 times on JSON parse failure; logs each retry with `log()`
    - Returns parsed JSON if schema present, raw string if not
    - Records entry in `dispatchLedger` array: `{cycle, phase, label, model, outTokens:0,
      costUsd:0}` (token counting is best-effort: use response length estimate)
    - Logs cost line: `log('[RUNNER] dispatch: <label> [<memberName>]')`
  - `dispatchShellFleet(cmds, memberName, opts)` - builds shell prompt with
    `SHELL_DISPATCH_PROMPT_HEADER` (exact string from auto-sprint.js) + numbered cmds;
    dispatches via `dispatchFleet` with `SHELL_OUTPUTS_SCHEMA`; returns parsed result
  - No non-ASCII characters

### T2.5 - runner.js: sprint state machine - setup and sprint-state file helpers
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - `readSprintState(stateFileRel)` - reads JSON from `sprint-logs/.state/<branch>.json`;
    returns null if missing
  - `writeSprintState(stateFileRel, data, phase, label)` - writes JSON to state file;
    logs with `log()`
  - `clearSprintState(stateFileRel, label)` - deletes state file; logs with `log()`
  - Setup block (runs before cycle loop):
    - Derives `repo` from `execSync('git rev-parse --show-toplevel')`
    - Auto-detects `branch` if empty: `execSync('git rev-parse --abbrev-ref HEAD')`
    - Ensures `sprint-logs/` directory exists (local `fs.mkdirSync`)
    - Builds `stateFileRel = 'sprint-logs/.state/' + branch.replace(/\//g,'_') + '.json'`
    - Reads `calibration.json` if present; falls back to embedded `DEFAULT_CALIBRATION`
      (loaded from `cost.js` via `require`)
    - Calls `writeSprintState` with `{type:'start', branch, goal, rootIds, startedAt}`
    - Dispatches `setup` agent via `dispatchFleet('pm-planner', setupPrompt, {...})`
      to ensure git branch exists and sprint-log meta line is written
  - No non-ASCII characters

### T2.6 - runner.js: Plan phase (planner + plan-reviewer loop, max 3 rounds)
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - Implements `for (let pi = 0; pi < MAX_PLAN_ITER && !planApproved; pi++)` loop
  - Planner dispatch: `dispatchFleet('pm-planner', plannerPrompt, {schema: null})`
    where `plannerPrompt` is an exact functional port of the planner prompt from
    auto-sprint.js lines ~1180-1240 (repo, branch, base_branch, rootSummary,
    requirementsFile context, planFeedback on retry, bd show/graph inspection,
    dependency wiring instructions, tier assignment instructions)
  - Plan-reviewer dispatch: `dispatchFleet('pm-reviewer', reviewPrompt,
    {schema: PLAN_REVIEW_SCHEMA})` where `reviewPrompt` is an exact functional port
    from auto-sprint.js (calibration file, sprint goals, DAG review criteria,
    bucket assignment verification)
  - On `APPROVED` verdict: sets `planApproved = true`; breaks loop
  - On `CHANGES NEEDED`: sets `planFeedback = review.notes`; calls `commitFeedback()`
    variant using fleet dispatch to write feedback.md and commit
  - On 3 rounds without approval: logs warning; sets `planApproved = true` (proceed anyway)
  - After plan approved: dispatches cost-quote using `computeSprintQuote` from cost.js
    (loaded via `require(path.join(skillDir,'cost.js'))`)
  - Writes phase checkpoint via `writeSprintState`
  - No non-ASCII characters

### T2.7 - runner.js: Develop phase (doer-review loop, max 20 dev iterations)
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - Outer `while (devIter < MAX_DEV_ITER)` loop
  - Calls `getReadyStreaks(rootIds)` equivalent using `dispatchShellFleet` + `parseReadyStreaks`
  - On `totalCount === 0`: checks for deadlock on first iteration via `countBeadsBlockers`;
    logs deadlock error if open issues > 0 but none ready; breaks
  - Per-streak: calls `truncateStreakToCeiling` (or `fitStreakToContext`); dispatches
    `dispatchFleet('pm-doer-cheap'|'pm-doer-std'|'pm-doer-premium', doerPrompt,
    {schema: DOER_STATUS_SCHEMA})` where member is chosen by streak.model tier:
    `cheap -> pm-doer-cheap`, `standard -> pm-doer-std`, `premium -> pm-doer-premium`
  - Doer null handling: resets in_progress tasks via `dispatchShellFleet` + `continue`
  - Unexpected doer status: sets `abortReason`; breaks
  - Reviewer dispatch: `dispatchFleet('pm-reviewer', reviewerPrompt,
    {schema: REVIEW_SCHEMA})` where reviewer tier = max(usedModels includes premium ?
    premium : standard) -> maps to `pm-reviewer`
  - On `CHANGES NEEDED`: sets `devFeedback`; calls fleet dispatch to commit feedback.md
  - No-progress abort: if `prevOpenIds === currentOpenIds` after cycle N > 1, sets
    `abortReason = 'no-progress'`; breaks outer cycle loop
  - Writes phase checkpoint via `writeSprintState`
  - No non-ASCII characters

### PHASE 2 VERIFY
- `node --check skills/auto-sprint/runner.js` - must exit 0 (syntax valid)
- Grep for all 6 schema names (REVIEW_SCHEMA etc.) - all must be present
- Grep for `dispatchFleet` - must appear in Plan and Develop dispatch calls
- Grep for `SHELL_DISPATCH_PROMPT_HEADER` - must appear
- Grep for non-ASCII chars - must be zero hits
- Verify `parseBlockers`, `parseReadyStreaks`, `parseCycleState` are all defined
- Verify tier->member mapping: `cheap->pm-doer-cheap`, `standard->pm-doer-std`,
  `premium->pm-doer-premium`

---

## Phase 3 - runner.js Test + Harvest phases

**Goal:** Complete runner.js with the Test and Harvest phases to reach ~450 lines total.

### T3.1 - runner.js: Test phase (deploy.md detection, integ-test dispatch)
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - Phase entered after each Develop phase (not only final cycle)
  - `deploy.md` detection: `fs.existsSync(path.join(repo, 'deploy.md'))` - local check,
    no LLM
  - `integ-test-playbook.md` detection: same pattern
  - If deploy.md exists: dispatches `dispatchFleet('pm-doer-std', deployerPrompt, {})`
    where `deployerPrompt` is a port of the deployer prompt from auto-sprint.js
    (setup/reset env, run deploy.md steps, confirm deployed)
  - If integ-test-playbook.md exists: dispatches
    `dispatchFleet('pm-doer-std', integTestPrompt, {schema: INTEG_RUN_SCHEMA})`
    (runs playbook, closes feature issues on pass, creates bug issues on fail)
  - If neither file exists: logs `"Test phase: no deploy.md or integ-test-playbook.md
    found -- skipping"` and continues
  - Writes phase checkpoint via `writeSprintState`
  - No non-ASCII characters

### T3.2 - runner.js: cycle exit gate and goal check
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - After Test phase: calls `countBeadsBlockers(threshold, rootIds)` equivalent to
    get `openCount`
  - If `openCount === 0`: sets `goalMet = true`; breaks cycle loop
  - If `cycleCount >= maxCycles`: logs "cycle ceiling reached"; breaks cycle loop
  - Else: logs `"Cycle <N> complete -- <openCount> open issue(s) remain; starting
    cycle <N+1>"` and continues
  - No-progress check (after cycle 1): compares current open IDs to `prevOpenIds`;
    if identical sets `abortReason = 'no-progress'`; breaks
  - Saves `prevOpenIds` for next cycle comparison
  - No non-ASCII characters

### T3.3 - runner.js: Harvest phase - final review, docs/CHANGELOG, beads export
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - Final review dispatch: `dispatchFleet('pm-reviewer', finalReviewPrompt,
    {schema: REVIEW_SCHEMA})` - port of auto-sprint.js final-review prompt (overall
    code quality, docs completeness, security, acceptance criteria coverage)
  - Harvester dispatch: `dispatchFleet('pm-harvester', harvesterPrompt,
    {schema: HARVEST_SCHEMA})` - port of auto-sprint.js harvester prompt
    (docs update, CHANGELOG, sprint summary, beads state export, scaffold cleanup)
  - Dolt push dispatch (non-fatal): `dispatchFleet('pm-harvester', doltPushPrompt, {})`
    - logs warning on failure; does NOT throw
  - Writes `sprint-logs/<branch>.analysis.md` using `buildSprintSummary` from cost.js
  - Calibration update: calls `computeUpdatedCalibration` from cost.js; writes result
    back to `sprint-logs/calibration.json`
  - No non-ASCII characters

### T3.4 - runner.js: PR creation and CI check
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - PR dispatch: `dispatchFleet('pm-harvester', prPrompt, {schema: {type:'object',
    required:['prNumber'], properties:{prNumber:{type:'number'},prUrl:{type:'string'}}}})` -
    port of auto-sprint.js harvest-pr prompt (gh pr create, branch/base, goal met,
    final review notes, bd memories auto-sprint for cost summary)
  - CI check dispatch: `dispatchFleet('pm-doer-cheap', ciPrompt, {schema: CI_SCHEMA})` -
    port of auto-sprint.js ci-watcher prompt (gh run list, poll, return green/red/
    not_configured)
  - On `not_configured`: dedup check via `dispatchFleet` (`bd search "Add CI pipeline"
    --status=open --json`); create CI task if not exists
  - On `red`: logs CI failure message
  - On non-green: annotates PR via `dispatchFleet('pm-doer-cheap', annotatePrompt, {})`
  - No non-ASCII characters

### T3.5 - runner.js: cost summary, state clear, return value
- **Model:** gemini-2.5-flash
- **Acceptance criteria:**
  - Cost summary block: groups `dispatchLedger` by role (`roleOf` function: strips
    `-c\d.*` suffix from label, exact port from auto-sprint.js)
  - Prints table: `log('=== Sprint cost summary (output tokens only) ===')`; per-role
    lines; TOTAL line; note about sprint log file
  - Calls `clearSprintState(stateFileRel, 'state-clear-done')`
  - Returns `{cycles: cycleCount, goalMet, goal, harvest: 'ok',
    sprintCostUsd: parseFloat(sprintTotal.toFixed(4))}`
  - Entire runner.js is syntactically valid: `node --check` exits 0
  - Total line count ~450 (acceptable range 400-550)
  - No non-ASCII characters

### PHASE 3 VERIFY
- `node --check skills/auto-sprint/runner.js` - must exit 0
- Line count: `(Get-Content skills/auto-sprint/runner.js).Count` - must be 400-550
- Grep for `Harvest`, `Test`, `Plan`, `Develop` phase strings - all 4 must appear
- Grep for `dispatchFleet` calls - must appear in all 4 phases
- Grep for `buildSprintSummary`, `computeUpdatedCalibration` - both must appear
- Grep for `clearSprintState` - must appear at end of Harvest
- Grep for non-ASCII - must be zero hits

---

## Phase 4 - install.mjs gaps + integration wiring

**Goal:** Audit and fix all install.mjs issues. No regressions to existing flows.

### T4.1 - Audit and fix install.mjs step numbering and post-message
- **Model:** gemini-2.5-pro
- **Acceptance criteria:**
  - When `--llm agy`: steps print as `[1/5]` skill, `[2/5]` agents, `[3/5]` perms,
    `[4/5]` cost.js, `[5/5]` auto-sprint skill (currently `[1/4]`...`[4/4]`+`[5/5]`
    because the non-AGY path is `[1/4]`..`[4/4]`). Fix: when `args.llm === 'agy'`,
    use `[N/5]` labels for all 5 steps.
  - Post-install message for AGY includes the 4th invocation form:
    `  /auto-sprint ["BD-1","BD-2"]` (currently missing from the agy block in install.mjs)
  - All 4 invocation forms shown:
    `  /auto-sprint BD-7`
    `  /auto-sprint BD-1 BD-2`
    `  /auto-sprint ["BD-1","BD-2"]`
    `  /auto-sprint {"issues":["BD-7"],"branch":"feat/x","goal":"P1"}`
  - Claude flow unchanged (still `[1/4]`..`[4/4]` + workflow copy)
  - No non-ASCII characters in install.mjs

### T4.2 - Verify --uninstall --llm agy removes auto-sprint skill dir
- **Model:** gemini-2.5-flash
- **Acceptance criteria:**
  - Read the `uninstall()` function in install.mjs
  - Confirm it removes `path.join(cfg.configDir, 'skills', 'auto-sprint')` for agy
  - If missing: add `if (args.llm === 'agy') { clearDir(autoSprintSkillDest); }`
    block mirroring the install step
  - `node --check install.mjs` exits 0 after any edits
  - No non-ASCII characters

### T4.3 - Verify skills/auto-sprint/ is complete and copy-ready
- **Model:** gemini-2.5-flash
- **Acceptance criteria:**
  - `skills/auto-sprint/` directory contains exactly 3 files:
    `SKILL.md`, `runner.js`, `member-setup.md`
  - No stray `.DS_Store`, `*.bak`, or temp files
  - Each file is non-empty (> 50 bytes)
  - `node --check skills/auto-sprint/runner.js` exits 0
  - `node --check install.mjs` exits 0

### PHASE 4 VERIFY
- Run `node install.mjs --help` and confirm AGY is listed
- Grep install.mjs for `[5/5]` - must appear in AGY branch
- Grep install.mjs for `auto-sprint` JSON array invocation form - must appear
- Read uninstall() - confirm auto-sprint dir removal is present for agy
- `node --check install.mjs` exits 0
- `node --check skills/auto-sprint/runner.js` exits 0

---

## Phase 5 - VERIFY (final acceptance check)

**Goal:** Cross-check all deliverables for correctness, parity with auto-sprint.js,
and compliance with all constraints. This is a READ-ONLY phase - no edits.

### T5.1 - Read and verify SKILL.md completeness
- **Model:** gemini-2.5-flash
- **Acceptance criteria:**
  - SKILL.md has valid YAML frontmatter (name, description, runner fields)
  - All 4 invocation forms present
  - Agent roster (8 agents) named: planner, plan-reviewer, doer, reviewer, deployer,
    integ-test-runner, ci-watcher, harvester
  - Phase list: Plan -> Develop -> Test -> Harvest
  - Reference to member-setup.md in "One-time setup" section
  - No non-ASCII characters (grep check)

### T5.2 - Read and verify member-setup.md completeness
- **Model:** gemini-2.5-flash
- **Acceptance criteria:**
  - All 6 member names present: `pm-planner`, `pm-reviewer`, `pm-doer-cheap`,
    `pm-doer-std`, `pm-doer-premium`, `pm-harvester`
  - Registration instructions use `apra-fleet` MCP `register_member` tool
  - Verification step present
  - No non-ASCII characters

### T5.3 - Read and verify runner.js parity with auto-sprint.js
- **Model:** gemini-2.5-pro
- **Acceptance criteria (exhaustive checklist):**
  - [ ] 4 invocation forms parsed: bare ID, space-separated, JSON array, JSON object
  - [ ] Same defaults: `goal='P1/P2'`, `max_cycles=5`, `base_branch='main'`
  - [ ] `log()` format: `[RUNNER] <ISO> <msg>`
  - [ ] PURE_FUNCTIONS loaded from cost.js via `require`
  - [ ] All 6 schema names present: REVIEW_SCHEMA, PLAN_REVIEW_SCHEMA,
        DOER_STATUS_SCHEMA, HARVEST_SCHEMA, CI_SCHEMA, INTEG_RUN_SCHEMA
  - [ ] SHELL_DISPATCH_PROMPT_HEADER exact text match
  - [ ] `parseBlockers`, `parseReadyStreaks`, `parseCycleState` all defined
  - [ ] `truncateStreakToCeiling` or `fitStreakToContext` defined
  - [ ] Sprint state machine: Plan -> Develop -> Test -> Harvest -> cycle loop
  - [ ] `MAX_PLAN_ITER = 3`, `MAX_DEV_ITER = 20`
  - [ ] Deadlock detection on devIter === 0 when open > 0
  - [ ] No-progress abort: compare prevOpenIds after cycle > 1
  - [ ] Tier->member mapping: cheap/standard/premium -> pm-doer-{cheap,std,premium}
  - [ ] deploy.md + integ-test-playbook.md detection is local fs check (no LLM)
  - [ ] `buildSprintSummary`, `computeUpdatedCalibration`, `computeSprintQuote` called
  - [ ] dispatchLedger accumulates; cost summary table printed at end
  - [ ] `clearSprintState` called at successful end
  - [ ] Return value: `{cycles, goalMet, goal, harvest, sprintCostUsd}`
  - [ ] `node --check runner.js` exits 0
  - [ ] No non-ASCII characters

### T5.4 - Read and verify install.mjs correctness
- **Model:** gemini-2.5-flash
- **Acceptance criteria:**
  - `--llm agy` path prints 5 steps: [1/5] through [5/5]
  - All 4 invocation forms in post-message
  - `--llm claude` path still prints 4 steps (unchanged)
  - `--uninstall --llm agy` removes auto-sprint skill dir
  - `agyOnlyPermissions()` present and returns `['Skill(auto-sprint)']`
  - No non-ASCII characters

### T5.5 - Final non-ASCII scan across all deliverables
- **Model:** gemini-2.5-flash
- **Acceptance criteria:**
  - Run: `Select-String -Path skills/auto-sprint/* -Pattern '[^\x00-\x7F]'` - zero matches
  - Run: `Select-String -Path install.mjs -Pattern '[^\x00-\x7F]'` - zero matches
  - If any hits found: report exact line numbers and characters; block until fixed

---

## Task summary

| Phase | Tasks | Model | Focus |
|-------|-------|-------|-------|
| Phase 1 - Scaffold | T1.1, T1.2 + VERIFY | gemini-2.5-flash | SKILL.md, member-setup.md |
| Phase 2 - runner.js core | T2.1-T2.7 + VERIFY | gemini-2.5-pro | arg parsing, helpers, parsers, fleet dispatch, Plan, Develop |
| Phase 3 - runner.js Test+Harvest | T3.1-T3.5 + VERIFY | gemini-2.5-pro (T3.5: flash) | Test, Harvest, PR, CI, cost summary |
| Phase 4 - install.mjs gaps | T4.1-T4.3 + VERIFY | gemini-2.5-pro (T4.2-4.3: flash) | step numbering, post-message, uninstall |
| Phase 5 - VERIFY | T5.1-T5.5 | gemini-2.5-flash (T5.3: pro) | full parity + compliance check |

**Total tasks:** 20 implementation tasks + 5 VERIFY checkpoints = 25 items

## Deliverables checklist

- [ ] `skills/auto-sprint/SKILL.md`
- [ ] `skills/auto-sprint/runner.js` (~450 lines, `node --check` passes)
- [ ] `skills/auto-sprint/member-setup.md`
- [ ] `install.mjs` (step numbering fixed, post-message complete, uninstall verified)
