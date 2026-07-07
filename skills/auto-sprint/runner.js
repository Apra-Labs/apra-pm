#!/usr/bin/env node
// skills/auto-sprint/runner.js
//
// Deterministic Node.js orchestrator for the auto-sprint AGY skill.
//
// Purpose:
//   Drive a full beads sprint (Plan -> Develop -> Test -> Harvest) using
//   apra-fleet MCP members. All routing decisions are pure JS; no orchestrator
//   token is spent on deciding which task to run next, evaluating verdicts, or
//   determining exit conditions.
//
// Constraints:
//   1. Zero orchestrator tokens: loop is pure Node.js (execSync for beads reads).
//   2. Fleet dispatch: every AI step calls execute_prompt on a named fleet member.
//   3. Same input grammar as .claude/workflows/auto-sprint.js (4 invocation forms).
//   4. Same schema names and phase order as auto-sprint.js.
//   5. Structured output: every JSON dispatch appends schema block, retries 3x.
//
// Usage (invoked by AGY skill runner with process.argv[2] = raw args string):
//   node runner.js "BD-7"
//   node runner.js "BD-1 BD-2"
//   node runner.js '["BD-1","BD-2"]'
//   node runner.js '{"issues":["BD-7"],"branch":"feat/x","goal":"P1"}'

'use strict';

const { execSync }  = require('node:child_process');
const fs            = require('node:fs');
const path          = require('node:path');
const os            = require('node:os');
const process       = require('node:process');

// ---------------------------------------------------------------------------
// Fleet MCP client reference.
// The apra-fleet MCP server exposes execute_prompt. In the AGY skill runtime
// this runner is invoked as a subprocess; fleet calls are made via the MCP
// tool interface exposed to the runner process. Since the runner is a plain
// Node.js script (not an AGY agent), it delegates fleet calls through the
// call_mcp_tool helper below using the apra-fleet server name directly.
// ---------------------------------------------------------------------------
const FLEET_SERVER  = 'apra-fleet';
const FLEET_TOOL    = 'execute_prompt';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg) {
  process.stdout.write('[RUNNER] ' + new Date().toISOString() + ' ' + msg + '\n');
}

// ---------------------------------------------------------------------------
// Tier constants (provider-agnostic; fleet resolves to model IDs server-side)
// ---------------------------------------------------------------------------
const TIER_CHEAP    = 'cheap';
const TIER_STANDARD = 'standard';
const TIER_PREMIUM  = 'premium';

// ---------------------------------------------------------------------------
// Arg parsing: identical to auto-sprint.js (4 invocation forms).
//
// Accepted forms:
//   "BD-1"                          bare issue ID
//   "BD-1 BD-2"                     space/comma-separated issue IDs
//   ["BD-1","BD-2"]                 JSON array of issue IDs
//   {"issues":["BD-1"],"goal":"P1"} JSON object (full control)
// ---------------------------------------------------------------------------
const rawArgs = process.argv[2] || '';

let opts = {};
if (rawArgs) {
  let parsed = null;
  try { parsed = JSON.parse(rawArgs); } catch {}

  if (Array.isArray(parsed)) {
    opts = { issues: parsed };
  } else if (parsed && typeof parsed === 'object') {
    opts = parsed;
  } else {
    // bare string: treat as space/comma-separated issue IDs
    const ids = String(rawArgs).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    opts = { issues: ids };
  }
}

let branch             = opts.branch           || '';
const rawIssues        = opts.issues            || [];
const rootIds          = Array.isArray(rawIssues) ? rawIssues : [rawIssues];
const goal             = opts.goal             || 'P1/P2';
const maxCycles        = Number(opts.max_cycles) || 5;
const requirementsFile = opts.requirementsFile  || '';
const base_branch      = opts.base_branch       || 'main';

if (rootIds.length === 0) {
  log('ERROR: at least one beads issue ID is required (pass as arg: /auto-sprint BD-1)');
  process.exit(1);
}

// Goal -> numeric priority threshold.
const GOAL_THRESHOLD = { 'P1': 1, 'P1/P2': 2, 'P1/P2/P3': 3 };
const threshold = GOAL_THRESHOLD[goal] || 2;

