export const meta = {
  name: 'auto-sprint',
  description: 'Multi-cycle sprint: plan -> develop -> test -> harvest until goal met',
  phases: [
    { title: 'Plan' },
    { title: 'Develop' },
    { title: 'Test' },
    { title: 'Harvest' },
  ],
};

// Multi-cycle sprint workflow. Drives 8 agents against a beads backlog until a
// priority-based quality goal is met or the cycle ceiling is reached.
//
// Agent roster:
//   planner           -- reads open beads epics/features/bugs, creates feature+task DAG
//   plan-reviewer     -- validates DAG: coverage, task size, acceptance criteria
//   doer              -- works bd-ready tasks (impl and test-dev), VERIFY checkpoint
//   reviewer          -- reviews doer output, can reopen tasks
//   deployer          -- follows deploy.md + integ-test-playbook.md (setup/reset/teardown)
//   integ-test-runner -- executes tests, closes features, files bugs/enhancements
//   ci-watcher        -- polls CI; creates beads task if not configured
//   harvester         -- docs, CHANGELOG, token summary, PR
//
// Beads owns all work items and is the exit signal.
// JS workflow owns all routing. No LLM ever decides whether to continue.
//
// args (JSON object serialised to string by the Workflow runtime):
//   branch           -- sprint branch (required); asserted/created at startup
//   issues           -- beads epic IDs to implement, e.g. ["BD-1","BD-2"] (required)
//   goal             -- exit criterion: "P1" | "P1/P2" | "P1/P2/P3"  (default: "P1/P2")
//   max_cycles       -- hard ceiling on sprint cycles                  (default: 5)
//   requirementsFile -- optional context file for the planner          (default: none)
//   base_branch      -- PR target                                      (default: "main")

// NOTE: the arg-parsing block below is intentionally duplicated from lib/parse-sprint-args.mjs,
// which exists only for unit testing (workflow scripts cannot import arbitrary files).
// Keep both in sync when modifying parsing logic.
//
// Accepted forms:
//   "BD-1"                          bare issue ID
//   "BD-1 BD-2"                     space/comma-separated issue IDs
//   ["BD-1","BD-2"]                 JSON array of issue IDs
//   {"issues":["BD-1"],"goal":"P1"} JSON object (full control)
//
// branch always defaults to the current git branch when omitted.
let opts = {};
if (args) {
  let parsed = null;
  try { parsed = JSON.parse(args); } catch {}

  if (Array.isArray(parsed)) {
    opts = { issues: parsed };
  } else if (parsed && typeof parsed === 'object') {
    opts = parsed;
  } else {
    // bare string: treat as space/comma-separated issue IDs
    const ids = String(args).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    opts = { issues: ids };
  }
}

let branch             = opts.branch           || '';   // empty = auto-detect in setup; reassigned after setup resolves
const rawIssues        = opts.issues            || [];
const epicIds          = Array.isArray(rawIssues) ? rawIssues : [rawIssues];
const goal             = opts.goal             || 'P1/P2';
const maxCycles        = Number(opts.max_cycles) || 5;
const requirementsFile = opts.requirementsFile  || '';
const base_branch      = opts.base_branch       || 'main';

if (epicIds.length === 0) {
  log('ERROR: at least one beads issue ID is required (pass as arg: /auto-sprint BD-1)');
  return { error: 'missing issues' };
}

// Goal -> numeric priority threshold.
// Exit when open issues in epic subtree at priority <= threshold reaches zero.
const GOAL_THRESHOLD = { 'P1': 1, 'P1/P2': 2, 'P1/P2/P3': 3 };
const threshold = GOAL_THRESHOLD[goal] || 2;

// ------------------------------------------------------------------ models

const MODEL_OPUS   = 'claude-opus-4-8';
const MODEL_SONNET = 'claude-sonnet-4-6';
const MODEL_HAIKU  = 'claude-haiku-4-5';

// ------------------------------------------------------------------ schemas

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

const LOG_DATA_SCHEMA = {
  type: 'object', required: ['entries'],
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cycle:     {},
          phase:     { type: 'string' },
          label:     { type: 'string' },
          model:     { type: 'string' },
          context:   { type: 'string' },
          outTokens: { type: 'number' },
          costUsd:   { type: 'number' },
        },
      },
    },
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

const SETUP_SCHEMA = {
  type: 'object', required: ['repo', 'branch', 'deployMdExists', 'playbookExists', 'startedAt'],
  properties: {
    repo:           { type: 'string' },
    branch:         { type: 'string' },
    deployMdExists: { type: 'boolean' },
    playbookExists: { type: 'boolean' },
    startedAt:      { type: 'string', description: 'yyyymmdd_hhmmss from date +%Y%m%d_%H%M%S' },
    calibration:    {},  // any JSON value or null; validated by computeSprintQuote()
  },
};

const BEADS_BLOCKERS_SCHEMA = {
  type: 'object', required: ['count', 'ids'],
  properties: {
    count: { type: 'number' },
    ids:   { type: 'array', items: { type: 'string' } },
  },
};

