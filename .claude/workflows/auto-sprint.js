export const meta = {
  name: 'auto-sprint',
  description: `Multi-cycle sprint workflow: plan -> develop -> test -> harvest.

args must be a JSON object (not a string) with these fields:
  issues       REQUIRED. Array of beads issue IDs (sprint roots), e.g. ["BD-1","BD-2"].
  branch       REQUIRED. Sprint branch name, e.g. "feat/auth". Created if it does not exist.
  goal         Optional. Exit when no open issues at or above this priority. "P1" | "P1/P2" | "P1/P2/P3". Default: "P1/P2".
  max_cycles   Optional. Hard cycle ceiling. Default: 5.
  base_branch  Optional. PR target branch. Default: "main".
  requirementsFile  Optional. Path to an additional context file for the planner.

Minimal invocation example: { "issues": ["BD-7"], "branch": "feat/my-feature" }`,
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
//   planner           -- reads open beads sprint goals/features/bugs, creates feature+task DAG
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
//   issues           -- beads issue IDs to implement (sprint roots), e.g. ["BD-1","BD-2"] (required)
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
const rootIds          = Array.isArray(rawIssues) ? rawIssues : [rawIssues];
const goal             = opts.goal             || 'P1/P2';
const maxCycles        = Number(opts.max_cycles) || 5;
const requirementsFile = opts.requirementsFile  || '';
const base_branch      = opts.base_branch       || 'main';

if (rootIds.length === 0) {
  log('ERROR: at least one beads issue ID is required (pass as arg: /auto-sprint BD-1)');
  return { error: 'missing issues' };
}

// Goal -> numeric priority threshold.
// Exit when open issues in sprint-goal subtree at priority <= threshold reaches zero.
const GOAL_THRESHOLD = { 'P1': 1, 'P1/P2': 2, 'P1/P2/P3': 3 };
const threshold = GOAL_THRESHOLD[goal] || 2;

// PURE_FUNCTIONS_BEGIN -- extracted by test/sprint-cost.test.mjs via vm; keep this block self-contained

// Provider-agnostic tier names. These are the only strings that appear in
// calibration.json and in dispatch calls. Provider-specific model IDs live
// exclusively in TIER_TO_MODEL below -- the single place to update when models change.
const TIER_CHEAP    = 'cheap';
const TIER_STANDARD = 'standard';
const TIER_PREMIUM  = 'premium';

// Claude model IDs -- change here only, nowhere else in this file.
const TIER_TO_MODEL = {
  [TIER_CHEAP]:    'claude-haiku-4-5',
  [TIER_STANDARD]: 'claude-sonnet-4-6',
  [TIER_PREMIUM]:  'claude-opus-4-8',
};

// Legacy aliases kept so existing dispatch call-sites (model: MODEL_OPUS etc.) are unchanged.
const MODEL_OPUS   = TIER_PREMIUM;
const MODEL_SONNET = TIER_STANDARD;
const MODEL_HAIKU  = TIER_CHEAP;

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

const SETUP_SCHEMA = {
  type: 'object', required: ['repo', 'branch', 'deployMdExists', 'playbookExists', 'startedAt'],
  properties: {
    repo:           { type: 'string' },
    branch:         { type: 'string' },
    deployMdExists: { type: 'boolean' },
    playbookExists: { type: 'boolean' },
    startedAt:      { type: 'string', description: 'yyyymmdd_hhmmss from date +%Y%m%d_%H%M%S' },
    calibrationRaw: { type: 'string' },  // verbatim stdout of cat calibration.json; JS parses it
    transcriptDir:  { type: 'string', description: 'Directory where subagent JSONL conversation logs are written (best-effort; may be empty string if not resolvable)' },
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
// planDone   -- true if the sprint goal already has children AND every feature has at
//               least one task with non-empty acceptance criteria; skip plan loop.
// inProgressIds -- tasks currently in_progress; reset to open before the develop
//                  loop so a crashed doer never orphans work forever.

// ------------------------------------------------------------------ helpers

function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.trim() === 'APPROVED';
}

// Live pricing for dispatch cost tracking. Initialized from DEFAULT_CALIBRATION;
// synced to calibration.json values after setup() returns.
// Prices are output tokens only in USD per 1M. Source: Anthropic pricing 2026-06-04.
// Keys are tier names (cheap/standard/premium), not model IDs.
// See also: sprint-logs/calibration.json model_prices_per_1m_output_tokens.
let OUTPUT_PRICE_PER_M = {
  [TIER_CHEAP]:    5.00,
  [TIER_STANDARD]: 15.00,
  [TIER_PREMIUM]:  25.00,
};

// ------------------------------------------------------------------ CALIBRATION DEFAULTS
// Single source of truth for all estimation constants. On first sprint run the setup
// agent writes this to sprint-logs/calibration.json; subsequent runs read that file.
// To change prices or buckets: update this object -- the file is regenerated next run.
const DEFAULT_CALIBRATION = {
  _doc: 'Sprint cost calibration. All estimation constants live here -- nothing is hardcoded in agents. Fields named _doc are documentation strings; skip them when reading values. The historical section is written automatically by the harvester after each sprint; do not edit it manually.',
  schema_version: 1,
  model_prices_per_1m_output_tokens: {
    _doc: 'USD per 1M output tokens, keyed by tier name (cheap/standard/premium). Source: Anthropic published pricing 2026-06-04. Update when pricing changes. Provider-specific model IDs are resolved from tier names in auto-sprint.js TIER_TO_MODEL -- they never appear in this file.',
    [TIER_CHEAP]:    5.00,
    [TIER_STANDARD]: 15.00,
    [TIER_PREMIUM]:  25.00,
  },
  role_models: {
    _doc: "Tier name per workflow role. 'doer' and 'reviewer' are NOT here -- the planner sets tier per task in beads metadata; reviewer escalates to max(task_tier, standard). Change an entry here to reroute a role to a different tier.",
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
  doer_model_fallback: {
    _doc: 'Tier assumed for doer cost estimation when a task has no tier metadata in beads. In practice the planner always sets tier metadata -- this is a safety net only.',
    model: TIER_STANDARD,
  },
  reviewer_model_rule: {
    _doc: 'Reviewer tier is max(doer_task_tier, minimum). If the doer used premium, reviewer uses premium; otherwise reviewer uses standard. This mirrors the reviewerModel selection in auto-sprint.js.',
    minimum: TIER_STANDARD,
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

// Reviewer tier mirrors auto-sprint dispatch logic: max(taskTier, standard).
function reviewerModelFor(taskModel) {
  return taskModel === TIER_PREMIUM ? TIER_PREMIUM : TIER_STANDARD;
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
    if (typeof tokens !== 'number') continue;
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
    if (typeof tokens !== 'number') continue;
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

// accumulateBucketTokens: join doer log entries back to their S/M/L buckets.
// Each doer dispatch entry carries label 'doer-c<N>-i<M>' and context
// 'tasks A, B, C'. We map every listed task ID to its bucket (via the
// id->bucket map built from taskAssignments) and attribute the entry's
// outTokens to those buckets, split evenly across the listed IDs that resolve
// to a known bucket. Returns { S?:{tokens,n}, M?:..., L?:... } -- only buckets
// that were actually exercised appear (absent buckets stay absent so
// computeSprintQuote keeps using its calibration defaults).
function accumulateBucketTokens(logEntries, taskAssignments) {
  const bucketOf = {};
  for (const t of (taskAssignments || [])) {
    if (t && t.id != null && t.bucket != null) bucketOf[String(t.id)] = t.bucket;
  }
  const acc = {};
  for (const e of (logEntries || [])) {
    const label = e.label || '';
    if (label.replace(/-c\d.*$/, '') !== 'doer') continue;       // doer entries only
    const tokens = e.outTokens || 0;
    if (tokens <= 0) continue;
    const ctx = String(e.context || '');
    const m   = ctx.match(/tasks\s+(.+)$/i);
    if (!m) continue;
    const ids = m[1].split(',').map(s => s.trim()).filter(Boolean);
    // Resolve each listed ID to a bucket; skip IDs we can't map.
    const buckets = ids.map(id => bucketOf[id]).filter(b => b != null);
    if (buckets.length === 0) continue;
    const share = tokens / buckets.length;                       // even split
    for (const b of buckets) {
      if (!acc[b]) acc[b] = { tokens: 0, n: 0 };
      acc[b].tokens += share;
      acc[b].n      += 1;
    }
  }
  return acc;
}

function computeUpdatedCalibration(calibration, analysis, startedAt, taskAssignments, logEntries) {
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
    if (data.tokens === 0) continue;
    const avg    = data.tokens / data.dispatches;
    const prev_r = hist.roles[role] || { avg_output_tokens: null, sample_n: 0 };
    hist.roles[role] = {
      avg_output_tokens: blend(prev_r.avg_output_tokens, avg),
      sample_n: prev_r.sample_n + data.dispatches,
    };
  }

  const doerTok = analysis.byRole['doer']?.tokens     || 0;
  const revTok  = analysis.byRole['reviewer']?.tokens || 0;
  if (doerTok > 0) hist.reviewer_ratio_avg = blend(hist.reviewer_ratio_avg, revTok / doerTok);

  // bucket_avg_tokens join: attribute each doer log entry's outTokens to the
  // S/M/L bucket(s) of the task IDs in its context string, then blend the
  // per-bucket average into hist.bucket_avg_tokens using the same sprints_sampled
  // accounting as roles above. Buckets with no data this sprint keep their prior
  // value untouched (and unexercised buckets stay absent), so computeSprintQuote
  // defaults still apply where we have no history.
  hist.bucket_avg_tokens = hist.bucket_avg_tokens || {};
  const bucketAcc = accumulateBucketTokens(logEntries, taskAssignments);
  for (const [bucket, data] of Object.entries(bucketAcc)) {
    if (data.n === 0) continue;
    const avg = data.tokens / data.n;
    hist.bucket_avg_tokens[bucket] = blend(hist.bucket_avg_tokens[bucket], avg);
  }

  return { ...calibration, historical: hist };
}

// ---- shell-dispatch parsers (pure) -------------------------------------------
// These parse the outputs[] array returned by the bounded Haiku shell dispatches
// (countBeadsBlockers / getReadyStreaks / checkCycleState). Factoring the parse
// logic out keeps it unit-testable and guarantees a single, side-effect-free
// parse path -- the dispatch wrappers never loop or branch on parse failure, they
// just feed outputs here and accept whatever this returns.
//
// `outputs` is the agent-returned array of strings (one per command). `rootCount`
// is the number of leading `bd graph` ID-list commands; the final element is the
// JSON list command. All functions degrade safely on missing/garbage input.

// collectSubtreeIds: union the IDs from the leading rootCount whitespace-joined
// ID-list outputs (one per sprint goal) into a Set.
function collectSubtreeIds(outputs, rootCount) {
  const ids = new Set();
  for (let i = 0; i < rootCount; i++) {
    String(outputs[i] || '').trim().split(/\s+/).filter(Boolean).forEach(id => ids.add(id));
  }
  return ids;
}

// parseBlockers: contract {count, ids} of open issues with priority<=threshold inside
// the sprint-goal subtree. Missing/short outputs => sentinel {count: 999, ids: []} so the
// caller treats blockers as present (fail-safe, never exits the sprint early).
// openListIdx is the explicit index of the open-issues JSON command in outputs[].
function parseBlockers(outputs, rootCount, openListIdx, threshold) {
  if (!Array.isArray(outputs) || outputs.length < openListIdx + 1) return { count: 999, ids: [] };
  const subtree = collectSubtreeIds(outputs, rootCount);
  let ids = [];
  try {
    const open = JSON.parse(outputs[openListIdx]);
    ids = Array.isArray(open)
      ? open.filter(x => subtree.has(x.id) && x.p <= threshold).map(x => x.id)
      : [];
  } catch { ids = []; }
  return { count: ids.length, ids };
}

// parseReadyStreaks: contract {totalCount, streaks[]} grouping ready tasks in the
// subtree by model, ordered by min priority.
// readyListIdx is the explicit index of the ready-tasks JSON command in outputs[].
function parseReadyStreaks(outputs, rootCount, readyListIdx, defaultModel) {
  if (!Array.isArray(outputs) || outputs.length < readyListIdx + 1) return { totalCount: 0, streaks: [] };
  const subtree = collectSubtreeIds(outputs, rootCount);
  let readyTasks = [];
  try {
    const all = JSON.parse(outputs[readyListIdx]);
    readyTasks = Array.isArray(all) ? all.filter(t => subtree.has(t.id)) : [];
  } catch { readyTasks = []; }

  // Hoist the known-tiers set and reverse map outside the loop (constant across tasks).
  const KNOWN_TIERS = new Set([TIER_CHEAP, TIER_STANDARD, TIER_PREMIUM]);
  const MODEL_TO_TIER = Object.fromEntries(Object.entries(TIER_TO_MODEL).map(([t, id]) => [id, t]));

  const byModel = {};
  for (const t of readyTasks) {
    const rawModel = t.m || defaultModel;
    // Normalise: if the stored value is a provider-specific model ID rather than a tier
    // name, resolve it back to a tier so dispatch() works correctly. This handles tasks
    // created before the cheap/standard/premium tier rename. Uses console.warn (not log)
    // so it is safe when this block is extracted into a vm/require context for testing.
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

// parseCycleState: contract {planDone, inProgressIds}. planDone is true for a
// sprint goal when it has >=1 feature and either all features closed or every task has a
// description. Missing/short outputs => {planDone: false, ...} (fail-safe: never
// declares planning complete on bad input).
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

// buildSprintSummary assembles a structured human-readable end-of-sprint summary
// from already-computed inputs. Pure function -- no I/O.
//
// Parameters:
//   analysis      -- result of computeSprintAnalysis (analysisText, byRole, actualCycles, totActUsd...)
//   sprintQuote   -- result of computeSprintQuote or null
//   calibration   -- current calibration object
//   opts          -- { branch, goal, goalMet, cycleCount, tasksCompleted, tasksOpen, startedAt }
//
// Returns: { summaryText }  -- markdown string suitable for writing to .analysis.md
function buildSprintSummary(analysis, sprintQuote, calibration, opts) {
  const { branch = '', goal = '', goalMet = false, cycleCount = 0,
          tasksCompleted = 0, tasksOpen = 0, startedAt = '' } = opts || {};
  const thr  = (calibration && calibration.outlier_thresholds) || { outlier_pct: 200, calibration_failure_pct: 500 };
  const cycles = (calibration && calibration.cycle_assumptions) || {};
  const estCycles = cycles.expected || 1;

  // ---- goal / cycle section
  const goalLine    = `**Goal:** ${goal || '(unset)'}  ->  ${goalMet ? 'MET' : 'NOT MET'}`;
  const cyclesLine  = `**Cycles:** estimated ${estCycles}, actual ${cycleCount}`;
  const tasksLine   = `**Tasks:** ${tasksCompleted} completed, ${tasksOpen} open/carried-forward`;

  // ---- cost table (re-use the analysisText already computed)
  const costSection = analysis ? analysis.analysisText : '(no cost analysis available)';

  // ---- outlier role suggestions
  // sprintQuote.tasks have shape {id,bucket,model,doerTokens,reviewerTokens,outputUsd} -- no `role` field.
  // Estimates per role:
  //   doer     -> sum of t.doerTokens     across all tasks, scaled by estCycles
  //   reviewer -> sum of t.reviewerTokens across all tasks, scaled by estCycles
  //   overhead -> calibration.fixed_overhead_tokens[role_key] (log-flush scaled by estCycles)
  const overhead = (calibration && calibration.fixed_overhead_tokens) || {};
  const suggestions = [];
  if (analysis && analysis.byRole) {
    for (const [role, data] of Object.entries(analysis.byRole)) {
      if (!data.tokens) continue;
      let estTokensForRole = 0;
      if (role === 'doer') {
        if (!sprintQuote) continue;
        estTokensForRole = (sprintQuote.tasks || [])
          .reduce((s, t) => s + (t.doerTokens || 0), 0) * estCycles;
      } else if (role === 'reviewer') {
        if (!sprintQuote) continue;
        estTokensForRole = (sprintQuote.tasks || [])
          .reduce((s, t) => s + (t.reviewerTokens || 0), 0) * estCycles;
      } else {
        // overhead role: look up in fixed_overhead_tokens (keys use underscores)
        const key = role.replace(/-/g, '_');
        const tok = overhead[key];
        if (typeof tok !== 'number') continue;
        // log-flush runs once per cycle; other overhead roles run once per sprint
        estTokensForRole = role === 'log-flush' ? tok * estCycles : tok;
      }
      if (estTokensForRole <= 0) continue;
      const pctOver = (data.tokens - estTokensForRole) / estTokensForRole * 100;
      if (Math.abs(pctOver) > thr.outlier_pct) {
        const dir = pctOver > 0 ? 'over' : 'under';
        suggestions.push(
          `- \`${role}\` actual ${Math.round(Math.abs(pctOver))}% ${dir} estimate -> ` +
          `consider ${pctOver > 0 ? 'bumping' : 'reducing'} \`fixed_overhead_tokens.${role.replace(/-/g, '_')}\` or bucket sizes`
        );
      }
    }
  }
  const suggestSection = suggestions.length
    ? `### Suggested calibration adjustments\n\n${suggestions.join('\n')}\n`
    : `### Suggested calibration adjustments\n\n_No outliers detected -- calibration looks good._\n`;

  const summaryText =
    `# Sprint summary: ${branch}\n\n` +
    `**Started:** ${startedAt || '(unknown)'}  \n` +
    `${goalLine}  \n` +
    `${cyclesLine}  \n` +
    `${tasksLine}\n\n` +
    `---\n\n` +
    `### Cost analysis\n\n` +
    costSection + `\n` +
    `---\n\n` +
    suggestSection;

  return { summaryText };
}

// PURE_FUNCTIONS_END

function outputCostUsd(tier, tokens) {
  const rate = OUTPUT_PRICE_PER_M[tier] || OUTPUT_PRICE_PER_M[TIER_STANDARD];
  return (tokens / 1_000_000) * rate;
}

// Resolve a tier name to the provider-specific model ID for agent() dispatch.
// Falls back to standard tier if the tier is unrecognised.
function resolveModel(tier) {
  return TIER_TO_MODEL[tier] || TIER_TO_MODEL[TIER_STANDARD];
}

// Real output-token cost via differential budget.spent() snapshots.
// budget.spent() is the only actual usage the harness exposes (output tokens only).
// opts.model is a tier name (cheap/standard/premium); resolved to a model ID for agent().
// opts.context -- short human string describing what was worked (e.g. "tasks BD-5,BD-6")
let cycleCostUsd = 0;
const dispatchLedger = [];  // accumulates across all cycles; flushed to sprint-logs/<branch>.jsonl per cycle

async function dispatch(prompt, opts) {
  const tier = opts.model || TIER_STANDARD;
  const modelId = resolveModel(tier);
  const before = budget.spent();
  const result = await agent(prompt, { ...opts, model: modelId });
  const outTokens = budget.spent() - before;
  const cost = outputCostUsd(tier, outTokens);
  cycleCostUsd += cost;
  const entry = {
    cycle:   cycleCount === 0 ? 'setup' : cycleCount,
    phase:   opts.phase  || '?',
    label:   opts.label  || '?',
    model:   tier,
    context: opts.context || '',
    outTokens,
    costUsd: parseFloat(cost.toFixed(4)),
  };
  dispatchLedger.push(entry);
  if (outTokens > 0) log(`$${cost.toFixed(4)} ${opts.label || '?'} -- ${opts.context || opts.phase || '?'}`);
  return result;
}


// ------------------------------------------------------------ shell dispatch
//
// All three exit-check helpers below run a tiny, fixed set of read-only commands
// (`bd graph --json <goal-id> | node-extract` plus one `bd list ... | node-extract`)
// via a single Haiku dispatch and parse the result with a pure parser above.
//
// Latency-hardening (gh-7: check-blockers once took 12.5 min):
//   * Root cause -- the dispatch prompt said "return each command's stdout
//     verbatim" against a strict array-of-strings schema, with NO turn cap. A
//     stray escaping/parse concern on the (potentially large) `bd graph` output
//     made the agent re-run commands and re-emit output across many turns, so a
//     5-second job could burn minutes. The node extractors already shrink output
//     to an ID list / tiny JSON, so the only real failure mode was looping.
//   * Fix -- (a) every shell dispatch is a SINGLE-ATTEMPT contract: maxTurns is
//     bounded to (#commands + 1), so the agent physically cannot loop for
//     minutes; (b) the prompt is explicit that it must run each command exactly
//     once and never retry/re-run; (c) parsing is fully tolerant (pure parsers
//     return a fail-safe sentinel on bad/short output) so there is never a reason
//     to bounce work back to the agent.
const SHELL_DISPATCH_PROMPT_HEADER =
  `Run each command below EXACTLY ONCE, in order. Return each command's stdout ` +
  `as one string element of outputs[] (same order; outputs.length must equal the ` +
  `number of commands).\n` +
  `Rules: do NOT summarize, reformat, interpret, or escape the output. Do NOT ` +
  `re-run any command. Do NOT retry on empty or unexpected output -- an empty ` +
  `string is a valid result; just return it. This is a single attempt: run, ` +
  `capture, return, stop.\n\n`;

function buildShellPrompt(cmds) {
  return SHELL_DISPATCH_PROMPT_HEADER + cmds.map((c, i) => `${i + 1}. ${c}`).join('\n');
}

// Bound the agent to one turn per command plus a single wrap-up turn. The harness
// stops the dispatch at maxTurns, so a misbehaving agent cannot stall for minutes.
function shellMaxTurns(cmds) {
  return cmds.length + 1;
}

async function dispatchShell(cmds, opts) {
  return dispatch(buildShellPrompt(cmds), {
    schema: SHELL_OUTPUTS_SCHEMA,
    maxTurns: shellMaxTurns(cmds),
    ...opts,
  });
}

// Run multiple async operations in parallel and return all results.
// This is a convenience wrapper around Promise.all() for readability.
async function parallel(tasks) {
  return Promise.all(tasks);
}

async function countBeadsBlockers(thr, roots) {
  // Extract only IDs from bd graph to keep output small (avoids $(cat ...) file-reference issue).
  const idExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).issues.map(i=>i.id).join(' '))}catch{}"`;
  const openExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority}))))}catch{console.log('[]')}"`;
  const cmds = [
    ...roots.map(id => `bd graph --json ${id} | ${idExtract}`),
    `bd list --status=open --json | ${openExtract}`,
  ];
  const r = await dispatchShell(cmds, { model: MODEL_HAIKU, label: 'check-blockers', phase: 'Develop' });
  return parseBlockers(r?.outputs, roots.length, roots.length, thr);
}