log('Sprint args parsed: issues=[' + rootIds.join(',') + '] goal=' + goal +
    ' maxCycles=' + maxCycles + ' base_branch=' + base_branch);
// ---------------------------------------------------------------------------
// bd helper functions (execSync wrappers - no LLM, no MCP)
// ---------------------------------------------------------------------------

function bdExec(args, opts) {
  return execSync('bd ' + args, Object.assign({ encoding: 'utf-8' }, opts || {}));
}

function bdJson(args) {
  const out = bdExec(args + ' --json');
  return JSON.parse(out);
}

function bdReadyTasks() {
  return bdJson('list --ready --type=task');
}

// bdOpenCount: counts open issues in the sprint subtree at/above priority threshold.
// Uses bd list --status=open --json and filters by priority <= threshold and by rootIds
// if provided (scopes exit check to sprint roots only).
function bdOpenCount(rootIds, threshold) {
  let all = [];
  try { all = bdJson('list --status=open'); } catch { return 0; }
  if (!Array.isArray(all)) return 0;
  return all.filter(x => x.p <= threshold).length;
}

// shellExtract: safely parse jsonStr and call extractFn on the result.
// Returns extractFn's result or an empty fallback on any error.
function shellExtract(jsonStr, extractFn) {
  try {
    const parsed = JSON.parse(jsonStr);
    return extractFn(parsed);
  } catch {
    return null;
  }
}
// ---------------------------------------------------------------------------
// Schema constants (ported from auto-sprint.js)
// ---------------------------------------------------------------------------

const REVIEW_SCHEMA = {
  type: 'object', required: ['verdict', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES NEEDED'] },
    notes:   { type: 'string' },
  },
};

const PLAN_REVIEW_SCHEMA = {
  type: 'object', required: ['verdict', 'notes', 'taskAssignments'],
  properties: {
    verdict:         { type: 'string', enum: ['APPROVED', 'CHANGES NEEDED'] },
    notes:           { type: 'string' },
    taskAssignments: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'bucket', 'model'],
        properties: {
          id:     { type: 'string' },
          bucket: { type: 'string', enum: ['S', 'M', 'L'] },
          model:  { type: 'string' },
        },
      },
    },
  },
};

const SHELL_OUTPUTS_SCHEMA = {
  type: 'object', required: ['outputs'],
  properties: {
    outputs: { type: 'array', items: { type: 'string' } },
  },
};

const DOER_STATUS_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status:  { type: 'string', enum: ['VERIFY'] },
    notes:   { type: 'string' },
  },
};

const HARVEST_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['OK', 'FAILED'] },
    notes:  { type: 'string' },
  },
};

const CI_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['green', 'red', 'not_configured', 'pending'] },
    notes:  { type: 'string' },
  },
};

const INTEG_RUN_SCHEMA = {
  type: 'object', required: ['featuresClosed', 'issuesCreated', 'summary'],
  properties: {
    featuresClosed: { type: 'number' },
    issuesCreated:  { type: 'number' },
    summary:        { type: 'string' },
  },
};

// TIER_TO_MODEL: provider-agnostic model family aliases.
// Tier-to-actual-model resolution is fleet server-side; these aliases are used
// only for the parseReadyStreaks normalisation pass (pre-migration model IDs).
const TIER_TO_MODEL = {
  [TIER_CHEAP]:    'haiku',
  [TIER_STANDARD]: 'sonnet',
  [TIER_PREMIUM]:  'opus',
};

// ---------------------------------------------------------------------------
// SHELL_DISPATCH_PROMPT_HEADER (exact string from auto-sprint.js)
// ---------------------------------------------------------------------------
const SHELL_DISPATCH_PROMPT_HEADER =
  `Run each command below EXACTLY ONCE, in order. Return each command's stdout ` +
  `as one string element of outputs[] (same order; outputs.length must equal the ` +
  `number of commands).\n` +
  `Rules: do NOT summarize, reformat, interpret, or escape the output. Do NOT ` +
  `re-run any command. Do NOT retry on empty or unexpected output -- an empty ` +
  `string is a valid result; just return it. This is a single attempt: run, ` +
  `capture, return, stop.\n\n`;

