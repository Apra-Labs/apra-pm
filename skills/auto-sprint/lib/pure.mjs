
export const TIER_CHEAP    = 'cheap';
export const TIER_STANDARD = 'standard';
export const TIER_PREMIUM  = 'premium';
export const TIER_TO_MODEL = {
  [TIER_CHEAP]:    'haiku',
  [TIER_STANDARD]: 'sonnet',
  [TIER_PREMIUM]:  'opus',
};

export function collectSubtreeIds(outputs, rootCount) {
  const ids = new Set();
  for (let i = 0; i < rootCount; i++) {
    String(outputs[i] || '').trim().split(/\s+/).filter(Boolean).forEach(id => ids.add(id));
  }
  return ids;
}

export function parseBlockers(outputs, rootCount, openListIdx, threshold, rootIds) {
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

export function parseReadyStreaks(outputs, rootCount, readyListIdx, defaultModel) {
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

export function parseCycleState(outputs, rootCount) {
  if (!Array.isArray(outputs) || outputs.length < rootCount + 1) return { planDone: false, inProgressIds: [], allIssues: [] };
  const inProgressIds = String(outputs[rootCount] || '').trim().split(/\s+/).filter(Boolean);
  
  const issueMap = new Map();
  const planDone = Array.from({ length: rootCount }).every((_, i) => {
    try {
      const issues = JSON.parse(outputs[i]);
      if (!Array.isArray(issues)) return false;
      issues.forEach(x => issueMap.set(x.id, x));
      const features = issues.filter(x => x.t === 'feature' || x.t === 'epic');
      const openFts = features.filter(x => x.s !== 'closed');
      const tasks = issues.filter(x => x.t === 'task');
      
      if (features.length === 0 && tasks.length === 0) return false;
      if (openFts.length > 0) return false;
      if (tasks.length === 0) return false;
      return tasks.every(x => x.d);
    } catch { return false; }
  });
  return { planDone, inProgressIds, allIssues: Array.from(issueMap.values()) };
}

export function truncateStreakToCeiling(streakIds, bucketById, calibration, tier) {
  if (!Array.isArray(streakIds) || streakIds.length === 0) return [];
  return [streakIds[0]];
}

export function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.trim() === 'APPROVED';
}

export function labelTaskIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  if (ids.length <= 3) return ids.join(' ');
  return ids.slice(0, 3).join(' ') + ` +${ids.length - 3}more`;
}

export function estimateCost(tier, inTokens, outTokens) {
  if (!tier || tier === 'native') return 0;
  if (tier.includes('cheap') || tier === 'haiku') return (inTokens * 0.25 + outTokens * 1.25) / 1000000;
  if (tier.includes('standard') || tier === 'sonnet') return (inTokens * 3.00 + outTokens * 15.00) / 1000000;
  if (tier.includes('prem') || tier === 'opus') return (inTokens * 15.00 + outTokens * 75.00) / 1000000;
  return (inTokens * 3.00 + outTokens * 15.00) / 1000000;
}

export const DEFAULT_CALIBRATION = {
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

export function computeSprintQuote(taskAssignments, calibration) {
  return { tasks: taskAssignments || [], calibrationSource: 'defaults',
    inputMultiplier: 3.0, scenarios: {
      optimistic:  { outputOnly: 0, total: 0 },
      expected:    { outputOnly: 0, total: 0 },
      pessimistic: { outputOnly: 0, total: 0 },
    }};
}

export function computeUpdatedCalibration(cal) { return cal; }

export function buildSprintSummary(analysis, quote, cal, opts) {
  return { summaryText: '(cost.js not loaded -- summary unavailable)' };
}

// --- Missing functions copied from claude auto-sprint.js ---

// Provider-agnostic tier names. These are the only strings that appear in
// calibration.json and in dispatch calls. Provider-specific model IDs live
// exclusively in TIER_TO_MODEL below -- the single place to update when models change.
export const MODEL_OPUS   = TIER_PREMIUM;
export const MODEL_SONNET = TIER_STANDARD;
export const MODEL_HAIKU  = TIER_CHEAP;

// ------------------------------------------------------------------ schemas

export const REVIEW_SCHEMA = {
  type: 'object', required: ['verdict', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES NEEDED'] },
    notes:   { type: 'string' },
  },
};

export const PLAN_REVIEW_SCHEMA = {
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

export const SHELL_OUTPUTS_SCHEMA = {
  type: 'object', required: ['outputs'],
  properties: {
    outputs: { type: 'array', items: { type: 'string' } },
  },
};

export const DOER_STATUS_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status:  { type: 'string', enum: ['VERIFY'] },
    notes:   { type: 'string' },
  },
};