async function getReadyStreaks(rootIds) {
  // Extract only IDs from bd graph to keep output small (avoids $(cat ...) file-reference issue).
  const idExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).issues.map(i=>i.id).join(' '))}catch{}"`;
  const taskExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority,m:(i.metadata||{}).model}))))}catch{console.log('[]')}"`;
  const cmds = [
    ...rootIds.map(id => `bd graph --json ${id} | ${idExtract}`),
    `bd list --ready --type=task --json | ${taskExtract}`,
  ];
  const r = await dispatchShell(cmds, { model: MODEL_HAIKU, label: 'ready-streaks', phase: 'Develop' });
  return parseReadyStreaks(r?.outputs, rootIds.length, rootIds.length, TIER_STANDARD);
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

async function checkCycleState(rootIds) {
  // Extract only the fields needed for planDone check to keep output small.
  const graphExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const issues=(JSON.parse(d).issues||[]);console.log(JSON.stringify(issues.map(i=>({id:i.id,t:i.issue_type,s:i.status,d:!!(i.description||'').trim()}))))}catch{console.log('[]')}"`;
  const ipExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).map(i=>i.id).join(' '))}catch{}"`;
  const cmds = [
    ...rootIds.map(id => `bd graph --json ${id} | ${graphExtract}`),
    `bd list --status=in_progress --type=task --json | ${ipExtract}`,
  ];
  const r = await dispatchShell(cmds, { model: MODEL_HAIKU, label: 'cycle-state', phase: 'Plan' });
  return parseCycleState(r?.outputs, rootIds.length);
}