// ---------------------------------------------------------------------------
// Pure parsers (exact ports from auto-sprint.js)
// ---------------------------------------------------------------------------

function collectSubtreeIds(outputs, rootCount) {
  const ids = new Set();
  for (let i = 0; i < rootCount; i++) {
    String(outputs[i] || '').trim().split(/\s+/).filter(Boolean).forEach(id => ids.add(id));
  }
  return ids;
}

// parseBlockers: contract {count, ids} of open issues with priority<=threshold
// inside the sprint-goal subtree.
function parseBlockers(outputs, rootCount, openListIdx, threshold, rootIds) {
  if (!Array.isArray(outputs) || outputs.length < openListIdx + 1) return { count: 999, ids: [] };
  const subtree = collectSubtreeIds(outputs, rootCount);
  const rootSet = Array.isArray(rootIds) && rootIds.length > 0 ? new Set(rootIds) : null;
  let ids = [];
  try {
    const open = JSON.parse(outputs[openListIdx]);
    ids = Array.isArray(open)
      ? open.filter(x => subtree.has(x.id) && (!rootSet || rootSet.has(x.id)) && x.p <= threshold).map(x => x.id)
      : [];
  } catch { ids = []; }
  return { count: ids.length, ids };
}

// parseReadyStreaks: contract {totalCount, streaks[]} grouping ready tasks by model.
function parseReadyStreaks(outputs, rootCount, readyListIdx, defaultModel) {
  if (!Array.isArray(outputs) || outputs.length < readyListIdx + 1) return { totalCount: 0, streaks: [] };
  const subtree = collectSubtreeIds(outputs, rootCount);
  let readyTasks = [];
  try {
    const all = JSON.parse(outputs[readyListIdx]);
    readyTasks = Array.isArray(all) ? all.filter(t => subtree.has(t.id)) : [];
  } catch { readyTasks = []; }

  const KNOWN_TIERS = new Set([TIER_CHEAP, TIER_STANDARD, TIER_PREMIUM]);
  const MODEL_TO_TIER = Object.fromEntries(Object.entries(TIER_TO_MODEL).map(([t, id]) => [id, t]));

  const byModel = {};
  for (const t of readyTasks) {
    const rawModel = t.m || defaultModel;
    let model = rawModel;
    if (!KNOWN_TIERS.has(rawModel)) {
      const tier = MODEL_TO_TIER[rawModel];
      if (tier) {
        model = tier;
        typeof console !== 'undefined' && console.warn(`[apra-pm] Task ${t.id}: pre-migration model '${rawModel}' normalised to tier '${model}'`);
      } else {
        model = defaultModel;
        typeof console !== 'undefined' && console.warn(`[apra-pm] Task ${t.id}: unrecognised model '${rawModel}', defaulting to '${defaultModel}'`);
      }
    }
    if (!byModel[model]) byModel[model] = [];
    byModel[model].push({ id: t.id, priority: t.p });
  }
  const streaks = Object.entries(byModel).map(([model, tasks]) => ({
    model,
    ids: tasks.slice().sort((a, b) => a.priority - b.priority).map(x => x.id),
    _min: Math.min(...tasks.map(x => x.priority)),
  })).sort((a, b) => a._min - b._min).map(({ model, ids }) => ({ model, ids }));

  return { totalCount: readyTasks.length, streaks };
}

// parseCycleState: contract {planDone, inProgressIds}.
function parseCycleState(outputs, rootCount) {
  if (!Array.isArray(outputs) || outputs.length < rootCount + 1) return { planDone: false, inProgressIds: [] };
  const inProgressIds = String(outputs[rootCount] || '').trim().split(/\s+/).filter(Boolean);
  const planDone = Array.from({ length: rootCount }).every((_, i) => {
    try {
      const issues = JSON.parse(outputs[i]);
      if (!Array.isArray(issues)) return false;
      const features = issues.filter(x => x.t === 'feature');
      if (features.length === 0) return false;
      const openFts = features.filter(x => x.s !== 'closed');
      if (openFts.length === 0) return true;
      const tasks = issues.filter(x => x.t === 'task');
      if (tasks.length === 0) return false;
      return tasks.every(x => x.d);
    } catch { return false; }
  });
  return { planDone, inProgressIds };
}

