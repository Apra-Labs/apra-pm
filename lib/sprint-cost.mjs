// Pure-JS sprint cost arithmetic -- no agent/LLM involvement.
// Imported by auto-sprint.js and by unit tests.

export const MODEL_OPUS   = 'claude-opus-4-8';
export const MODEL_SONNET = 'claude-sonnet-4-6';
export const MODEL_HAIKU  = 'claude-haiku-4-5';

export const DEFAULT_CALIBRATION = {
  model_prices_per_1m_output_tokens: {
    [MODEL_HAIKU]:   5.00,
    [MODEL_SONNET]: 15.00,
    [MODEL_OPUS]:   25.00,
  },
  role_models: {
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
  doer_model_fallback:   { model: MODEL_SONNET },
  complexity_buckets: {
    S: { doer_tokens:  600 },
    M: { doer_tokens: 1400 },
    L: { doer_tokens: 2800 },
  },
  reviewer_ratio:        { value: 0.4 },
  cycle_assumptions:     { optimistic: 1.0, expected: 1.5, pessimistic: 2.5 },
  fixed_overhead_tokens: {
    setup:               200,
    planner:            2000,
    plan_reviewer:      1500,
    harvester:          3000,
    ci_watcher:          300,
    log_flush_per_cycle: 100,
  },
  input_cost_multiplier: { value: 4.0 },
  outlier_thresholds: {
    notable_pct:              50,
    outlier_pct:             200,
    calibration_failure_pct: 500,
  },
  historical: {
    max_sprints_in_sample: 5,
    sprints_sampled:       0,
    last_updated:          null,
    cycle_avg:             null,
    reviewer_ratio_avg:    null,
    bucket_avg_tokens:     {},
    roles:                 {},
  },
};

// Reviewer model: max(taskModel, sonnet). Opus stays opus; everything else gets sonnet.
export function reviewerModelFor(taskModel) {
  return taskModel === MODEL_OPUS ? MODEL_OPUS : MODEL_SONNET;
}

export function computeSprintQuote(taskAssignments, calibration) {
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

export function computeUpdatedCalibration(calibration, analysis, startedAt) {
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