// ------------------------------------------------------------------ STATE

let cycleCount   = 0;
let goalMet     = false;
let prevOpenIds  = [];
let headSha      = '';
let abortReason  = '';

// ------------------------------------------------------------------ SETUP

phase('Plan');

// Phase 1: deterministic setup steps -- run via dispatchShell so each command
// executes exactly once with a bounded turn cap (no LLM looping on simple checks).
//
// Fixed output indices (always 6 elements regardless of branch/no-branch):
//   0: repo root (git rev-parse --show-toplevel)
//   1: branch checkout result (or "no-op" when branch was not specified)
//   2: confirmed branch name (git rev-parse --abbrev-ref HEAD)
//   3: startedAt timestamp (date +%Y%m%d_%H%M%S)
//   4: deploy.md exists (YES/NO)
//   5: integ-test-playbook.md exists (YES/NO)
const setupShellCmds = [
  `git rev-parse --show-toplevel`,
  branch
    ? `git checkout "${branch}" 2>/dev/null || git checkout --track "origin/${branch}" 2>/dev/null || git checkout -b "${branch}"`
    : `echo "no-op"`,
  `git rev-parse --abbrev-ref HEAD`,
  `date +%Y%m%d_%H%M%S`,
  `test -f deploy.md && echo YES || echo NO`,
  `test -f integ-test-playbook.md && echo YES || echo NO`,
];
const setupShell = await dispatchShell(setupShellCmds, {
  model: MODEL_HAIKU, label: 'setup-shell', phase: 'Plan',
});