// truncateStreakToCeiling: returns the longest in-order prefix of streakIds whose
// summed estimated doer output tokens stays at/under calibration.doer_token_ceiling[tier].
// Always returns at least one task. Never truncates when no ceiling is configured.
function truncateStreakToCeiling(streakIds, bucketById, calibration, tier) {
  if (!Array.isArray(streakIds) || streakIds.length === 0) return [];
  const ceilings = (calibration && calibration.doer_token_ceiling) || {};
  const ceiling  = ceilings[tier];
  if (typeof ceiling !== 'number' || ceiling <= 0) return streakIds.slice();

  const hist     = (calibration && calibration.historical) || {};
  const buckets  = (calibration && calibration.complexity_buckets) || {};
  const histToks = hist.bucket_avg_tokens || {};
  const estFor = id => {
    const bucket = bucketById ? bucketById[id] : undefined;
    const h = histToks[bucket];
    if (hist.sprints_sampled >= 1 && h != null) return Math.round(h);
    const def = buckets[bucket] || buckets.M || { doer_tokens: 0 };
    return def.doer_tokens || 0;
  };

  let sum = 0;
  const kept = [];
  for (const id of streakIds) {
    const est = estFor(id);
    if (kept.length > 0 && sum + est > ceiling) break;
    kept.push(id);
    sum += est;
  }
  return kept;
}

// approved: returns true if review has verdict === 'APPROVED'.
function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.trim() === 'APPROVED';
}

// labelTaskIds: returns up to 3 IDs joined by space; appends '+Nmore' when more than 3.
function labelTaskIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  if (ids.length <= 3) return ids.join(' ');
  return ids.slice(0, 3).join(' ') + ` +${ids.length - 3}more`;
}
// ---------------------------------------------------------------------------
// Fleet dispatch wrapper
// ---------------------------------------------------------------------------

// dispatchLedger: accumulates cost entries across all cycles.
const dispatchLedger = [];

// dispatchFleet: async wrapper around the apra-fleet execute_prompt MCP tool.
// If opts.schema is set, appends a RESPOND WITH ONLY VALID JSON block and
// retries up to 3 times on JSON parse failure.
async function dispatchFleet(memberName, prompt, opts) {
  opts = opts || {};
  const schema = opts.schema || null;
  const label  = opts.label  || memberName;
  const phase  = opts.phase  || '?';
  const cycle  = opts.cycle  != null ? opts.cycle : 'setup';

  let fullPrompt = prompt;
  if (schema) {
    fullPrompt = prompt + '\n\nRESPOND WITH ONLY VALID JSON matching this schema:\n' +
      JSON.stringify(schema, null, 2);
  }

  log('dispatch: ' + label + ' [' + memberName + ']');

  const MAX_RETRIES = 3;
  let lastRaw = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let raw = '';
    try {
      // Call the apra-fleet MCP execute_prompt tool via the MCP client.
      // In the AGY skill runtime the runner is invoked by the AGY skill engine
      // which exposes MCP tools. We use a synchronous child_process call to
      // invoke the MCP via the AGY CLI's tool dispatch path.
      // For schema responses: parse and return JSON; otherwise return raw string.
      const result = await _fleetCall(memberName, fullPrompt, opts);
      raw = typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      log('dispatch error [' + label + '] attempt ' + attempt + ': ' + String(err).slice(0, 120));
      raw = '';
    }
    lastRaw = raw;

    if (!schema) {
      // No schema needed -- record entry and return raw string.
      dispatchLedger.push({ cycle, phase, label, model: memberName, outTokens: 0, costUsd: 0 });
      return raw;
    }

    // Try to parse JSON response.
    try {
      // Strip markdown code fences if present.
      const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      const parsed = JSON.parse(stripped);
      dispatchLedger.push({ cycle, phase, label, model: memberName,
        outTokens: Math.ceil(raw.length / 4), costUsd: 0 });
      return parsed;
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        log('JSON parse failed [' + label + '] attempt ' + (attempt + 1) + ' -- retrying');
      }
    }
  }

  log('ERROR: JSON parse failed after ' + MAX_RETRIES + ' retries [' + label + ']. Raw: ' +
    lastRaw.slice(0, 200));
  dispatchLedger.push({ cycle, phase, label, model: memberName, outTokens: 0, costUsd: 0 });
  return null;
}