// One entry per model streak: tasks sharing the same model that can be worked
// in a single doer dispatch. Ordered by priority (P0 first).
const READY_STREAKS_SCHEMA = {
  type: 'object', required: ['streaks', 'totalCount'],
  properties: {
    totalCount: { type: 'number' },
    streaks: {
      type: 'array',
      items: {
        type: 'object', required: ['model', 'ids'],
        properties: {
          model: { type: 'string' },
          ids:   { type: 'array', items: { type: 'string' } },
        },
      },
    },
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

// Returned by the resume-check agent at the top of every cycle.
// planDone   -- true if the epic already has features AND every feature has at
//               least one task with non-empty acceptance criteria; skip plan loop.
// inProgressIds -- tasks currently in_progress; reset to open before the develop
//                  loop so a crashed doer never orphans work forever.
const CYCLE_STATE_SCHEMA = {
  type: 'object', required: ['planDone', 'inProgressIds'],
  properties: {
    planDone:       { type: 'boolean' },
    inProgressIds:  { type: 'array', items: { type: 'string' } },
  },
};

// ------------------------------------------------------------------ helpers

function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.trim() === 'APPROVED';
}

// Live pricing for dispatch cost tracking. Initialized from DEFAULT_CALIBRATION;
// synced to calibration.json values after setup() returns.
// Prices are output tokens only in USD per 1M. Source: Anthropic pricing 2026-06-04.
// See also: sprint-logs/calibration.json model_prices_per_1m_output_tokens.
let OUTPUT_PRICE_PER_M = {
  [MODEL_HAIKU]:   5.00,
  [MODEL_SONNET]: 15.00,
  [MODEL_OPUS]:   25.00,
};

// ------------------------------------------------------------------ CALIBRATION DEFAULTS
// Single source of truth for all estimation constants. On first sprint run the setup
// agent writes this to sprint-logs/calibration.json; subsequent runs read that file.
// To change prices or buckets: update this object -- the file is regenerated next run.
const DEFAULT_CALIBRATION = {
  _doc: 'Sprint cost calibration. All estimation constants live here -- nothing is hardcoded in agents. Fields named _doc are documentation strings; skip them when reading values. The historical section is written automatically by the harvester after each sprint; do not edit it manually.',
  schema_version: 1,
  model_prices_per_1m_output_tokens: {
    _doc: 'USD per 1M output tokens. Source: Anthropic published pricing 2026-06-04. Update when pricing changes. This file is the single source of truth -- DEFAULT_CALIBRATION in auto-sprint.js is only used to bootstrap this file on first run.',
    [MODEL_HAIKU]:   5.00,
    [MODEL_SONNET]: 15.00,
    [MODEL_OPUS]:   25.00,
  },
  role_models: {
    _doc: "Fixed model per workflow role. 'doer' and 'reviewer' are NOT here -- the planner sets model per task in beads metadata; reviewer escalates to max(task_model, sonnet). Change an entry here to reroute a role to a different model tier.",
    'setup':             MODEL_HAIKU,
    'planner':           MODEL_OPUS,
    'plan-reviewer':     MODEL_SONNET,
    'deployer':          MODEL_SONNET,
    'integ-test-runner': MODEL_SONNET,
    'ci-watcher':        MODEL_HAIKU,
    'harvester':         MODEL_SONNET,
    'log-flush':         MODEL_HAIKU,
    'check-blockers':    MODEL_HAIKU,
    'ready-streaks':     MODEL_HAIKU,
  },
  doer_model_fallback: {
    _doc: 'Model assumed for doer cost estimation when a task has no model metadata in beads. In practice the planner always sets model metadata -- this is a safety net only.',
    model: MODEL_SONNET,
  },
  reviewer_model_rule: {
    _doc: 'Reviewer model is max(doer_task_model, minimum). If the doer used opus, reviewer uses opus; otherwise reviewer uses sonnet. This mirrors the reviewerModel selection in auto-sprint.js.',
    minimum: MODEL_SONNET,
  },
  complexity_buckets: {
    _doc: 'Estimated doer output tokens per task by complexity bucket S/M/L. Plan-reviewer assigns a bucket to each task by reading its description. historical.bucket_avg_tokens overrides these defaults once enough sprint data has been collected.',
    S: { _doc: 'Small: 1 file, narrow scoped change -- rename, config key, simple wiring, pure boilerplate', doer_tokens:  600 },
    M: { _doc: 'Medium: 2-3 files, moderate logic -- new API endpoint, test suite, small focused refactor',  doer_tokens: 1400 },
    L: { _doc: 'Large: 3+ files or non-trivial design -- new auth flow, data migration, cross-cutting refactor', doer_tokens: 2800 },
  },
  reviewer_ratio: {
    _doc: 'Reviewer estimated output tokens as a fraction of doer tokens for the same task. 0.4 means reviewer uses ~40% as many output tokens as the doer. Overridden by historical.reviewer_ratio_avg when available.',
    value: 0.4,
  },
  cycle_assumptions: {
    _doc: "Expected number of dev/review cycles. Per-task cost is multiplied by these to produce sprint-level cost scenarios. Update 'expected' if your team consistently lands at a different cycle count.",
    optimistic: 1.0, expected: 1.5, pessimistic: 2.5,
  },
  fixed_overhead_tokens: {
    _doc: "Estimated output tokens for agents that run once per sprint regardless of task count. 'log_flush_per_cycle' is multiplied by the expected cycle count. Keys use underscores; the role lookup strips underscores to match role_models keys.",
    setup:               200,
    planner:            2000,
    plan_reviewer:      1500,
    harvester:          3000,
    ci_watcher:          300,
    log_flush_per_cycle: 100,
  },
  input_cost_multiplier: {
    _doc: 'Multiply output-only USD estimate by this to approximate true cost (input + output). 4.0 is conservative for long-context agents. Replace with an empirical ratio once the workflow harness exposes input token counts.',
    value: 4.0,
  },
  outlier_thresholds: {
    _doc: 'Percentage deviation bands used to classify estimation accuracy in the sprint analysis report.',
    notable_pct:              50,
    outlier_pct:             200,
    calibration_failure_pct: 500,
  },
  historical: {
    _doc: 'Written by harvester after each sprint. Contains actual per-role output token averages from sprint-log JSONL files. Used by auto-sprint.js computeSprintQuote() to improve future estimates. Do not edit manually.',
    max_sprints_in_sample: 5,
    sprints_sampled:       0,
    last_updated:          null,
    cycle_avg:             null,
    reviewer_ratio_avg:    null,
    bucket_avg_tokens:     {},
    roles:                 {},
  },
};

// ------------------------------------------------------------------ COST ARITHMETIC
// All sprint cost computations are pure JavaScript -- no agent touches a number.
// NOTE: these functions are duplicated in lib/sprint-cost.mjs (which exists only for
// unit testing -- workflow scripts cannot import arbitrary files). Keep both in sync.

// Reviewer model mirrors auto-sprint dispatch logic: max(taskModel, sonnet).
function reviewerModelFor(taskModel) {
  return taskModel === MODEL_OPUS ? MODEL_OPUS : MODEL_SONNET;
}

function computeSprintQuote(taskAssignments, calibration) {
  const prices    = calibration.model_prices_per_1m_output_tokens;
  const hist      = calibration.historical || {};
  const buckets   = calibration.complexity_buckets;
  const revRatio  = (hist.sprints_sampled >= 1 && hist.reviewer_ratio_avg != null)
    ? hist.reviewer_ratio_avg : calibration.reviewer_ratio.value;
  const cycles    = calibration.cycle_assumptions;
  const overhead  = calibration.fixed_overhead_tokens;
  const inputMult = calibration.input_cost_multiplier.value;
  const fallback  = (calibration.doer_model_fallback || {}).model || MODEL_SONNET;
  const calibSrc  = hist.sprints_sampled >= 1
    ? `historical (${hist.sprints_sampled} sprint${hist.sprints_sampled !== 1 ? 's' : ''})`
    : 'defaults';

  const tasks = (taskAssignments || []).map(t => {
    const model      = t.model || fallback;
    const histToks   = (hist.bucket_avg_tokens || {})[t.bucket];
    const doerTokens = (hist.sprints_sampled >= 1 && histToks != null)
      ? Math.round(histToks) : (buckets[t.bucket] || buckets.M).doer_tokens;
    const reviewerTokens = Math.round(doerTokens * revRatio);
    const doerPrice      = prices[model]                   || prices[MODEL_SONNET];
    const revPrice       = prices[reviewerModelFor(model)] || prices[MODEL_SONNET];
    const outputUsd      = (doerTokens * doerPrice + reviewerTokens * revPrice) / 1_000_000;
    return { id: t.id, bucket: t.bucket, model, doerTokens, reviewerTokens, outputUsd };
  });

  const perTaskSubtotal = tasks.reduce((s, t) => s + t.outputUsd, 0);

  const rm = calibration.role_models || {};
  let overheadUsd = 0;
  for (const [key, tokens] of Object.entries(overhead)) {
    if (key === 'log_flush_per_cycle') continue;
    const role  = key.replace(/_/g, '-');
    const model = rm[role] || MODEL_SONNET;
    overheadUsd += tokens * (prices[model] || prices[MODEL_SONNET]) / 1_000_000;
  }
  const logFlushUsd = (overhead.log_flush_per_cycle || 0)
    * (prices[rm['log-flush'] || MODEL_HAIKU] || prices[MODEL_HAIKU]) / 1_000_000;

  const scenario = mult => {
    const out = perTaskSubtotal * mult + overheadUsd + logFlushUsd * mult;
    return { outputOnly: out, total: out * inputMult };
  };

  return {
    tasks,
    calibrationSource: calibSrc,
    inputMultiplier:   inputMult,
    scenarios: {
      optimistic:  scenario(cycles.optimistic),
      expected:    scenario(cycles.expected),
      pessimistic: scenario(cycles.pessimistic),
    },
  };
}

function computeSprintAnalysis(quote, logEntries, calibration, actualCycles) {
  const prices    = calibration.model_prices_per_1m_output_tokens;
  const inputMult = calibration.input_cost_multiplier.value;
  const thr       = calibration.outlier_thresholds;
  const cycles    = calibration.cycle_assumptions;
  const rm        = calibration.role_models || {};
  const overhead  = calibration.fixed_overhead_tokens;

  const roleOf = label => label.replace(/-c\d.*$/, '');

  const byRole = {};
  for (const e of (logEntries || [])) {
    const role = roleOf(e.label || '');
    if (!role) continue;
    if (!byRole[role]) byRole[role] = { tokens: 0, costUsd: 0, dispatches: 0 };
    byRole[role].tokens    += e.outTokens || 0;
    byRole[role].costUsd   += e.costUsd   || 0;
    byRole[role].dispatches++;
  }

  const estCycles = cycles.expected;
  const tasks = quote ? quote.tasks || [] : [];

  const estDoerTokens     = tasks.reduce((s, t) => s + t.doerTokens,     0) * estCycles;
  const estReviewerTokens = tasks.reduce((s, t) => s + t.reviewerTokens, 0) * estCycles;
  const estDoerUsd        = tasks.reduce((s, t) =>
    s + t.doerTokens     * (prices[t.model]                   || prices[MODEL_SONNET]) / 1_000_000, 0) * estCycles;
  const estReviewerUsd    = tasks.reduce((s, t) =>
    s + t.reviewerTokens * (prices[reviewerModelFor(t.model)] || prices[MODEL_SONNET]) / 1_000_000, 0) * estCycles;

  let estOverheadTokens = 0, estOverheadUsd = 0;
  for (const [key, tokens] of Object.entries(overhead)) {
    const mult  = key === 'log_flush_per_cycle' ? estCycles : 1;
    const role  = key.replace(/_/g, '-');
    const model = key === 'log_flush_per_cycle' ? (rm['log-flush'] || MODEL_HAIKU) : (rm[role] || MODEL_SONNET);
    estOverheadTokens += tokens * mult;
    estOverheadUsd    += tokens * mult * (prices[model] || prices[MODEL_SONNET]) / 1_000_000;
  }

  const actDoerTokens     = byRole['doer']?.tokens     || 0;
  const actDoerUsd        = byRole['doer']?.costUsd    || 0;
  const actReviewerTokens = byRole['reviewer']?.tokens  || 0;
  const actReviewerUsd    = byRole['reviewer']?.costUsd || 0;
  let actOverheadTokens = 0, actOverheadUsd = 0;
  for (const [role, data] of Object.entries(byRole)) {
    if (role !== 'doer' && role !== 'reviewer') {
      actOverheadTokens += data.tokens;
      actOverheadUsd    += data.costUsd;
    }
  }

  const totEstTokens = Math.round(estDoerTokens + estReviewerTokens + estOverheadTokens);
  const totActTokens = actDoerTokens + actReviewerTokens + actOverheadTokens;
  const totEstUsd    = estDoerUsd + estReviewerUsd + estOverheadUsd;
  const totActUsd    = actDoerUsd + actReviewerUsd + actOverheadUsd;

  const pct  = (est, act) => est > 0 ? `${act > est ? '+' : ''}${Math.round((act - est) / est * 100)}%` : 'n/a';
  const fmtN = n => Math.round(n).toLocaleString('en-US');
  const fmtU = n => `$${n.toFixed(3)}`;

  const rows = [
    ['doer',     Math.round(estDoerTokens),     actDoerTokens,     estDoerUsd,     actDoerUsd     ],
    ['reviewer', Math.round(estReviewerTokens), actReviewerTokens, estReviewerUsd, actReviewerUsd ],
    ['overhead', Math.round(estOverheadTokens), actOverheadTokens, estOverheadUsd, actOverheadUsd ],
    ['TOTAL',    totEstTokens,                  totActTokens,      totEstUsd,      totActUsd      ],
  ];

  const header =
    `| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |\n` +
    `|------------|------------|------------|-------|----------|----------|\n`;
  const body = rows.map(([role, et, at, eu, au]) =>
    `| ${role.padEnd(10)} | ${fmtN(et).padStart(10)} | ${fmtN(at).padStart(10)} | ${pct(et, at).padStart(5)} | ${fmtU(eu).padStart(8)} | ${fmtU(au).padStart(8)} |`
  ).join('\n');

  const outliers = rows.slice(0, 3).filter(([, et, at]) => et > 0 && Math.abs((at - et) / et * 100) > thr.outlier_pct).map(r => r[0]);
  const failures = rows.slice(0, 3).filter(([, et, at]) => et > 0 && Math.abs((at - et) / et * 100) > thr.calibration_failure_pct).map(r => r[0]);

  const src = quote ? quote.calibrationSource : 'none';
  const analysisText =
    `#### Sprint cost analysis\n` +
    `Calibration: ${src}   Cycles: estimated ${estCycles}, actual ${actualCycles}\n\n` +
    header + body + `\n` +
    `True-cost estimate (output x ${inputMult}x): ${fmtU(totEstUsd * inputMult)}\n\n` +
    `Outliers (>${thr.outlier_pct}% variance): ${outliers.length ? outliers.join(', ') : 'none'}\n` +
    `Calibration failures (>${thr.calibration_failure_pct}%): ${failures.length ? failures.join(', ') : 'none'}\n`;

  return { analysisText, byRole, actualCycles, totEstOutputUsd: totEstUsd, totEstTrueUsd: totEstUsd * inputMult, totActUsd };
}

function computeUpdatedCalibration(calibration, analysis, startedAt) {
  const hist = JSON.parse(JSON.stringify(calibration.historical || {}));
  const max  = hist.max_sprints_in_sample || 5;
  const prev = Math.min(hist.sprints_sampled || 0, max - 1);
  const n    = prev + 1;
  const blend = (old, val) => old == null ? val : (old * prev + val) / n;

  hist.sprints_sampled = n;
  hist.last_updated    = startedAt.replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3');
  hist.cycle_avg       = blend(hist.cycle_avg, analysis.actualCycles);
  hist.roles           = hist.roles || {};

  for (const [role, data] of Object.entries(analysis.byRole)) {
    const avg    = data.dispatches > 0 ? data.tokens / data.dispatches : 0;
    const prev_r = hist.roles[role] || { avg_output_tokens: null, sample_n: 0 };
    hist.roles[role] = {
      avg_output_tokens: blend(prev_r.avg_output_tokens, avg),
      sample_n: prev_r.sample_n + data.dispatches,
    };
  }

  const doerTok = analysis.byRole['doer']?.tokens     || 0;
  const revTok  = analysis.byRole['reviewer']?.tokens || 0;
  if (doerTok > 0) hist.reviewer_ratio_avg = blend(hist.reviewer_ratio_avg, revTok / doerTok);

  // bucket_avg_tokens is intentionally not updated here: matching a doer log entry back
  // to an S/M/L bucket requires joining task IDs in the log entry context field against
  // the saved taskAssignments. That join is future work; bucket defaults in
  // calibration.json remain the source for doer_tokens estimates until then.

  return { ...calibration, historical: hist };
}

function outputCostUsd(model, tokens) {
  const rate = OUTPUT_PRICE_PER_M[model] || OUTPUT_PRICE_PER_M[MODEL_SONNET];
  return (tokens / 1_000_000) * rate;
}

// Real output-token cost via differential budget.spent() snapshots.
// budget.spent() is the only actual usage the harness exposes (output tokens only).
// opts.context -- short human string describing what was worked (e.g. "tasks BD-5,BD-6")
let cycleCostUsd = 0;
const dispatchLedger = [];  // accumulates across all cycles; flushed to sprint-logs/<branch>.jsonl per cycle

async function dispatch(prompt, opts) {
  const before = budget.spent();
  const result = await agent(prompt, opts);
  const outTokens = budget.spent() - before;
  const cost = outputCostUsd(opts.model || MODEL_SONNET, outTokens);
  cycleCostUsd += cost;
  const entry = {
    cycle:   cycleCount === 0 ? 'setup' : cycleCount,
    phase:   opts.phase  || '?',
    label:   opts.label  || '?',
    model:   opts.model  || MODEL_SONNET,
    context: opts.context || '',
    outTokens,
    costUsd: parseFloat(cost.toFixed(4)),
  };
  dispatchLedger.push(entry);
  if (outTokens > 0) log(`$${cost.toFixed(4)} ${opts.label || '?'} -- ${opts.context || opts.phase || '?'}`);
  return result;
}


async function countBeadsBlockers(thr, epics) {
  const epicList = epics.join(' ');
  const r = await dispatch(
    `Run: bd list --status=open\n` +
    `From that output, identify all issues that are either:\n` +
    `  (a) one of these epics: ${epicList}, or a descendant of them (run bd show <id> to check), or\n` +
    `  (b) have a title containing "[integ]" (created by integration testing this sprint).\n` +
    `Count only those with priority 0 through ${thr} (P0 to P${thr}).\n` +
    `Return count (integer) and their beads IDs as an array.`,
    { model: MODEL_HAIKU, label: 'check-blockers', phase: 'Develop', schema: BEADS_BLOCKERS_SCHEMA }
  );
  return r || { count: 999, ids: [] };
}

async function getReadyStreaks() {
  const r = await dispatch(
    `Run these three commands to fetch ready tasks grouped by assigned model:\n` +
    `  bd list --ready --type=task --metadata-field model=${MODEL_HAIKU} --json\n` +
    `  bd list --ready --type=task --metadata-field model=${MODEL_SONNET} --json\n` +
    `  bd list --ready --type=task --metadata-field model=${MODEL_OPUS} --json\n` +
    `Also run: bd list --ready --type=task --json\n` +
    `  Any task ID in that last list but absent from the three model lists has no model\n` +
    `  assigned; default those to "${MODEL_SONNET}".\n\n` +
    `Build the streaks array: one entry per non-empty model group.\n` +
    `Within each streak order IDs by priority (P0 first).\n` +
    `Order streaks by the highest priority task they contain (P0 first).\n` +
    `totalCount = total number of ready tasks across all streaks.`,
    { model: MODEL_HAIKU, label: 'ready-streaks', phase: 'Develop', schema: READY_STREAKS_SCHEMA }
  );
  return r || { totalCount: 0, streaks: [] };
}

async function commitFeedback(repo, branch, notes, role, label, phase) {
  await dispatch(
    `Repo: ${repo}\nBranch: ${branch}\n\n` +
    `Write the following reviewer feedback to feedback.md (overwrite if it exists):\n\n` +
    `${notes}\n\n` +
    `Then commit and push:\n` +
    `  git -C "${repo}" add feedback.md\n` +
    `  git -C "${repo}" -c user.name='${role}' -c user.email='${role}@pm.local' commit -m "feedback: ${label}"\n` +
    `  git -C "${repo}" push origin ${branch}`,
    { model: MODEL_HAIKU, label: `feedback-commit-${label}`, phase }
  );
}

async function checkCycleState(epicIds) {
  const showCmds = epicIds.map(id => `bd show ${id}`).join('\n');
  const graphCmds = epicIds.map(id => `bd graph --compact ${id}`).join('\n');
  const r = await dispatch(
    `Run each of these to inspect the sprint epics and their full dependency subtrees:\n` +
    `${showCmds}\n` +
    `${graphCmds}\n` +
    `Run: bd list --status=in_progress\n\n` +
    `From those outputs answer:\n\n` +
    `planDone: true if ALL of the following hold --\n` +
    `  - At least one type=feature issue appears in the dependency graph of each epic\n` +
    `  - Every open feature has at least one type=task in its dependency graph\n` +
    `  - Every task has a non-empty description (acceptance criteria present)\n` +
    `  Set false if any of these conditions are not met.\n\n` +
    `inProgressIds: list the IDs of ALL issues currently in_progress status.\n` +
    `  These are orphaned from a previous crashed run and must be reset before work resumes.`,
    { model: MODEL_HAIKU, label: 'cycle-state', phase: 'Plan', schema: CYCLE_STATE_SCHEMA }
  );
  return r || { planDone: false, inProgressIds: [] };
}

// ------------------------------------------------------------------ STATE

let cycleCount   = 0;
let epicDone     = false;
let prevOpenIds  = [];
let headSha      = '';
let abortReason  = '';

// ------------------------------------------------------------------ SETUP

phase('Plan');

const setup = await dispatch(
  `Sprint workspace setup.\n\n` +
  `Step 1: Get repo root.\n` +
  `  Run: git rev-parse --show-toplevel\n\n` +
  (branch
    ? `Step 2: Assert sprint branch "${branch}".\n` +
      `  - Already on "${branch}": do nothing.\n` +
      `  - Exists locally: git checkout "${branch}"\n` +
      `  - Exists on origin: git checkout --track origin/"${branch}"\n` +
      `  - Otherwise: git checkout -b "${branch}"\n\n`
    : `Step 2: Detect current branch.\n` +
      `  Run: git rev-parse --abbrev-ref HEAD\n` +
      `  Use this as the sprint branch. Do NOT switch or create any branch.\n\n`) +
  `Step 3: Capture start timestamp.\n` +
  `  Run: date +%Y%m%d_%H%M%S\n` +
  `  Return the output as startedAt (e.g. "20260620_143022").\n\n` +
  `Step 4: Check for required project files.\n` +
  `  Run: test -f deploy.md && echo YES || echo NO   -> deployMdExists\n` +
  `  Run: test -f integ-test-playbook.md && echo YES || echo NO  -> playbookExists\n\n` +
  `Step 5: Merge deploy permissions into .claude/settings.json.\n` +
  `  For each of deploy.md and integ-test-playbook.md that exists:\n` +
  `    a. Read the file and extract lines under the "## Permissions" section\n` +
  `       (stop at the next ## heading). Each non-empty line is a permission entry\n` +
  `       such as "Bash(docker *)" or "Bash(npm run *)".\n` +
  `    b. Read .claude/settings.json (create it as {} if absent).\n` +
  `    c. For each extracted permission not already in permissions.allow, add it.\n` +
  `    d. Write the updated .claude/settings.json back.\n` +
  `  If neither file has a ## Permissions section, skip this step.\n\n` +
  `Step 6: Load or bootstrap calibration data.\n` +
  `  If sprint-logs/calibration.json exists in the repo root:\n` +
  `    Read it and return its contents as the "calibration" field.\n` +
  `  If it does NOT exist (first run):\n` +
  `    Create the sprint-logs/ directory: mkdir -p sprint-logs\n` +
  `    Write the following JSON exactly to sprint-logs/calibration.json:\n` +
  JSON.stringify(DEFAULT_CALIBRATION, null, 2) + `\n` +
  `    Return the same content as the "calibration" field.\n\n` +
  `Return repo (absolute path), branch (confirmed), deployMdExists, playbookExists, startedAt, calibration.`,
  { model: MODEL_HAIKU, label: 'setup', phase: 'Plan', schema: SETUP_SCHEMA }
);

if (!setup || !setup.repo || !setup.branch) {
  log('ERROR: setup failed -- could not assert branch or locate repo');
  return { error: 'setup failed' };
}

const repo = setup.repo;
branch = setup.branch;  // use the confirmed/detected branch for all subsequent agent prompts

// Setup always returns calibration (bootstrapping the file if needed). Fall back to
// DEFAULT_CALIBRATION only if setup itself failed to return a value.
const calibration = setup.calibration || DEFAULT_CALIBRATION;
// Sync output prices from loaded calibration so dispatchLedger uses correct rates.
Object.assign(OUTPUT_PRICE_PER_M, calibration.model_prices_per_1m_output_tokens || {});

// State for cost estimation -- populated after plan is APPROVED.
let sprintQuote = null;

// Derive a filename-safe version of the branch for sprint-logs/.
// Replaces path separators and non-safe chars with dashes so that parallel
// sprints on different branches never write to the same file.
// Timestamp (yyyymmdd_hhmmss) is captured by the setup agent so it stays
// stable across workflow resumes (Date.now() is banned in workflow scripts).
const sprintLogBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'default';
const sprintLogFile = `sprint-logs/${sprintLogBranch}-${setup.startedAt}.jsonl`;
const integTestEnabled = setup.deployMdExists && setup.playbookExists;

log(`Repo: ${repo} | Branch: ${setup.branch}`);
log(`deploy.md: ${setup.deployMdExists} | integ-test-playbook.md: ${setup.playbookExists}`);
if (!setup.deployMdExists) log('WARNING: deploy.md not found -- integration test phase will be skipped');
if (!setup.playbookExists) log('WARNING: integ-test-playbook.md not found -- integration test phase will be skipped');
if (!integTestEnabled) log('Integration testing disabled for this sprint. Harvest will run after Develop.');

const epicSummary = epicIds.join(', ');
log(`Epics: ${epicSummary} | Goal: ${goal} (P<=${threshold}) | Max cycles: ${maxCycles}`);

// ------------------------------------------------------------------ EPIC LOOP

while (cycleCount < maxCycles) {
  cycleCount++;
  cycleCostUsd = 0;
  log(`\n=== Cycle ${cycleCount}/${maxCycles} | goal: ${goal} ===`);

  // ---------------------------------------------------------------- RESUME CHECK

  phase('Plan');

  const cycleState = await checkCycleState(epicIds);
  log(`Cycle state: planDone=${cycleState.planDone} inProgress=[${cycleState.inProgressIds.join(', ')}]`);

  // Reset any tasks orphaned in_progress from a previous crashed run.
  if (cycleState.inProgressIds.length > 0) {
    log(`Resetting ${cycleState.inProgressIds.length} orphaned in_progress task(s) to open`);
    for (const id of cycleState.inProgressIds) {
      await dispatch(
        `Run: bd update ${id} --status=open`,
        { model: MODEL_HAIKU, label: `reset-${id}`, phase: 'Plan' }
      );
    }
  }

  // ---------------------------------------------------------------- PLAN

  let planApproved = cycleState.planDone;
  let planFeedback = '';
  const MAX_PLAN_ITER = 3;

  if (planApproved) {
    log(`Plan already complete -- skipping plan loop for cycle ${cycleCount}`);
  }

  for (let pi = 0; pi < MAX_PLAN_ITER && !planApproved; pi++) {
    const plannerLabel = `planner-c${cycleCount}-r${pi}`;

    const plannerResult = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
      `Sprint epics: ${epicSummary}\n` +
      (requirementsFile ? `Additional context: ${requirementsFile}\n` : '') +
      `\n` +
      (planFeedback
        ? `Plan-reviewer feedback from the previous round (read feedback.md in ${repo} for full details):\n${planFeedback}\nAddress every item before proceeding.\n\n`
        : '') +
      `Inspect existing state first:\n` +
      `  ${epicIds.map(id => `bd show ${id} && bd graph --compact ${id}`).join('\n  ')}\n` +
      `Run: bd show <id> on any existing features/tasks to read their current descriptions.\n` +
      `Then build or complete the feature+task DAG -- create only what is missing:\n` +
      `  - BEFORE creating any feature or task, run: bd search "<title>" --status all\n` +
      `    If a matching issue already exists, update it instead of creating a duplicate.\n` +
      `\n` +
      `DEPENDENCY WIRING -- read this carefully. "bd dep add A B" means A CANNOT CLOSE until B is done.\n` +
      `The correct wiring direction is: parents depend on children (children unblock first).\n` +
      `\n` +
      `  Step 1 -- wire epic -> feature (epic waits for features):\n` +
      `    bd dep add <epic-id> <feature-id>\n` +
      `    After this: "bd ready" will NOT show the epic (it's waiting). Features show as ready.\n` +
      `\n` +
      `  Step 2 -- wire feature -> tasks (feature waits for tasks):\n` +
      `    bd dep add <feature-id> <impl-task-id>\n` +
      `    bd dep add <feature-id> <test-task-id>\n` +
      `    After this: "bd ready" will show impl-task (the leaf). Feature is now blocked.\n` +
      `\n` +
      `  Step 3 -- wire test after impl:\n` +
      `    bd dep add <test-task-id> <impl-task-id>\n` +
      `    After this: "bd ready" shows only impl-task. test-task unblocks once impl-task closes.\n` +
      `\n` +
      `  VERIFY after wiring: run "bd ready" -- it must return impl tasks, NOT features or epics.\n` +
      `  If features appear in "bd ready" the deps are backwards -- fix them before continuing.\n` +
      `\n` +
      `  IMPORTANT: Each task belongs to exactly ONE feature. Never share a task across features.\n` +
      `\n` +
      `  Create type=feature issues as children of each epic (use bd dep add epic feature per above).\n` +
      `  Create type=task issues for each feature: implementation tasks AND integration\n` +
      `    test development tasks (prefix test tasks with "[test]" in the title)\n` +
      `  Features P1/P2; tasks one level below their parent feature (P1 feature -> P2 tasks, P2 feature -> P3 tasks)\n` +
      `  Each task must be completable in one agent session (1-3 file changes max)\n` +
      `  Every task needs clear acceptance criteria in its description\n` +
      `  - Assign each task a model based on complexity -- after creating or updating each\n` +
      `    task, run: bd update <id> --set-metadata model=<model-id>\n` +
      `    Available models and when to use them:\n` +
      `      ${MODEL_HAIKU}  -- mechanical work: rename, config tweak, move file, simple wiring\n` +
      `      ${MODEL_SONNET} -- standard work: new function, test suite, API endpoint, refactor\n` +
      `      ${MODEL_OPUS}   -- hard work: architecture, multi-file design, ambiguous requirements\n` +
      `  - Group tasks so consecutive tasks in dependency order share a model where\n` +
      `    possible -- this minimises model-switching overhead during execution\n` +
      (cycleCount > 1
        ? `This is cycle ${cycleCount}. Focus on open issues only.\n` +
          `Do NOT add new scope beyond the original epics and open bugs/enhancements.\n` +
          `Do NOT re-create tasks that are already closed.\n`
        : '') +
      `Confirm with any text when done.`,
      { model: MODEL_OPUS, label: plannerLabel, phase: 'Plan', agentType: 'planner',
        context: `planning epics ${epicSummary}` }
    );

    if (!plannerResult) {
      log(`Planner returned null on cycle ${cycleCount} round ${pi} -- retrying`);
      continue;
    }

    const planReviewerLabel = `plan-reviewer-c${cycleCount}-r${pi}`;
    const planReview = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nSprint epics: ${epicSummary}\n` +
      `Calibration file: ${repo}/sprint-logs/calibration.json (read this first if it exists)\n\n` +
      `Review the beads DAG for these epics ONLY: ${epicSummary}\n` +
      `Run: ${epicIds.map(id => `bd show ${id}`).join(' && ')} to inspect each epic.\n` +
      `Run: ${epicIds.map(id => `bd graph --compact ${id}`).join(' && ')} for the full dependency subtree.\n` +
      `Run: bd show <id> to inspect individual issues in depth.\n` +
      `Run: bd ready -- this is your FIRST correctness check.\n` +
      `Do NOT review or comment on issues outside these epics.\n\n` +
      `Follow your runbook (plan-reviewer.md) step by step:\n` +
      `  Steps 1-2: inspect the DAG and check all quality criteria.\n` +
      `  Step 3: classify each task -- assign complexity bucket (S/M/L) and read its model\n` +
      `    from beads metadata. If a task has no model metadata, note it in your verdict\n` +
      `    notes as a warning but do NOT return CHANGES NEEDED for it -- the workflow has a fallback.\n` +
      `  Step 4: return verdict, notes, and taskAssignments (id + bucket + model per task).\n\n` +
      `Notes must be specific: include issue IDs and exact "bd dep add" commands to fix\n` +
      `any dependency direction problems.`,
      { model: MODEL_SONNET, label: planReviewerLabel, phase: 'Plan', schema: PLAN_REVIEW_SCHEMA, agentType: 'plan-reviewer',
        context: `reviewing plan for epics ${epicSummary}` }
    );

    if (approved(planReview)) {
      planApproved = true;
      log(`Plan APPROVED on cycle ${cycleCount} round ${pi + 1}`);

      // Compute sprint cost quote in pure JS -- no agent does arithmetic.
      sprintQuote = computeSprintQuote(planReview.taskAssignments || [], calibration);
      const sc = sprintQuote.scenarios;
      log(`Sprint quote (${sprintQuote.calibrationSource}, ${(planReview.taskAssignments || []).length} tasks): ` +
          `output-only: opt=$${sc.optimistic.outputOnly.toFixed(3)} ` +
          `exp=$${sc.expected.outputOnly.toFixed(3)} ` +
          `pess=$${sc.pessimistic.outputOnly.toFixed(3)} ` +
          `| true-est (x${sprintQuote.inputMultiplier.toFixed(1)}): ` +
          `exp=$${sc.expected.total.toFixed(3)}`);

      // Write per-task cost estimates to beads notes via a lightweight haiku dispatch.
      if (sprintQuote.tasks.length > 0) {
        const bdCmds = sprintQuote.tasks.map(t =>
          `bd update ${t.id} --notes="cost-estimate: bucket=${t.bucket} model=${t.model} ` +
          `doer_tokens=${t.doerTokens} reviewer_tokens=${t.reviewerTokens} output_usd=${t.outputUsd.toFixed(4)}"`
        ).join('\n');
        await dispatch(
          `Write cost estimates to beads task notes.\n\nRun these commands:\n${bdCmds}`,
          { model: MODEL_HAIKU, label: `write-quote-c${cycleCount}`, phase: 'Plan' }
        );
      }
    } else {
      planFeedback = (planReview && planReview.notes) || '';
      log(`Plan needs changes: ${planFeedback.slice(0, 120)}`);
      await commitFeedback(repo, branch, planFeedback, 'pm-plan-reviewer', planReviewerLabel, 'Plan');
    }
  }

  if (!planApproved) {
    log(`Plan not approved after ${MAX_PLAN_ITER} rounds -- aborting sprint`);
    abortReason = 'plan not approved';
    break;
  }

  // ---------------------------------------------------------------- DEVELOP

  phase('Develop');

  const MAX_DEV_ITER = 20;
  let devIter = 0;
  let devFeedback = '';

  while (devIter < MAX_DEV_ITER) {
    const streakResult = await getReadyStreaks();
    if (streakResult.totalCount === 0) {
      log(`No ready tasks -- develop phase complete (${devIter} iterations)`);
      break;
    }
    log(`Ready: ${streakResult.totalCount} task(s) across ${streakResult.streaks.length} model streak(s)`);

    // Dispatch one doer per model streak; collect all worked task IDs for the reviewer.
    const workedIds = [];
    let streakAbort = false;

    for (const streak of streakResult.streaks) {
      const doerLabel = `doer-c${cycleCount}-i${devIter}-${streak.model.split('-').slice(-2, -1)[0] || streak.model}`;
      log(`Streak: model=${streak.model} tasks=${streak.ids.join(', ')}`);

      const doerResult = await dispatch(
        `Repo: ${repo}\nBranch: ${branch}\n\n` +
        (devFeedback
          ? `Reviewer feedback from the previous iteration (read feedback.md in ${repo} for full details):\n${devFeedback}\nAddress every finding before closing tasks.\n\n`
          : '') +
        `Work ONLY these tasks (in order): ${streak.ids.join(', ')}\n` +
        `Confirm each is still unblocked with: bd show <id>\n` +
        `For each task:\n` +
        `  - Run: bd update <id> --claim\n` +
        `  - Implement the work described (code, tests, config -- whatever the task requires)\n` +
        `  - Run: bd close <id> when the task is complete\n` +
        `  - NEVER close a type=feature or type=bug issue -- only close type=task\n` +
        `Work all listed tasks then stop and return status "VERIFY".\n` +
        `Always return VERIFY -- never return anything else.`,
        { model: streak.model, label: doerLabel, phase: 'Develop', schema: DOER_STATUS_SCHEMA, agentType: 'doer',
          context: `tasks ${streak.ids.join(', ')}` }
      );

      if (!doerResult) {
        log(`Doer returned null (streak ${streak.model}) -- aborting`);
        abortReason = 'doer null';
        streakAbort = true;
        break;
      }

      if (doerResult.status !== 'VERIFY') {
        log(`Unexpected doer status "${doerResult.status}" -- aborting`);
        abortReason = 'unexpected doer status';
        streakAbort = true;
        break;
      }
      workedIds.push(...streak.ids);
    }

    devIter++;
    if (streakAbort) break;

    // Reviewer model matches the highest-tier model used across all streaks:
    // any opus streak -> opus; otherwise sonnet (haiku work reviewed by sonnet minimum).
    const usedModels = streakResult.streaks.map(s => s.model);
    const reviewerModel = usedModels.includes(MODEL_OPUS) ? MODEL_OPUS : MODEL_SONNET;

    // One reviewer pass covering all streaks worked this iteration.
    const reviewerLabel = `reviewer-c${cycleCount}-i${devIter}`;
    const review = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
      `Sprint epics: ${epicSummary}\nTasks worked this iteration: ${workedIds.join(', ')}\n\n` +
      `Review ONLY the work done for the tasks listed above.\n` +
      `Run: bd show <id> for each task to read its acceptance criteria.\n` +
      `Run: git -C "${repo}" diff ${base_branch}...${branch} to see the changes.\n` +
      `Do NOT comment on code or issues outside the listed tasks.\n` +
      `Check: code correctness, test coverage, adherence to each task's acceptance criteria.\n` +
      `If a task needs rework, reopen it: bd update <id> --status=open\n` +
      `CHANGES NEEDED verdict must include specific actionable feedback tied to a task ID.\n` +
      `APPROVED means all committed work meets acceptance criteria.`,
      { model: reviewerModel, label: reviewerLabel, phase: 'Develop', schema: REVIEW_SCHEMA, agentType: 'reviewer',
        context: `reviewing tasks ${workedIds.join(', ')}` }
    );
    log(`Reviewer verdict: ${review && review.verdict || 'null'}`);

    if (!approved(review)) {
      devFeedback = (review && review.notes) || '';
      log(`Reviewer feedback: ${devFeedback.slice(0, 120)}`);
      await commitFeedback(repo, branch, devFeedback, 'pm-reviewer', reviewerLabel, 'Develop');
      // Reopened tasks will show in bd ready next iteration
    } else {
      devFeedback = '';
    }
  }

  if (abortReason) break;

  // Push branch so CI can trigger, then record HEAD SHA.
  await dispatch(
    `Run: git push origin ${branch}\nIf the branch does not yet exist on origin, use: git push -u origin ${branch}`,
    { model: MODEL_HAIKU, label: `push-c${cycleCount}`, phase: 'Develop' }
  );

  const shaAgent = await dispatch(
    `Run: git rev-parse HEAD\nReturn the full SHA string.`,
    { model: MODEL_HAIKU, label: `head-sha-c${cycleCount}`, phase: 'Develop',
      schema: { type: 'object', required: ['sha'], properties: { sha: { type: 'string' } } } }
  );
  if (shaAgent && shaAgent.sha) headSha = shaAgent.sha;
  log(`HEAD SHA: ${headSha}`);

  // ---------------------------------------------------------------- INTEGRATION TEST (skip if files missing)

  if (integTestEnabled) {
    phase('Test');

    // -- Deploy --
    const deployLabel = `deployer-c${cycleCount}`;
    const deployResult = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nCycle: ${cycleCount}\n\n` +
      `Follow the integration test playbook and deploy.md:\n` +
      (cycleCount === 1
        ? `1. Run the Setup section of integ-test-playbook.md to bring up the test environment.\n`
        : `1. Run the Reset section of integ-test-playbook.md to restore pristine state.\n`) +
      `2. Follow all steps in deploy.md to deploy the build.\n` +
      `3. Run the smoke test defined in deploy.md.\n` +
      `4. Return deployed: true if the smoke test passes, false otherwise.\n` +
      `5. If deployed is false, include the error output in notes.`,
      { model: MODEL_SONNET, label: deployLabel, phase: 'Test', agentType: 'deployer',
        schema: { type: 'object', required: ['deployed'], properties: {
          deployed: { type: 'boolean' }, notes: { type: 'string' } } } }
    );

    if (!deployResult || !deployResult.deployed) {
      const msg = (deployResult && deployResult.notes) || 'no details';
      log(`Deploy failed on cycle ${cycleCount}: ${msg.slice(0, 200)}`);
      log('Skipping integration tests this cycle -- teardown and continue');
      // Teardown before next cycle
      await dispatch(
        `Run the Teardown section of integ-test-playbook.md to clean up the test environment.`,
        { model: MODEL_SONNET, label: `teardown-c${cycleCount}-fail`, phase: 'Test', agentType: 'deployer' }
      );
    } else {
      // -- Integration test run --
      const integLabel = `integ-runner-c${cycleCount}`;

      const integResult = await dispatch(
        `Repo: ${repo}\nBranch: ${branch}\nCycle: ${cycleCount}\n` +
        `Sprint epics: ${epicSummary}\n\n` +
        `Run: bd list --type=feature --status=open\n` +
        `For each open feature, execute its integration tests.\n\n` +
        `For each feature:\n` +
        `  PASS: all tests pass -> bd close <feature-id>\n` +
        `  FAIL: tests fail -> bd create --title="[integ] <description>" ` +
        `--description="Feature: <id>\\nExpected: <what>\\nActual: <what>\\nTest: <which>" ` +
        `--type=bug --priority=<1=core requirement unmet, 2=partial, 3=quality>\n` +
        `  Keep feature open on failure or if inconclusive.\n\n` +
        `Priority rules:\n` +
        `  P0: system won't start or core path completely broken\n` +
        `  P1: requirement from epic explicitly not met\n` +
        `  P2: requirement partially met, degraded behaviour\n` +
        `  P3: quality, performance, or UX issue not blocking core function\n\n` +
        `Before creating a new bug, check bd search "[integ]" -- update existing if duplicate.\n\n` +
        `Return featuresClosed (count), issuesCreated (count), summary (one paragraph).`,
        { model: MODEL_SONNET, label: integLabel, phase: 'Test', schema: INTEG_RUN_SCHEMA, agentType: 'integ-test-runner' }
      );
      if (integResult) {
        log(`Integration: ${integResult.featuresClosed} features closed, ${integResult.issuesCreated} issues created`);
        log(`Summary: ${integResult.summary}`);
      }

      // -- Teardown --
      await dispatch(
        `Run the Teardown section of integ-test-playbook.md to fully clean up the test environment.`,
        { model: MODEL_SONNET, label: `teardown-c${cycleCount}`, phase: 'Test', agentType: 'deployer' }
      );
    }
  }

  // ---------------------------------------------------------------- EXIT CHECK

  const blockers = await countBeadsBlockers(threshold, epicIds);
  const currentOpenIds = (blockers.ids || []).slice().sort();
  log(`Exit check: ${blockers.count} open issues at P<=${threshold} -- IDs: [${currentOpenIds.join(', ')}]`);

  // No-progress check: if no issue from the previous cycle was resolved, abort.
  if (cycleCount > 1 && prevOpenIds.length > 0) {
    const closedFromPrev = prevOpenIds.filter(id => !currentOpenIds.includes(id));
    if (closedFromPrev.length === 0) {
      log(`No progress in cycle ${cycleCount}: same ${prevOpenIds.length} issues unresolved -- aborting`);
      abortReason = 'no progress';
      break;
    }
    log(`Progress: ${closedFromPrev.length} issue(s) resolved this cycle`);
  }

  // Flush this cycle's dispatch ledger to sprint-logs/<branch>.jsonl in the repo.
  // One file per branch so parallel sprints never collide.
  const cycleLedger = dispatchLedger.filter(e => e.cycle === cycleCount);
  const jsonlLines = cycleLedger.map(e => JSON.stringify(e)).join('\n');
  const cycleTotal = cycleLedger.reduce((s, e) => s + e.costUsd, 0);
  log(`Cycle ${cycleCount} cost: $${cycleTotal.toFixed(4)} output across ${cycleLedger.length} dispatches`);
  await dispatch(
    `Append the following lines to ${sprintLogFile} (full path: "${repo}/${sprintLogFile}").\n` +
    `If the file does not exist, create it. If the sprint-logs/ directory does not exist, create it first:\n` +
    `  mkdir -p "${repo}/sprint-logs"\n\n` +
    `Lines to append:\n${jsonlLines}\n\n` +
    `Then commit and push:\n` +
    `  git -C "${repo}" add sprint-logs/\n` +
    `  git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit -m "chore: sprint-log cycle ${cycleCount}"\n` +
    `  git -C "${repo}" push origin ${branch}\n` +
    `Do not modify any other file.`,
    { model: MODEL_HAIKU, label: `log-flush-c${cycleCount}`, phase: integTestEnabled ? 'Test' : 'Develop',
      context: `flushing ${cycleLedger.length} dispatch records` }
  );

  if (blockers.count === 0) {
    epicDone = true;
    log(`Goal met after ${cycleCount} cycle(s)`);
    break;
  }

  prevOpenIds = currentOpenIds;
}