const _outs = setupShell && Array.isArray(setupShell.outputs) ? setupShell.outputs : [];
const _detectedRepo    = (_outs[0] || '').trim();
const _detectedBranch  = (_outs[2] || '').trim();
const _detectedTs      = (_outs[3] || '').trim();
const _deployExists    = (_outs[4] || '').trim() === 'YES';
const _playbookExists  = (_outs[5] || '').trim() === 'YES';

if (!_detectedRepo || !_detectedBranch) {
  log('ERROR: setup-shell failed -- could not detect repo root or branch');
  return { error: 'setup failed' };
}

// Phase 2: free-form setup steps (permissions merge, calibration, transcript dir).
// maxTurns: 20 backstop prevents a runaway agent from stalling indefinitely.
const setup = await dispatch(
  `Sprint workspace setup (Phase 2 -- deterministic steps already done).\n\n` +
  `Pre-known values (do NOT re-run these commands):\n` +
  `  repo:           ${_detectedRepo}\n` +
  `  branch:         ${_detectedBranch}\n` +
  `  startedAt:      ${_detectedTs}\n` +
  `  deployMdExists: ${_deployExists}\n` +
  `  playbookExists: ${_playbookExists}\n\n` +
  `Your job is only Steps 5-7 below. Return ALL fields in your schema response,\n` +
  `including the pre-known values above.\n\n` +
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
  `    Run: cat sprint-logs/calibration.json\n` +
  `    Return the exact stdout of that command as the "calibrationRaw" field (verbatim -- do not reformat or summarize).\n` +
  `  If it does NOT exist (first run):\n` +
  `    Create the sprint-logs/ directory: mkdir -p sprint-logs\n` +
  `    Write the following JSON exactly to sprint-logs/calibration.json:\n` +
  JSON.stringify(DEFAULT_CALIBRATION, null, 2) + `\n` +
  `    Return that same JSON text verbatim as the "calibrationRaw" field.\n\n` +
  `Step 7: Resolve transcript directory.\n` +
  `  Claude subagent conversation logs (JSONL) are stored under:\n` +
  `    $HOME/.claude/projects/<project-slug>/\n` +
  `  where <project-slug> is derived from the repo absolute path by uppercasing the\n` +
  `  drive letter and replacing path separators with dashes.\n` +
  `  Run: ls "$HOME/.claude/projects/" 2>/dev/null\n` +
  `  Find the entry whose slug matches the repo path (e.g. repo=/c/foo/bar -> C--foo-bar).\n` +
  `  If found, return the full path as transcriptDir. If not found, return an empty string.\n\n` +
  `Return repo (absolute path), branch (confirmed), deployMdExists, playbookExists, startedAt, calibrationRaw, transcriptDir.`,
  { model: MODEL_HAIKU, label: 'setup', phase: 'Plan', schema: SETUP_SCHEMA, maxTurns: 20 }
);

if (!setup || !setup.repo || !setup.branch) {
  log('ERROR: setup failed -- could not assert branch or locate repo');
  return { error: 'setup failed' };
}

const repo = setup.repo;
branch = setup.branch;  // use the confirmed/detected branch for all subsequent agent prompts

// Refuse to run a sprint directly on a protected branch -- all work must go on a feature branch.
if (branch === 'main' || branch === 'master') {
  log(`ERROR: sprint branch resolved to "${branch}" -- refusing to run on a protected branch. Pass a branch arg to create or switch to a sprint branch.`);
  return { error: 'protected branch' };
}

// Parse calibration from the raw string the setup agent returned verbatim.
// Deep-merge with DEFAULT_CALIBRATION so any missing/new field always has a valid value.
// historical gets its own merge because it accumulates real sprint history on top of the zeros.
let _parsedCalib = {};
try { _parsedCalib = JSON.parse(setup.calibrationRaw || '{}'); } catch {}
const calibration = Object.assign({}, DEFAULT_CALIBRATION, _parsedCalib, {
  historical:                      Object.assign({}, DEFAULT_CALIBRATION.historical,                      _parsedCalib.historical                      || {}),
  complexity_buckets:              _parsedCalib.complexity_buckets              || DEFAULT_CALIBRATION.complexity_buckets,
  model_prices_per_1m_output_tokens: _parsedCalib.model_prices_per_1m_output_tokens || DEFAULT_CALIBRATION.model_prices_per_1m_output_tokens,
  role_models:                     _parsedCalib.role_models                     || DEFAULT_CALIBRATION.role_models,
  fixed_overhead_tokens:           _parsedCalib.fixed_overhead_tokens           || DEFAULT_CALIBRATION.fixed_overhead_tokens,
  cycle_assumptions:               _parsedCalib.cycle_assumptions               || DEFAULT_CALIBRATION.cycle_assumptions,
  reviewer_ratio:                  _parsedCalib.reviewer_ratio                  || DEFAULT_CALIBRATION.reviewer_ratio,
  input_cost_multiplier:           _parsedCalib.input_cost_multiplier           || DEFAULT_CALIBRATION.input_cost_multiplier,
  outlier_thresholds:              _parsedCalib.outlier_thresholds              || DEFAULT_CALIBRATION.outlier_thresholds,
});
// Sync output prices from loaded calibration so dispatchLedger uses correct rates.
Object.assign(OUTPUT_PRICE_PER_M, calibration.model_prices_per_1m_output_tokens || {});