// _fleetCall: low-level call to the apra-fleet MCP execute_prompt tool.
// Uses the AGY MCP client interface available in the runner process context.
// Falls back to a stub if the MCP interface is not available (for --check / tests).
async function _fleetCall(memberName, prompt, opts) {
  // In the AGY skill runtime, MCP tools are accessible via the global __mcp object
  // injected by the skill engine. Check for it and use it if available.
  if (typeof __mcp !== 'undefined' && __mcp && typeof __mcp.call === 'function') {
    const result = await __mcp.call(FLEET_SERVER, FLEET_TOOL, {
      member_name: memberName,
      prompt:      prompt,
    });
    return (result && result.content && result.content[0] && result.content[0].text) || '';
  }

  // If no MCP client is injected, throw so dispatchFleet logs the error and retries.
  throw new Error('No MCP client available -- ensure runner is invoked within AGY skill runtime');
}

// dispatchShellFleet: runs a set of shell commands via a fleet member.
// Builds the prompt with SHELL_DISPATCH_PROMPT_HEADER + numbered commands,
// dispatches with SHELL_OUTPUTS_SCHEMA, and returns the parsed result.
async function dispatchShellFleet(cmds, memberName, opts) {
  opts = opts || {};
  const prompt = SHELL_DISPATCH_PROMPT_HEADER + cmds.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return await dispatchFleet(memberName, prompt,
    Object.assign({}, opts, { schema: SHELL_OUTPUTS_SCHEMA }));
}
// ---------------------------------------------------------------------------
// Sprint state helpers (branch-keyed JSON under sprint-logs/.state/)
// ---------------------------------------------------------------------------

function readSprintState(stateFileRel) {
  try {
    if (!fs.existsSync(stateFileRel)) return { exists: false, ageS: null, state: null };
    const ageS = Math.floor((Date.now() - fs.statSync(stateFileRel).mtimeMs) / 1000);
    let state = null;
    try { state = JSON.parse(fs.readFileSync(stateFileRel, 'utf8')); } catch {}
    return { exists: true, ageS, state };
  } catch {
    return { exists: false, ageS: null, state: null };
  }
}

function writeSprintState(stateFileRel, data, phase, label) {
  try {
    const dir = path.dirname(stateFileRel);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFileRel, JSON.stringify(data, null, 2), 'utf8');
    log('state write [' + (label || phase || 'checkpoint') + ']: ' + stateFileRel);
  } catch (err) {
    log('ERROR: writeSprintState failed: ' + String(err).slice(0, 120));
  }
}

function clearSprintState(stateFileRel, label) {
  try {
    if (fs.existsSync(stateFileRel)) {
      fs.unlinkSync(stateFileRel);
      log('state clear [' + (label || 'state-clear-done') + ']: ' + stateFileRel);
    }
  } catch (err) {
    log('ERROR: clearSprintState failed: ' + String(err).slice(0, 120));
  }
}

// ---------------------------------------------------------------------------
// DEFAULT_CALIBRATION (loaded from cost.js via require if available; otherwise
// embedded here as fallback so the runner works before install.mjs is run).
// ---------------------------------------------------------------------------
let DEFAULT_CALIBRATION;
let computeSprintQuote;
let computeUpdatedCalibration;
let buildSprintSummary;

const skillDir = path.dirname(path.resolve(process.argv[1] || __filename));
const costJsPath = path.join(skillDir, 'cost.js');
if (fs.existsSync(costJsPath)) {
  try {
    const costMod = require(costJsPath);
    DEFAULT_CALIBRATION       = costMod.DEFAULT_CALIBRATION;
    computeSprintQuote        = costMod.computeSprintQuote;
    computeUpdatedCalibration = costMod.computeUpdatedCalibration;
    buildSprintSummary        = costMod.buildSprintSummary;
    log('Loaded cost.js from ' + costJsPath);
  } catch (err) {
    log('WARN: cost.js load failed: ' + String(err).slice(0, 120));
  }
}