// ------------------------------------------------------------------ CI CHECK

phase('Harvest');

let ciResult = null;
if (headSha) {
  ciResult = await dispatch(
    `Check CI status for commit ${headSha} on branch ${branch}.\n` +
    `Run: gh run list --branch ${branch} --limit 3 --json status,conclusion,databaseId\n` +
    `If runs exist and are in_progress: poll with gh run watch <id> (timeout 10 min).\n` +
    `If runs exist and conclusion is "success": return status "green".\n` +
    `If runs exist and conclusion is "failure": return status "red" with notes (include run URL).\n` +
    `If no runs found: return status "not_configured".\n` +
    `Do not block for more than 10 minutes total.`,
    { model: MODEL_HAIKU, label: 'ci-watcher', phase: 'Harvest', schema: CI_SCHEMA, agentType: 'ci-watcher' }
  );

  if (ciResult) {
    log(`CI status: ${ciResult.status}`);
    if (ciResult.status === 'not_configured') {
      log('CI not configured -- creating beads task');
      await dispatch(
        `Run: bd create --title="Add CI pipeline to project" ` +
        `--description="The auto-sprint workflow found no CI runs for branch ${branch}. ` +
        `CI is required for the sprint exit gate. ` +
        `This task covers: choosing a CI provider, writing the workflow config, and verifying it triggers on push." ` +
        `--type=task --priority=2\n` +
        `Then run: bd show <new-id> and confirm it was created.`,
        { model: MODEL_HAIKU, label: 'ci-task-create', phase: 'Harvest' }
      );
      log('ACTION REQUIRED: Set up CI for this project. Task created in beads.');
    } else if (ciResult.status === 'red') {
      log(`CI FAILED: ${(ciResult.notes || '').slice(0, 200)}`);
      log('Proceeding to harvest with CI failure noted in PR.');
    }
  }
}