// State for cost estimation -- populated after plan is APPROVED.
let sprintQuote = null;
// taskAssignments (id->bucket->model) from the last approved plan-review.
// Held at workflow scope so computeUpdatedCalibration can join doer log entries
// back to S/M/L buckets at sprint close without re-querying beads.
let taskAssignments = [];

// Derive a filename-safe version of the branch for sprint-logs/.
// Replaces path separators and non-safe chars with dashes so that parallel
// sprints on different branches never write to the same file.
// Timestamp (yyyymmdd_hhmmss) is captured by the setup agent so it stays
// stable across workflow resumes (Date.now() is banned in workflow scripts).
const sprintLogBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'default';
const sprintLogFile = `sprint-logs/${sprintLogBranch}-${setup.startedAt}.jsonl`;
const integTestEnabled = setup.deployMdExists && setup.playbookExists;
// startedAt "20260622_020952" -> ISO "2026-06-22T02:09:52Z" (pure string, no Date.now())
const sprintTs = setup.startedAt.replace(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6Z');
let flushedCount = 0;  // how many dispatchLedger entries have been appended to sprintLogFile

// Appends only the NEW (not yet flushed) ledger entries to the sprint log file.
// Fire-and-forget: does NOT await, and does NOT commit or push.
// The next natural committer (doer/sprint-meta/beads-export-cleanup) picks the file
// up via 'git add sprint-logs/' or 'git add -A'. The final-cycle entries are captured
// by an unconditional 'git add sprint-logs/' in beads-export-cleanup.
async function appendNewEntries(label, phase) {
  const newEntries = dispatchLedger.slice(flushedCount);
  if (newEntries.length === 0) return;
  // ts placeholder is replaced by the agent with the real wall-clock time at flush,
  // not the fixed sprint-start timestamp, so each flush batch gets its own timestamp.
  const lines = newEntries.map(e => JSON.stringify({ ts: '__FLUSH_TS__', ...e })).join('\n');
  flushedCount = dispatchLedger.length;  // update before dispatch so log-append entry goes in next batch
  dispatch(  // intentionally NOT awaited -- fire-and-forget write to disk only
    `Step 1: Run: date +%Y-%m-%dT%H:%M:%S%z\n` +
    `Save the output as FLUSH_TS (e.g. "2026-06-22T22:15:30+0530").\n\n` +
    `Step 2: Append (do NOT overwrite) the following lines to ${sprintLogFile} (full path: "${repo}/${sprintLogFile}").\n` +
    `If the file does not exist, create it. If the sprint-logs/ directory does not exist, create it first:\n` +
    `  mkdir -p "${repo}/sprint-logs"\n\n` +
    `In the lines below, replace every occurrence of "__FLUSH_TS__" with the FLUSH_TS value from Step 1.\n` +
    `Lines to append (one JSON object per line):\n${lines}\n\n` +
    `Do not commit, push, or modify any other file. Write the lines to disk and stop.`,
    { model: MODEL_HAIKU, label: `log-append-${label}`, phase: phase || 'Develop',
      context: `${newEntries.length} new entries` }
  );
}

log(`Repo: ${repo} | Branch: ${setup.branch}`);
log(`deploy.md: ${setup.deployMdExists} | integ-test-playbook.md: ${setup.playbookExists}`);
if (!setup.deployMdExists) log('WARNING: deploy.md not found -- integration test phase will be skipped');
if (!setup.playbookExists) log('WARNING: integ-test-playbook.md not found -- integration test phase will be skipped');
if (!integTestEnabled) log('Integration testing disabled for this sprint. Harvest will run after Develop.');

const rootSummary = rootIds.join(', ');
log(`Sprint goals: ${rootSummary} | Goal: ${goal} (P<=${threshold}) | Max cycles: ${maxCycles}`);

// ------------------------------------------------------------------ SPRINT META RECORD
// Write the first JSONL entry (type=meta) capturing sprint metadata and transcript dir.
// This is benign for existing consumers: computeSprintAnalysis skips entries without a label.
{
  const metaLine = JSON.stringify({
    ts: sprintTs, type: 'meta',
    branch, startedAt: setup.startedAt,
    roots: rootIds, goal,
    transcriptDir: setup.transcriptDir || '',
  });
  await dispatch(
    `Write sprint meta record and commit.\n\n` +
    `Step 1: Ensure sprint-logs/ directory exists:\n` +
    `  mkdir -p "${repo}/sprint-logs"\n\n` +
    `Step 2: Append (do NOT overwrite) the following line to ${sprintLogFile} (full path: "${repo}/${sprintLogFile}").\n` +
    `  If the file does not exist, create it first.\n\n` +
    `Line:\n${metaLine}\n\n` +
    `Step 3: Commit and push:\n` +
    `  git -C "${repo}" add sprint-logs/\n` +
    `  git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit -m "chore: sprint-meta ${branch} ${setup.startedAt}"\n` +
    `  git -C "${repo}" push origin ${branch}\n` +
    `Do not modify any other file. Return "OK" when done.`,
    { model: MODEL_HAIKU, label: 'sprint-meta', phase: 'Plan' }
  );
}

// ------------------------------------------------------------------ SPRINT LOOP

while (cycleCount < maxCycles) {
  cycleCount++;
  cycleCostUsd = 0;
  log(`\n=== Cycle ${cycleCount}/${maxCycles} | goal: ${goal} ===`);

  // ---------------------------------------------------------------- RESUME CHECK + CYCLE CHECKPOINT

  phase('Plan');

  // Write per-cycle checkpoint entry and check cycle state in parallel -- no data dependency.
  // The cycle-checkpoint uses type='cycle-start' (distinct from the one-time type='meta' above).
  const cycleCheckpointLine = JSON.stringify({
    ts: sprintTs, type: 'cycle-start', cycle: cycleCount, branch,
  });
  const [, cycleState] = await Promise.all([
    dispatch(
      `Append (do NOT overwrite) the following line to ${sprintLogFile} (full path: "${repo}/${sprintLogFile}").\n` +
      `If the file does not exist, create it. If the sprint-logs/ directory does not exist, create it first:\n` +
      `  mkdir -p "${repo}/sprint-logs"\n\n` +
      `Line:\n${cycleCheckpointLine}\n\n` +
      `Do not commit, push, or modify any other file. Write the line to disk and stop.`,
      { model: MODEL_HAIKU, label: `cycle-meta-c${cycleCount}`, phase: 'Plan' }
    ),
    checkCycleState(rootIds),
  ]);
  log(`Cycle state: planDone=${cycleState.planDone} inProgress=[${cycleState.inProgressIds.join(', ')}]`);

  // Reset any tasks orphaned in_progress from a previous crashed run.
  if (cycleState.inProgressIds.length > 0) {
    log(`Resetting ${cycleState.inProgressIds.length} orphaned in_progress task(s) to open`);
    const resetCmds = cycleState.inProgressIds.map(id => `bd update ${id} --status=open`);
    await dispatchShell(resetCmds, {
      model: MODEL_HAIKU,
      label: 'reset-orphans',
      phase: 'Plan',
    });
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
      `Sprint goals: ${rootSummary}\n` +
      (requirementsFile ? `Additional context: ${requirementsFile}\n` : '') +
      `\n` +
      (planFeedback
        ? `Plan-reviewer feedback from the previous round (read feedback.md in ${repo} for full details):\n${planFeedback}\nAddress every item before proceeding.\n\n`
        : '') +
      `Inspect existing state first:\n` +
      `  ${rootIds.map(id => `bd show ${id} && bd graph --compact ${id}`).join('\n  ')}\n` +
      `Run: bd show <id> on any existing features/tasks to read their current descriptions.\n` +
      `Then build or complete the feature+task DAG -- create only what is missing:\n` +
      `  - BEFORE creating any feature or task, run: bd search "<title>" --status all\n` +
      `    If a matching issue already exists, update it instead of creating a duplicate.\n` +
      `\n` +
      `DEPENDENCY WIRING -- read this carefully. "bd dep add A B" means A CANNOT CLOSE until B is done.\n` +
      `The correct wiring direction is: parents depend on children (children unblock first).\n` +
      `\n` +
      `  Step 1 -- wire sprint goal -> child (goal waits for children):\n` +
      `    bd dep add <goal-id> <child-id>\n` +
      `    After this: "bd ready" will NOT show the sprint goal (it's waiting). Children show as ready.\n` +
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
      `  VERIFY after wiring: run "bd ready" -- it must return impl tasks, NOT sprint goals or blocked parents.\n` +
      `  If sprint goals appear in "bd ready" the deps are backwards -- fix them before continuing.\n` +
      `\n` +
      `  IMPORTANT: Each task belongs to exactly ONE feature. Never share a task across features.\n` +
      `\n` +
      `  Break each sprint goal into child issues: bd create --parent <goal-id> (use type=feature for sub-goals, type=task for leaf work).\n` +
      `  Create type=task issues for each feature: implementation tasks AND integration\n` +
      `    test development tasks (prefix test tasks with "[test]" in the title)\n` +
      `  Features P1/P2; tasks one level below their parent feature (P1 feature -> P2 tasks, P2 feature -> P3 tasks)\n` +
      `  Each task must be completable in one agent session (1-3 file changes max)\n` +
      `  Every task needs clear acceptance criteria in its description\n` +
      `  - Assign each task a tier AND complexity bucket based on complexity -- after creating or updating each\n` +
      `    task, run: bd update <id> --set-metadata model=<tier>\n` +
      `    Available tiers and when to use them:\n` +
      `      ${TIER_CHEAP}    -- mechanical work: rename, config tweak, move file, simple wiring\n` +
      `      ${TIER_STANDARD} -- standard work: new function, test suite, API endpoint, refactor\n` +
      `      ${TIER_PREMIUM}  -- hard work: architecture, multi-file design, ambiguous requirements\n` +
      `    Complexity buckets (S/M/L) are assigned by the plan-reviewer based on task scope.\n` +
      `    Every task MUST receive a bucket assignment -- tasks without a bucket cannot be cost-estimated.\n` +
      `  - Group tasks so consecutive tasks in dependency order share a tier where\n` +
      `    possible -- this minimises tier-switching overhead during execution\n` +
      (cycleCount > 1
        ? `This is cycle ${cycleCount}. Focus on open issues only.\n` +
          `Do NOT add new scope beyond the original sprint goals and open bugs/enhancements.\n` +
          `Do NOT re-create tasks that are already closed.\n`
        : '') +
      `Confirm with any text when done.`,
      { model: MODEL_OPUS, label: plannerLabel, phase: 'Plan', agentType: 'planner',
        context: `planning sprint goals ${rootSummary}` }
    );

    if (!plannerResult) {
      log(`Planner returned null on cycle ${cycleCount} round ${pi} -- retrying`);
      continue;
    }

    const planReviewerLabel = `plan-reviewer-c${cycleCount}-r${pi}`;
    const planReview = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nSprint goals: ${rootSummary}\n` +
      `Calibration file: ${repo}/sprint-logs/calibration.json (read this first if it exists)\n\n` +
      `Review the beads DAG for these sprint goals ONLY: ${rootSummary}\n` +
      `Run: ${rootIds.map(id => `bd show ${id}`).join(' && ')} to inspect each sprint goal.\n` +
      `Run: ${rootIds.map(id => `bd graph --compact ${id}`).join(' && ')} for the full dependency subtree.\n` +
      `Run: bd show <id> to inspect individual issues in depth.\n` +
      `Run: bd ready -- this is your FIRST correctness check.\n` +
      `Do NOT review or comment on issues outside these sprint goals.\n\n` +
      `Follow your runbook (plan-reviewer.md) step by step:\n` +
      `  Steps 1-2: inspect the DAG and check all quality criteria.\n` +
      `  Step 3: classify each task -- assign complexity bucket (S/M/L) and read its model\n` +
      `    from beads metadata. If a task has no model metadata, note it in your verdict\n` +
      `    notes as a warning but do NOT return CHANGES NEEDED for it -- the workflow has a fallback.\n` +
      `  Step 4: return verdict, notes, and taskAssignments (id + bucket + model per task).\n\n` +
      `Notes must be specific: include issue IDs and exact "bd dep add" commands to fix\n` +
      `any dependency direction problems.`,
      { model: MODEL_SONNET, label: planReviewerLabel, phase: 'Plan', schema: PLAN_REVIEW_SCHEMA, agentType: 'plan-reviewer',
        context: `reviewing plan for sprint goals ${rootSummary}` }
    );

    if (approved(planReview)) {
      planApproved = true;
      log(`Plan APPROVED on cycle ${cycleCount} round ${pi + 1}`);

      // Persist taskAssignments at workflow scope for the calibration join at sprint close.
      taskAssignments = planReview.taskAssignments || [];

      // Compute sprint cost quote in pure JS -- no agent does arithmetic.
      sprintQuote = computeSprintQuote(taskAssignments, calibration);
      const sc = sprintQuote.scenarios;
      log(`Sprint quote (${sprintQuote.calibrationSource}, ${taskAssignments.length} tasks): ` +
          `output-only: opt=$${sc.optimistic.outputOnly.toFixed(3)} ` +
          `exp=$${sc.expected.outputOnly.toFixed(3)} ` +
          `pess=$${sc.pessimistic.outputOnly.toFixed(3)} ` +
          `| true-est (x${sprintQuote.inputMultiplier.toFixed(1)}): ` +
          `exp=$${sc.expected.total.toFixed(3)}`);

      // Write per-task cost estimates and commit the plan snapshot in a single dispatchShell.
      // All commands are pre-built in JS from taskAssignments -- Haiku only executes them.
      // bd export runs AFTER the cost-note writes so the snapshot captures updated task notes.
      const planCommitCmds = [
        ...sprintQuote.tasks.map(t =>
          `bd update ${t.id} --notes="cost-estimate: bucket=${t.bucket} model=${t.model} ` +
          `doer_tokens=${t.doerTokens} reviewer_tokens=${t.reviewerTokens} output_usd=${t.outputUsd.toFixed(4)}"`
        ),
        `bd export -o "${repo}/.beads/issues.jsonl"`,
        `git -C "${repo}" add .beads/issues.jsonl`,
        `git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit --allow-empty -m "plan: approve task DAG"`,
        `git -C "${repo}" push origin ${branch}`,
      ];
      await dispatchShell(planCommitCmds, {
        model: MODEL_HAIKU, label: `plan-commit-c${cycleCount}`, phase: 'Plan',
        maxTurns: planCommitCmds.length + 2,
      });
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
    const streakResult = await getReadyStreaks(rootIds);
    if (streakResult.totalCount === 0) {
      log(`No ready tasks -- develop phase complete (${devIter} iterations)`);
      break;
    }
    log(`Ready: ${streakResult.totalCount} task(s) across ${streakResult.streaks.length} model streak(s)`);

    // Dispatch one doer per model streak; collect all worked task IDs for the reviewer.
    const workedIds = [];
    let streakAbort = false;

    for (const streak of streakResult.streaks) {
      const doerLabel = `doer-c${cycleCount}-i${devIter}-${streak.model}`;
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
        `  - Run: bd close <id> immediately after verify and commit, BEFORE claiming the next task\n` +
        `  - Closed tasks are durable even if the doer crashes mid-streak\n` +
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

    // Reviewer tier matches the highest tier used across all streaks:
    // any premium streak -> premium; otherwise standard (cheap work reviewed at standard minimum).
    const usedModels = streakResult.streaks.map(s => s.model);
    const reviewerModel = usedModels.includes(TIER_PREMIUM) ? TIER_PREMIUM : TIER_STANDARD;

    // One reviewer pass covering all streaks worked this iteration.
    const reviewerLabel = `reviewer-c${cycleCount}-i${devIter}`;
    const review = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
      `Sprint goals: ${rootSummary}\nTasks worked this iteration: ${workedIds.join(', ')}\n\n` +
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
      // Fire-and-forget: write feedback.md to disk only -- next doer's 'git add -A' picks it up.
      // The plan-reviewer commitFeedback (below) MUST remain awaited and commit+push so the
      // planner can read it from remote. Dev-path feedback is local-only.
      dispatch(
        `Repo: ${repo}\nBranch: ${branch}\n\n` +
        `Write the following reviewer feedback to feedback.md (overwrite if it exists):\n\n` +
        `${devFeedback}\n\n` +
        `Do not commit, push, or run any other command. Write the file to disk and stop.`,
        { model: MODEL_HAIKU, label: `feedback-write-${reviewerLabel}`, phase: 'Develop' }
      );  // intentionally NOT awaited
      // Reopened tasks will show in bd ready next iteration
    } else {
      devFeedback = '';
    }

    // JIT flush: append this iteration's entries immediately so the log grows as work lands.
    await appendNewEntries(`iter-c${cycleCount}-i${devIter}`, 'Develop');
  }

  if (abortReason) break;

  // Push branch so CI can trigger and record HEAD SHA in a single dispatchShell.
  const pushShaResult = await dispatchShell(
    [
      `git push origin ${branch} 2>&1 || git push -u origin ${branch} 2>&1`,
      `git rev-parse HEAD`,
    ],
    { model: MODEL_HAIKU, label: `push-sha-c${cycleCount}`, phase: 'Develop' }
  );
  if (pushShaResult && Array.isArray(pushShaResult.outputs) && pushShaResult.outputs[1]) {
    headSha = pushShaResult.outputs[1].trim();
  }
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
        `Sprint goals: ${rootSummary}\n\n` +
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
        `  P1: requirement from sprint goal explicitly not met\n` +
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

      // JIT flush: append test-phase entries (deployer, integ-runner, teardown) immediately.
      await appendNewEntries(`test-c${cycleCount}`, 'Test');
    }
  }

  // ---------------------------------------------------------------- EXIT CHECK
  // Merge final getReadyStreaks + countBeadsBlockers into one dispatchShell to avoid
  // running bd graph twice on the same roots. Command ordering (strict):
  //   [0..N-1] bd graph root0..rootN-1  (shared by both parsers)
  //   [N]      bd list --status=open    (openListIdx = rootCount)
  //   [N+1]    bd list --ready          (readyListIdx = rootCount+1)
  // Fallback: if outputs.length < rootCount+2, fall back to two separate dispatches.

  let blockers;
  {
    const _idExtract   = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).issues.map(i=>i.id).join(' '))}catch{}"`;
    const _openExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority}))))}catch{console.log('[]')}"`;
    const _taskExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority,m:(i.metadata||{}).model}))))}catch{console.log('[]')}"`;
    const exitCmds = [
      ...rootIds.map(id => `bd graph --json ${id} | ${_idExtract}`),
      `bd list --status=open --json | ${_openExtract}`,
      `bd list --ready --type=task --json | ${_taskExtract}`,
    ];
    const exitResult = await dispatchShell(exitCmds, { model: MODEL_HAIKU, label: 'exit-check', phase: 'Develop' });
    if (exitResult?.outputs && exitResult.outputs.length >= rootIds.length + 2) {
      blockers = parseBlockers(exitResult.outputs, rootIds.length, rootIds.length, threshold);
      // Ready streaks prefetched but not used: develop loop already determined no ready tasks.
      // Parsed here to validate the merged output; result discarded at cycle end.
      parseReadyStreaks(exitResult.outputs, rootIds.length, rootIds.length + 1, TIER_STANDARD);
    } else {
      // Fallback: outputs too short (agent returned partial results) -- use separate dispatches.
      log('exit-check: outputs.length < rootCount+2 -- falling back to separate dispatches');
      blockers = await countBeadsBlockers(threshold, rootIds);
    }
  }
  const currentOpenIds = (blockers.ids || []).slice().sort();
  log(`Exit check: ${blockers.count} open issues at P<=${threshold} -- IDs: [${currentOpenIds.join(', ')}]`);

  // Straggler flush: catches plan-phase, push, head-sha, check-blockers, and any entries
  // not yet appended (e.g. when integ tests are disabled, or on abortReason paths).
  const cycleLedger = dispatchLedger.filter(e => e.cycle === cycleCount);
  const cycleTotal = cycleLedger.reduce((s, e) => s + e.costUsd, 0);
  log(`Cycle ${cycleCount} cost: $${cycleTotal.toFixed(4)} output across ${cycleLedger.length} dispatches`);
  await appendNewEntries(`end-c${cycleCount}`, integTestEnabled ? 'Test' : 'Develop');

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

  if (blockers.count === 0) {
    goalMet = true;
    log(`Goal met after ${cycleCount} cycle(s)`);
    break;
  }

  prevOpenIds = currentOpenIds;
}