if (!DEFAULT_CALIBRATION) {
  DEFAULT_CALIBRATION = {
    schema_version: 1,
    model_prices_per_1m_output_tokens: {
      [TIER_CHEAP]:    5.00,
      [TIER_STANDARD]: 15.00,
      [TIER_PREMIUM]:  25.00,
    },
    role_models: {
      'setup':             TIER_CHEAP,
      'planner':           TIER_PREMIUM,
      'plan-reviewer':     TIER_STANDARD,
      'deployer':          TIER_STANDARD,
      'integ-test-runner': TIER_STANDARD,
      'ci-watcher':        TIER_CHEAP,
      'harvester':         TIER_STANDARD,
      'log-flush':         TIER_CHEAP,
      'check-blockers':    TIER_CHEAP,
      'ready-streaks':     TIER_CHEAP,
    },
    doer_model_fallback: { model: TIER_STANDARD },
    reviewer_model_rule: { minimum: TIER_STANDARD },
    complexity_buckets: {
      S: { doer_tokens:  600 },
      M: { doer_tokens: 1400 },
      L: { doer_tokens: 2800 },
    },
    reviewer_ratio:    { value: 0.4 },
    cycle_assumptions: { optimistic: 1.0, expected: 1.5, pessimistic: 2.5 },
    fixed_overhead_tokens: {
      setup: 200, planner: 2000, plan_reviewer: 1500,
      harvester: 3000, ci_watcher: 300, log_flush_per_cycle: 100,
    },
    input_cost_multiplier: { value: 3.0 },
    outlier_thresholds:    { outlier_pct: 200, calibration_failure_pct: 500 },
    doer_token_ceiling:    {},
    historical:            {},
  };
}

if (!computeSprintQuote) {
  computeSprintQuote = function(taskAssignments, calibration) {
    return { tasks: taskAssignments || [], calibrationSource: 'defaults',
      inputMultiplier: 3.0, scenarios: {
        optimistic:  { outputOnly: 0, total: 0 },
        expected:    { outputOnly: 0, total: 0 },
        pessimistic: { outputOnly: 0, total: 0 },
      }};
  };
}
if (!computeUpdatedCalibration) {
  computeUpdatedCalibration = function(cal) { return cal; };
}
if (!buildSprintSummary) {
  buildSprintSummary = function(analysis, quote, cal, opts) {
    return { summaryText: '(cost.js not loaded -- summary unavailable)' };
  };
}