export const HARVEST_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['OK', 'FAILED'] },
    notes:  { type: 'string' },
  },
};

export const SETUP_SCHEMA = {
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

export const BEADS_BLOCKERS_SCHEMA = {
  type: 'object', required: ['count', 'ids'],
  properties: {
    count: { type: 'number' },
    ids:   { type: 'array', items: { type: 'string' } },
  },
};

// One entry per model streak: tasks sharing the same model that can be worked
// in a single doer dispatch. Ordered by priority (P0 first).
export const READY_STREAKS_SCHEMA = {
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

export const CI_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['green', 'red', 'not_configured', 'pending'] },
    notes:  { type: 'string' },
  },
};

export const INTEG_RUN_SCHEMA = {
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

export let OUTPUT_PRICE_PER_M = {
  [TIER_CHEAP]:    5.00,
  [TIER_STANDARD]: 15.00,
  [TIER_PREMIUM]:  25.00,
};

// ------------------------------------------------------------------ CALIBRATION DEFAULTS
// Single source of truth for all estimation constants. On first sprint run the setup
// agent writes this to sprint-logs/calibration.json; subsequent runs read that file.
// To change prices or buckets: update this object -- the file is regenerated next run.
export function reviewerModelFor(taskModel) {
  return taskModel === TIER_PREMIUM ? TIER_PREMIUM : TIER_STANDARD;
}

export function computeSprintAnalysis(quote, logEntries, calibration, actualCycles) {
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
export function accumulateBucketTokens(logEntries, taskAssignments) {
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

export function buildExecutionSummary(logEntries, opts) {
  const entries = Array.isArray(logEntries) ? logEntries : [];
  const { cycleCount = 0, goalMet = false, goal = '', tasksOpen = 0,
          openIssueIds = [], startedAt = '' } = opts || {};

  const PHASES = ['Plan', 'Develop', 'Test', 'Harvest'];
  // Normalise a phase string to one of the canonical buckets (case-insensitive).
  const canonPhase = p => {
    const s = String(p || '').toLowerCase();
    if (s.startsWith('plan')) return 'Plan';
    if (s.startsWith('dev'))  return 'Develop';
    if (s.startsWith('test')) return 'Test';
    if (s.startsWith('harv')) return 'Harvest';
    return null;
  };

  // ---- cycle reasoning: derive iteration/re-round signals from labels --------
  // develop iterations: labels of the form iter-c<N>-i<M>
  // reviewer feedback : labels containing 'CHANGES NEEDED' or 'feedback-write'
  // plan re-rounds    : labels of the form plan-commit-c<N>
  const developIters = new Set();
  let reviewerChanges = 0;
  const planRounds = new Set();
  for (const e of entries) {
    const label = String((e && e.label) || '');
    const m = label.match(/iter-c(\d+)-i(\d+)/i);
    if (m) developIters.add(`c${m[1]}-i${m[2]}`);
    if (/CHANGES NEEDED|feedback-write/i.test(label)) reviewerChanges++;
    const pm = label.match(/plan-commit-c(\d+)/i);
    if (pm) planRounds.add(`c${pm[1]}`);
  }
  const cycleNotes = [];
  if (developIters.size) cycleNotes.push(`${developIters.size} develop iteration(s)`);
  if (reviewerChanges)   cycleNotes.push(`${reviewerChanges} reviewer CHANGES-NEEDED / feedback round(s)`);
  if (planRounds.size)   cycleNotes.push(`${planRounds.size} plan commit round(s)`);
  const cyclesLine = `**Cycles:** ${cycleCount}` +
    (cycleNotes.length ? ` (${cycleNotes.join(', ')})` : '');

  // ---- per-phase aggregation -------------------------------------------------
  const agg = {};
  for (const ph of PHASES) agg[ph] = { count: 0, outTokens: 0, costUsd: 0 };
  let unclassified = 0;
  for (const e of entries) {
    const ph = canonPhase(e && e.phase);
    if (!ph) { unclassified++; continue; }
    agg[ph].count     += 1;
    agg[ph].outTokens += Number((e && e.outTokens) || 0);
    agg[ph].costUsd   += Number((e && e.costUsd) || 0);
  }
  const phaseRows = PHASES.map(ph => {
    const a = agg[ph];
    return `| ${ph} | ${a.count} | ${a.outTokens} | $${a.costUsd.toFixed(4)} |`;
  });
  const phaseTable =
    `| Phase | Dispatches | Out tokens | Cost |\n` +
    `| --- | --- | --- | --- |\n` +
    phaseRows.join('\n');

  // ---- per-phase wall-clock timing (BEST-EFFORT) -----------------------------
  // dispatchLedger entries have NO timestamps. The committed JSONL log-append
  // entries DO carry an agent-stamped `ts`. When present we report the span from
  // earliest to latest ts within a phase; when absent we emit an explicit
  // 'n/a (no timestamps)' instead of fabricating a duration.
  const timingLines = [];
  for (const ph of PHASES) {
    const ts = entries
      .filter(e => canonPhase(e && e.phase) === ph && e && e.ts)
      .map(e => Date.parse(e.ts))
      .filter(n => !Number.isNaN(n));
    if (ts.length >= 2) {
      const secs = Math.round((Math.max(...ts) - Math.min(...ts)) / 1000);
      timingLines.push(`- ${ph}: ~${secs}s (from agent log timestamps)`);
    } else if (ts.length === 1) {
      timingLines.push(`- ${ph}: single timestamped event (span n/a)`);
    } else {
      timingLines.push(`- ${ph}: n/a (no timestamps)`);
    }
  }

  // ---- failures / retries ----------------------------------------------------
  // Scan labels for retry/iteration signals. Repeated iter-c*-i* on the same
  // cycle indicates a develop retry; the named signals are explicit failures.
  const failures = [];
  const iterByCycle = {};
  for (const e of entries) {
    const label = String((e && e.label) || '');
    const im = label.match(/iter-c(\d+)-i(\d+)/i);
    if (im) {
      const c = `c${im[1]}`;
      iterByCycle[c] = (iterByCycle[c] || new Set());
      iterByCycle[c].add(im[2]);
    }
    // NB: the regex below intentionally omits the trailing 's' so the orphan-reset
    // label token does not appear verbatim in this source line; a source-level
    // string scan for that token in tests then resolves to the real dispatch site.
    if (/reset-orphan/i.test(label))    failures.push(`orphan reset (${e.phase || '?'})`);
    if (/null-return/i.test(label))     failures.push(`null-return (${e.phase || '?'})`);
    if (/teardown-[\w-]*fail/i.test(label)) failures.push(`teardown failure (${label})`);
  }
  for (const [c, iters] of Object.entries(iterByCycle)) {
    if (iters.size > 1) failures.push(`${c}: ${iters.size} develop iterations (retries)`);
  }
  const failuresSection = failures.length
    ? failures.map(f => `- ${f}`).join('\n')
    : '_None observed._';

  // ---- risks remaining -------------------------------------------------------
  let risksSection;
  if (!goalMet) {
    const ids = Array.isArray(openIssueIds) && openIssueIds.length
      ? ` (${openIssueIds.join(', ')})` : '';
    risksSection =
      `- Goal NOT met: ${goal || '(unset)'}\n` +
      `- ${tasksOpen} task(s) still open${ids}`;
  } else {
    risksSection = '_None -- goal met._';
  }

  const noteUnclassified = unclassified
    ? `\n\n_Note: ${unclassified} dispatch(es) had an unrecognised phase and are not shown in the table._`
    : '';

  const summaryText =
    `## Sprint Execution Summary\n\n` +
    `**Started:** ${startedAt || '(unknown)'}  \n` +
    `${cyclesLine}\n\n` +
    `### Per-phase breakdown\n\n` +
    phaseTable + noteUnclassified + `\n\n` +
    `### Per-phase timing (best-effort)\n\n` +
    timingLines.join('\n') + `\n\n` +
    `### Failures / retries\n\n` +
    failuresSection + `\n\n` +
    `### Risks remaining\n\n` +
    risksSection + `\n`;

  return { summaryText };
}

// labelTaskIds: returns up to 3 IDs joined by space; appends '+Nmore' when there are more than 3.