// ------------------------------------------------------------------ FINAL REVIEW

phase('Harvest');

const finalReviewLabel = 'final-reviewer';
const finalReview = await dispatch(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  `Sprint goals: ${rootSummary}\nGoal: ${goal}\n` +
  (abortReason ? `Sprint ended early: ${abortReason}. Review what was completed.\n` : '') +
  (goalMet ? `Goal was met: all P<=${threshold} issues resolved.\n` : `Goal not yet met.\n`) +
  `\nReview the overall output of this sprint:\n` +
  `  - Does the work address the original sprint goals?\n` +
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
  return { cycles: cycleCount, goalMet, goal, abortReason: abortReason || 'final review rejected', finalReviewNotes: notes };
}

// ------------------------------------------------------------------ HARVEST

const logEntries = dispatchLedger;

// Compute estimate-vs-actual analysis entirely in JS.
const sprintAnalysis = computeSprintAnalysis(sprintQuote, logEntries, calibration, cycleCount);
log('Sprint cost analysis computed (JS):\n' + sprintAnalysis.analysisText);

// Build structured summary and write sprint-logs/<branch>-<ts>.analysis.md artefact.
const tasksCompleted = goalMet
  ? (sprintQuote ? sprintQuote.tasks.length : 0)
  : Math.max(0, (sprintQuote ? sprintQuote.tasks.length : 0) - prevOpenIds.length);