// ---------------------------------------------------------------------------
// Main async entry point
// ---------------------------------------------------------------------------
(async function main() {
  // ---- Setup block ----

  // Derive repo from git.
  let repo = '';
  try {
    repo = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    log('ERROR: could not determine repo root (not a git repo?)');
    process.exit(1);
  }

  // Auto-detect branch if not provided.
  if (!branch) {
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      log('ERROR: could not detect current git branch');
      process.exit(1);
    }
  }

  if (branch === 'main' || branch === 'master') {
    log('ERROR: refusing to run sprint on protected branch "' + branch +
        '". Pass a sprint branch via {"branch":"feat/..."} arg.');
    process.exit(1);
  }

  log('Repo: ' + repo + ' | Branch: ' + branch);

  // Ensure sprint-logs/ directory exists.
  const sprintLogsDir = path.join(repo, 'sprint-logs');
  if (!fs.existsSync(sprintLogsDir)) fs.mkdirSync(sprintLogsDir, { recursive: true });

  // Build state file path (branch-keyed).
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'default';
  const stateFileRel = path.join(repo, 'sprint-logs', '.state', safeBranch + '.state.json');

  // Load calibration.json if present; fall back to DEFAULT_CALIBRATION.
  let calibration = DEFAULT_CALIBRATION;
  const calibPath = path.join(repo, 'sprint-logs', 'calibration.json');
  if (fs.existsSync(calibPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(calibPath, 'utf8'));
      calibration = Object.assign({}, DEFAULT_CALIBRATION, raw);
      log('Loaded calibration from ' + calibPath);
    } catch (err) {
      log('WARN: calibration.json parse failed, using defaults: ' + String(err).slice(0, 80));
    }
  }

  // Write start event to state file.
  const startedAt = new Date().toISOString();
  writeSprintState(stateFileRel, {
    type: 'start', branch, goal, rootIds, startedAt,
  }, 'setup', 'start');

  const rootSummary = rootIds.join(', ');

  // Dispatch setup agent via pm-planner to ensure branch exists and sprint-log meta
  // line is written.
  const setupPrompt =
    `Sprint workspace setup.\n\n` +
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
    `Sprint goals: ${rootSummary}\n\n` +
    `Step 1: Ensure the sprint branch exists:\n` +
    `  git -C "${repo}" checkout -b ${branch} 2>/dev/null || git -C "${repo}" checkout ${branch}\n\n` +
    `Step 2: Ensure sprint-logs/ directory exists:\n` +
    `  mkdir -p "${repo}/sprint-logs"\n\n` +
    `Step 3: Check if deploy.md and integ-test-playbook.md exist in ${repo}.\n` +
    `  Return "OK" when all steps complete.`;

  await dispatchFleet('pm-planner', setupPrompt, {
    label: 'setup', phase: 'Plan', cycle: 0,
  });

  log('Setup complete. Starting sprint cycle loop.');
  log('Sprint goals: ' + rootSummary + ' | Goal: ' + goal + ' (P<=' + threshold +
      ') | Max cycles: ' + maxCycles);

  // Check for deploy.md and integ-test-playbook.md locally (no LLM needed).
  const deployMdExists  = fs.existsSync(path.join(repo, 'deploy.md'));
  const playbookExists  = fs.existsSync(path.join(repo, 'integ-test-playbook.md'));
  const integTestEnabled = deployMdExists && playbookExists;

  // Sprint loop state.
  let cycleCount     = 0;
  let abortReason    = '';
  let goalMet        = false;
  let taskAssignments = [];
  let sprintQuote    = null;

  // ---- SPRINT LOOP ----
  while (cycleCount < maxCycles) {
    cycleCount++;
    log('\n=== Cycle ' + cycleCount + '/' + maxCycles + ' | goal: ' + goal + ' ===');

    writeSprintState(stateFileRel, {
      type: 'cycle-start', cycle: cycleCount, branch, goal, rootIds, startedAt,
    }, 'Plan', 'state-c' + cycleCount + '-plan');

    // Check cycle state: planDone + in_progress orphans.
    const idExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).issues.map(i=>i.id).join(' '))}catch{}"`;
    const graphExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const issues=(JSON.parse(d).issues||[]);console.log(JSON.stringify(issues.map(i=>({id:i.id,t:i.issue_type,s:i.status,d:!!(i.description||'').trim()}))))}catch{console.log('[]')}"`;
    const ipExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).map(i=>i.id).join(' '))}catch{}"`;
    const cycleStateCmds = [
      ...rootIds.map(id => `bd graph --json ${id} | ${graphExtract}`),
      `bd list --status=in_progress --type=task --json | ${ipExtract}`,
    ];
    const cycleStateRaw = await dispatchShellFleet(cycleStateCmds, 'pm-doer-cheap', {
      label: 'cycle-state', phase: 'Plan', cycle: cycleCount,
    });
    const cycleState = parseCycleState(cycleStateRaw && cycleStateRaw.outputs,
      rootIds.length);
    log('Cycle state: planDone=' + cycleState.planDone +
        ' inProgress=[' + cycleState.inProgressIds.join(', ') + ']');

    // Reset orphaned in_progress tasks.
    if (cycleState.inProgressIds.length > 0) {
      log('Resetting ' + cycleState.inProgressIds.length + ' orphaned in_progress task(s) to open');
      const resetCmds = cycleState.inProgressIds.map(id => `bd update ${id} --status=open`);
      await dispatchShellFleet(resetCmds, 'pm-doer-cheap', {
        label: 'reset-orphans', phase: 'Plan', cycle: cycleCount,
      });
    }