// ------------------------------------------------------------------ FINAL REVIEW

const finalReviewLabel = 'final-reviewer';
const finalReview = await dispatch(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  `Sprint epics: ${epicSummary}\nGoal: ${goal}\n` +
  (abortReason ? `Sprint ended early: ${abortReason}. Review what was completed.\n` : '') +
  (epicDone ? `Goal was met: all P<=${threshold} issues resolved.\n` : `Goal not yet met.\n`) +
  `\nReview the overall output of this sprint:\n` +
  `  - Does the work address the original epics?\n` +
  `  - Are there obvious gaps or regressions?\n` +
  `  - Is the codebase in a releasable state for what was completed?\n` +
  `APPROVED means the work is ready to harvest and raise as a PR.\n` +
  `CHANGES NEEDED means critical issues were found; include specific findings in notes.`,
  { model: MODEL_OPUS, label: finalReviewLabel, phase: 'Harvest', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
);
log(`Final review: ${finalReview && finalReview.verdict || 'null'}`);

if (!approved(finalReview)) {
  const notes = (finalReview && finalReview.notes) || '';
  log(`Final review not approved -- aborting before harvest. Notes: ${notes.slice(0, 300)}`);
  return { cycles: cycleCount, epicDone, goal, abortReason: abortReason || 'final review rejected', finalReviewNotes: notes };
}

// ------------------------------------------------------------------ HARVEST

// Read the sprint log JSONL so we can compute estimate-vs-actual in pure JS.
const logReader = await dispatch(
  `Read the sprint cost log and return its entries as structured data.\n\n` +
  `Run: test -f "${sprintLogFile}" && cat "${sprintLogFile}" || echo "[]"\n\n` +
  `The file is JSONL (one JSON object per line). Parse each line and return all entries in the entries array.\n` +
  `If the file is missing or empty, return { entries: [] }.`,
  { model: MODEL_HAIKU, label: 'log-reader', phase: 'Harvest', schema: LOG_DATA_SCHEMA }
);
const logEntries = (logReader && logReader.entries) || dispatchLedger;

// Compute estimate-vs-actual analysis entirely in JS.
const sprintAnalysis = computeSprintAnalysis(sprintQuote, logEntries, calibration, cycleCount);
log('Sprint cost analysis computed (JS):\n' + sprintAnalysis.analysisText);

const harvestLabel = 'harvester';
const harvestResult = await dispatch(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  `Sprint epics: ${epicSummary}\nCycles completed: ${cycleCount}\nGoal met: ${epicDone}\n` +
  `sprintLogFile: ${sprintLogFile}\n\n` +
  `The sprint is complete. Harvest the sprint artefacts.\n` +
  `Follow your runbook (agents/harvester.md).\n\n` +
  `costAnalysis (insert this block verbatim into CHANGELOG.md after the summary paragraph):\n` +
  `${sprintAnalysis.analysisText}\n` +
  `Final review notes to include in CHANGELOG:\n` +
  `${(finalReview && finalReview.notes) || '(none)'}\n\n` +
  `Return status "OK" if successful, "FAILED" with notes otherwise.`,
  { model: MODEL_SONNET, label: harvestLabel, phase: 'Harvest', schema: HARVEST_SCHEMA, agentType: 'harvester' }
);

if (!harvestResult || harvestResult.status !== 'OK') {
  log(`Harvest failed: ${(harvestResult && harvestResult.notes) || 'null'} -- skipping PR`);
  return { cycles: cycleCount, epicDone, goal, harvest: 'failed' };
}

// ------------------------------------------------------------------ CALIBRATION UPDATE
// Update historical averages in calibration.json after every successful sprint.
// All arithmetic is in JS; the haiku agent only writes the resulting JSON file.

const updatedCalibration = computeUpdatedCalibration(calibration, sprintAnalysis, setup.startedAt);
const calibrationJson = JSON.stringify(updatedCalibration, null, 2);
await dispatch(
  `Write updated calibration file and commit.\n\n` +
  `Step 1: Ensure sprint-logs/ directory exists: mkdir -p "${repo}/sprint-logs"\n` +
  `Step 2: Write this JSON to "${repo}/sprint-logs/calibration.json" exactly as provided below:\n\n` +
  calibrationJson + `\n\n` +
  `Step 3: Commit the file:\n` +
  `  git -C "${repo}" add sprint-logs/calibration.json\n` +
  `  git -C "${repo}" commit -m "chore: update sprint calibration after ${cycleCount} cycle(s) on ${branch}"\n\n` +
  `If the file content is unchanged, the commit may be a no-op -- that is fine.\n` +
  `Return "OK" when done.`,
  { model: MODEL_HAIKU, label: 'calibration-update', phase: 'Harvest' }
);

// ------------------------------------------------------------------ PR

await dispatch(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Title: summarise what was implemented across ${cycleCount} cycle(s).\n` +
  `Body:\n` +
  `  - What was built (per epic)\n` +
  `  - Sprint goal: ${goal} -- ${epicDone ? 'MET' : 'NOT MET (partial delivery)'}\n` +
  `  - Cycles run: ${cycleCount}\n` +
  `  - Open items carried forward (if any): bd list --status=open and summarise\n` +
  `  - Final review notes: ${(finalReview && finalReview.notes) || '(none)'}\n` +
  (headSha && ciResult && ciResult.status !== 'green'
    ? `  - CI: ${ciResult.status} -- see notes\n` : '') +
  `  - Token cost summary from: bd memories auto-sprint`,
  { model: MODEL_SONNET, label: 'harvest-pr', phase: 'Harvest' }
);

// ------------------------------------------------------------------ COST SUMMARY
// Pure JS -- no agent call. Groups dispatchLedger by role (derived from label prefix)
// and by model, prints a table, and reports total sprint cost.

const roleOf = label => label.replace(/-c\d.*$/, '');  // "doer-c1-i0-haiku" -> "doer"

const byRole = {};
for (const e of dispatchLedger) {
  const role = roleOf(e.label);
  if (!byRole[role]) byRole[role] = { costUsd: 0, outTokens: 0, calls: 0 };
  byRole[role].costUsd    += e.costUsd;
  byRole[role].outTokens  += e.outTokens;
  byRole[role].calls      += 1;
}

const sprintTotal = dispatchLedger.reduce((s, e) => s + e.costUsd, 0);

log('\n=== Sprint cost summary (output tokens only) ===');
for (const [role, s] of Object.entries(byRole).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
  log(`  ${role.padEnd(20)} $${s.costUsd.toFixed(4).padStart(8)}  ${String(s.outTokens).padStart(8)} tok  ${s.calls} call(s)`);
}
log(`  ${'TOTAL'.padEnd(20)} $${sprintTotal.toFixed(4).padStart(8)}`);
log(`  (input token cost not included -- see ${sprintLogFile} for per-dispatch detail)`);
log('================================================\n');

return { cycles: cycleCount, epicDone, goal, harvest: 'ok', sprintCostUsd: parseFloat(sprintTotal.toFixed(4)) };