const tasksOpen = goalMet ? 0 : prevOpenIds.length;
const sprintSummary = buildSprintSummary(sprintAnalysis, sprintQuote, calibration, {
  branch, goal, goalMet, cycleCount, tasksCompleted, tasksOpen, startedAt: setup.startedAt,
});
log('Sprint summary:\n' + sprintSummary.summaryText);
const analysisArtifactFile = `sprint-logs/${sprintLogBranch}-${setup.startedAt}.analysis.md`;

const harvestLabel = 'harvester';
const harvestResult = await dispatch(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  `Sprint goals: ${rootSummary}\nCycles completed: ${cycleCount}\nGoal met: ${goalMet}\n` +
  `sprintLogFile: ${sprintLogFile}\n` +
  `analysisArtifactFile: ${analysisArtifactFile}\n\n` +
  `The sprint is complete. Harvest the sprint artefacts.\n` +
  `Follow your runbook (agents/harvester.md).\n\n` +
  `IMPORTANT: Your FIRST action (Step 1 of your runbook) is to write the analysis artifact below ` +
  `to "${repo}/${analysisArtifactFile}" and commit it before doing anything else.\n\n` +
  `analysisText (write this verbatim to ${analysisArtifactFile}):\n` +
  sprintSummary.summaryText + `\n\n` +
  `costAnalysis (insert this block verbatim into CHANGELOG.md after the summary paragraph):\n` +
  `${sprintAnalysis.analysisText}\n` +
  `Final review notes to include in CHANGELOG:\n` +
  `${(finalReview && finalReview.notes) || '(none)'}\n\n` +
  `Return status "OK" if successful, "FAILED" with notes otherwise.`,
  { model: MODEL_SONNET, label: harvestLabel, phase: 'Harvest', schema: HARVEST_SCHEMA, agentType: 'harvester' }
);

if (!harvestResult || harvestResult.status !== 'OK') {
  log(`Harvest failed: ${(harvestResult && harvestResult.notes) || 'null'} -- writing analysis fallback`);
  // JS fallback: write .analysis.md directly from in-memory analysisText so the artifact
  // is preserved in branch history even when the harvester agent is killed or crashes.
  const safeContent = sprintSummary.summaryText.replace(/'/g, "'\\''");
  await dispatchShell(
    [
      `mkdir -p "${repo}/sprint-logs"`,
      `printf '%s' '${safeContent}' > "${repo}/${analysisArtifactFile}"`,
      `git -C "${repo}" add "${analysisArtifactFile}"`,
      `git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit --allow-empty -m "chore: sprint-analysis fallback ${branch} ${setup.startedAt}"`,
    ],
    { model: MODEL_HAIKU, label: 'harvest-analysis-fallback', phase: 'Harvest' }
  );
  log(`Analysis artifact written via fallback: ${analysisArtifactFile}`);
  return { cycles: cycleCount, goalMet, goal, harvest: 'failed' };
}

// ------------------------------------------------------------------ CALIBRATION UPDATE + CLOSE GOALS (parallel)
// Update historical averages in calibration.json after every successful sprint.
// All arithmetic is in JS; the haiku agent only writes the resulting JSON file.
// The doer closes tasks; the original sprint-goal epics must be closed explicitly.
// These have no data dependency between them, so run in parallel.

const updatedCalibration = computeUpdatedCalibration(calibration, sprintAnalysis, setup.startedAt, taskAssignments, logEntries);
const calibrationJson = JSON.stringify(updatedCalibration, null, 2);

await parallel([
  dispatch(
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
  ),
  dispatch(
    `Close the delivered sprint goals in beads.\n\n` +
    `Run:\n` +
    rootIds.map(id => `  bd close ${id} --reason="implemented in sprint ${branch}"`).join('\n') + `\n\n` +
    `If an issue is already closed, bd close is a no-op. Return "OK" when done.`,
    { model: MODEL_HAIKU, label: 'close-sprint-goals', phase: 'Harvest' }
  ),
]);

// ------------------------------------------------------------------ BEADS EXPORT + SCAFFOLD CLEANUP

// Export beads state so committed .beads/*.jsonl reflects all closed P1 issues.
// Also remove sprint process files (requirements.md, feedback.md) from the PR net diff.
// Step 1 stages any sprint-log entries written by fire-and-forget appendNewEntries
// calls so the final cycle's JSONL lines are captured even when no later doer runs.
await dispatch(
  `Persist beads state and clean sprint scaffolding from the PR diff.\n\n` +
  `Step 1 -- Stage sprint-logs and evict scaffold files from the working tree (unconditional):\n` +
  `  git -C "${repo}" add sprint-logs/\n` +
  `  git -C "${repo}" rm -f feedback.md requirements.md 2>/dev/null || true\n` +
  `  rm -f "${repo}/feedback.md" "${repo}/requirements.md" 2>/dev/null || true\n\n` +
  `Step 2 -- Export beads state:\n` +
  `  bd export -o "${repo}/.beads/issues.jsonl"\n` +
  `  git -C "${repo}" add .beads/issues.jsonl\n` +
  `  git -C "${repo}" diff --cached --quiet || git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit -m "chore: export beads state"\n` +
  `  (The "diff --cached --quiet || commit" pattern only commits if something actually changed.)\n\n` +
  `Step 3 -- Check what process files are still in the PR diff:\n` +
  `  git -C "${repo}" diff --name-only ${base_branch}...${branch}\n\n` +
  `Step 4 -- For each of requirements.md, feedback.md that appears in the diff:\n` +
  `  a) Check if the file existed on ${base_branch}:\n` +
  `       git -C "${repo}" ls-tree --name-only ${base_branch} | grep -F <filename>\n` +
  `  b) If NOT on base (sprint created it): git -C "${repo}" rm --force <filepath>\n` +
  `  c) If on base (sprint modified it): git -C "${repo}" checkout ${base_branch} -- <filepath>\n` +
  `  After handling all such files:\n` +
  `    git -C "${repo}" add -A\n` +
  `    git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit -m "chore: drop sprint scaffolding"\n` +
  `  (If no scaffold files remain in diff, skip the commit.)\n\n` +
  `Step 5 -- Verify the diff is clean:\n` +
  `  git -C "${repo}" diff --name-only ${base_branch}...${branch}\n` +
  `  The output must NOT contain requirements.md or feedback.md. If it does, repeat Step 4.\n\n` +
  `Step 6 -- Push all local commits to remote:\n` +
  `  git -C "${repo}" push origin ${branch}\n\n` +
  `Return "OK" when done.`,
  { model: MODEL_HAIKU, label: 'beads-export-cleanup', phase: 'Harvest' }
);

// ------------------------------------------------------------------ PR

const harvestPr = await dispatch(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Title: summarise what was implemented across ${cycleCount} cycle(s).\n` +
  `Body:\n` +
  `  - What was built (per sprint goal)\n` +
  `  - Sprint goal: ${goal} -- ${goalMet ? 'MET' : 'NOT MET (partial delivery)'}\n` +
  `  - Cycles run: ${cycleCount}\n` +
  `  - Open items carried forward (if any): bd list --status=open and summarise\n` +
  `  - Final review notes: ${(finalReview && finalReview.notes) || '(none)'}\n` +
  `  - Token cost summary from: bd memories auto-sprint\n\n` +
  `After creating the PR, return its number as prNumber (integer).`,
  { model: MODEL_SONNET, label: 'harvest-pr', phase: 'Harvest',
    schema: { type: 'object', required: ['prNumber'], properties: { prNumber: { type: 'number' }, prUrl: { type: 'string' } } } }
);
const prNumber = harvestPr && harvestPr.prNumber;

// ------------------------------------------------------------------ CI CHECK (post-PR)

let ciResult = null;
if (prNumber) {
  ciResult = await dispatch(
    `Check CI status for PR #${prNumber} on branch ${branch}.\n` +
    `Run: gh run list --pr ${prNumber} --limit 3 --json status,conclusion,databaseId\n` +
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
    }

    // Append CI result to the PR body so the note lands after the PR is created.
    if (ciResult.status !== 'green') {
      await dispatch(
        `Annotate PR #${prNumber} with the CI status result.\n\n` +
        `Run: gh pr comment ${prNumber} --body "**CI status: ${ciResult.status}**${ciResult.notes ? '\\n\\n' + ciResult.notes : ''}"`,
        { model: MODEL_HAIKU, label: 'ci-pr-annotate', phase: 'Harvest' }
      );
    }
  }
}

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

return { cycles: cycleCount, goalMet, goal, harvest: 'ok', sprintCostUsd: parseFloat(sprintTotal.toFixed(4)) };
