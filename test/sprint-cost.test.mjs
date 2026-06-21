import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_OPUS, MODEL_SONNET, MODEL_HAIKU,
  DEFAULT_CALIBRATION,
  reviewerModelFor,
  computeSprintQuote,
  computeSprintAnalysis,
  computeUpdatedCalibration,
} from '../lib/sprint-cost.mjs';

// -- reviewerModelFor ----------------------------------------------------------

test('reviewerModelFor: opus stays opus', () => {
  assert.equal(reviewerModelFor(MODEL_OPUS), MODEL_OPUS);
});

test('reviewerModelFor: sonnet gets sonnet', () => {
  assert.equal(reviewerModelFor(MODEL_SONNET), MODEL_SONNET);
});

test('reviewerModelFor: haiku gets sonnet', () => {
  assert.equal(reviewerModelFor(MODEL_HAIKU), MODEL_SONNET);
});

// -- computeSprintQuote --------------------------------------------------------

test('computeSprintQuote: empty task list returns zero-cost scenarios', () => {
  const q = computeSprintQuote([], DEFAULT_CALIBRATION);
  assert.equal(q.tasks.length, 0);
  assert.equal(q.calibrationSource, 'defaults');
  assert.equal(q.inputMultiplier, 4.0);
  // All scenarios are positive (overhead exists even with no tasks)
  assert.ok(q.scenarios.optimistic.outputOnly > 0);
  assert.ok(q.scenarios.expected.outputOnly > 0);
  assert.ok(q.scenarios.pessimistic.outputOnly > 0);
  // expected is between optimistic and pessimistic
  assert.ok(q.scenarios.optimistic.outputOnly <= q.scenarios.expected.outputOnly);
  assert.ok(q.scenarios.expected.outputOnly <= q.scenarios.pessimistic.outputOnly);
});

test('computeSprintQuote: single S-bucket sonnet task', () => {
  const tasks = [{ id: 'BD-1', bucket: 'S', model: MODEL_SONNET }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);

  assert.equal(q.tasks.length, 1);
  const t = q.tasks[0];
  assert.equal(t.id, 'BD-1');
  assert.equal(t.bucket, 'S');
  assert.equal(t.model, MODEL_SONNET);
  assert.equal(t.doerTokens, 600);               // S bucket default
  assert.equal(t.reviewerTokens, Math.round(600 * 0.4)); // 240
  // outputUsd = (600 * 15 + 240 * 15) / 1_000_000
  const expected = (600 * 15 + 240 * 15) / 1_000_000;
  assert.ok(Math.abs(t.outputUsd - expected) < 1e-9);
});

test('computeSprintQuote: opus task uses opus price for doer, opus for reviewer', () => {
  const tasks = [{ id: 'BD-2', bucket: 'M', model: MODEL_OPUS }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  const t = q.tasks[0];
  assert.equal(t.doerTokens, 1400);
  assert.equal(t.reviewerTokens, Math.round(1400 * 0.4));
  const expectedUsd = (1400 * 25 + Math.round(1400 * 0.4) * 25) / 1_000_000;
  assert.ok(Math.abs(t.outputUsd - expectedUsd) < 1e-9);
});

test('computeSprintQuote: haiku doer gets sonnet reviewer', () => {
  const tasks = [{ id: 'BD-3', bucket: 'S', model: MODEL_HAIKU }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  const t = q.tasks[0];
  // doer = haiku ($5), reviewer = sonnet ($15)
  const expectedUsd = (600 * 5 + Math.round(600 * 0.4) * 15) / 1_000_000;
  assert.ok(Math.abs(t.outputUsd - expectedUsd) < 1e-9);
});

test('computeSprintQuote: total scenario scales with cycle multiplier', () => {
  const tasks = [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  // overhead is fixed; only per-task portion and log-flush scale with cycles
  assert.ok(q.scenarios.pessimistic.outputOnly > q.scenarios.expected.outputOnly);
  assert.ok(q.scenarios.expected.outputOnly > q.scenarios.optimistic.outputOnly);
});

test('computeSprintQuote: total = outputOnly * inputMultiplier', () => {
  const tasks = [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  for (const s of Object.values(q.scenarios)) {
    assert.ok(Math.abs(s.total - s.outputOnly * q.inputMultiplier) < 1e-9);
  }
});

test('computeSprintQuote: historical data overrides bucket defaults', () => {
  const cal = {
    ...DEFAULT_CALIBRATION,
    historical: {
      ...DEFAULT_CALIBRATION.historical,
      sprints_sampled: 2,
      reviewer_ratio_avg: 0.5,
      bucket_avg_tokens: { M: 2000 },
    },
  };
  const tasks = [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }];
  const q = computeSprintQuote(tasks, cal);
  assert.equal(q.tasks[0].doerTokens, 2000);       // from historical
  assert.equal(q.tasks[0].reviewerTokens, 1000);   // 2000 * 0.5
  assert.equal(q.calibrationSource, 'historical (2 sprints)');
});

test('computeSprintQuote: missing model falls back to doer_model_fallback', () => {
  const tasks = [{ id: 'BD-1', bucket: 'S' }];  // no model field
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  assert.equal(q.tasks[0].model, MODEL_SONNET);  // fallback
});

// -- computeSprintAnalysis -----------------------------------------------------

const SAMPLE_QUOTE = computeSprintQuote(
  [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }],
  DEFAULT_CALIBRATION
);

const SAMPLE_LOG = [
  { label: 'doer-c1-i0',    outTokens: 1200, costUsd: 0.018, phase: 'Develop' },
  { label: 'reviewer-c1',   outTokens:  450, costUsd: 0.006, phase: 'Develop' },
  { label: 'doer-c2-i0',    outTokens: 1100, costUsd: 0.0165, phase: 'Develop' },
  { label: 'reviewer-c2',   outTokens:  400, costUsd: 0.006, phase: 'Develop' },
  { label: 'harvester',     outTokens:  800, costUsd: 0.012, phase: 'Harvest' },
];

test('computeSprintAnalysis: groups log entries by role', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  assert.equal(r.byRole['doer'].tokens, 2300);    // 1200+1100
  assert.equal(r.byRole['doer'].dispatches, 2);
  assert.equal(r.byRole['reviewer'].tokens, 850); // 450+400
  assert.equal(r.byRole['harvester'].tokens, 800);
});

test('computeSprintAnalysis: actualCycles passed through', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  assert.equal(r.actualCycles, 2);
});

test('computeSprintAnalysis: totals are sums of actuals', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  const expectedActUsd = 0.018 + 0.006 + 0.0165 + 0.006 + 0.012;
  assert.ok(Math.abs(r.totActUsd - expectedActUsd) < 1e-9);
});

test('computeSprintAnalysis: analysisText contains markdown table header', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  assert.ok(r.analysisText.includes('| Role'));
  assert.ok(r.analysisText.includes('| doer'));
  assert.ok(r.analysisText.includes('| TOTAL'));
});

test('computeSprintAnalysis: analysisText contains outlier/failure lines', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  assert.ok(r.analysisText.includes('Outliers'));
  assert.ok(r.analysisText.includes('Calibration failures'));
});

test('computeSprintAnalysis: null quote handled gracefully (no tasks)', () => {
  const r = computeSprintAnalysis(null, SAMPLE_LOG, DEFAULT_CALIBRATION, 1);
  assert.ok(r.analysisText.includes('#### Sprint cost analysis'));
  assert.equal(typeof r.totEstOutputUsd, 'number');
  assert.ok(isFinite(r.totEstOutputUsd));
});

test('computeSprintAnalysis: empty log entries returns zeros for actuals', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, [], DEFAULT_CALIBRATION, 1);
  assert.equal(r.totActUsd, 0);
  assert.deepEqual(r.byRole, {});
});

test('computeSprintAnalysis: labels without cycle suffix are grouped to role', () => {
  const log = [
    { label: 'setup', outTokens: 200, costUsd: 0.001 },
    { label: 'harvester', outTokens: 800, costUsd: 0.012 },
  ];
  const r = computeSprintAnalysis(SAMPLE_QUOTE, log, DEFAULT_CALIBRATION, 1);
  assert.equal(r.byRole['setup']?.tokens, 200);
  assert.equal(r.byRole['harvester']?.tokens, 800);
});

// -- computeUpdatedCalibration -------------------------------------------------

const SAMPLE_ANALYSIS = {
  actualCycles: 2,
  totEstOutputUsd: 0.05,
  totActUsd: 0.06,
  byRole: {
    doer:      { tokens: 2300, costUsd: 0.0345, dispatches: 2 },
    reviewer:  { tokens:  850, costUsd: 0.0128, dispatches: 2 },
    harvester: { tokens:  800, costUsd: 0.0120, dispatches: 1 },
  },
};

test('computeUpdatedCalibration: first sprint sets sprints_sampled to 1', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.equal(u.historical.sprints_sampled, 1);
});

test('computeUpdatedCalibration: last_updated extracted from startedAt', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.equal(u.historical.last_updated, '2026-06-20');
});

test('computeUpdatedCalibration: first sprint cycle_avg equals actualCycles', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.equal(u.historical.cycle_avg, 2);
});

test('computeUpdatedCalibration: second sprint blends cycle_avg', () => {
  const after1 = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  const analysis2 = { ...SAMPLE_ANALYSIS, actualCycles: 4 };
  const after2 = computeUpdatedCalibration(after1, analysis2, '20260621_090000');
  // blend(2, 4) with prev=1, n=2 => (2*1 + 4) / 2 = 3
  assert.equal(after2.historical.cycle_avg, 3);
  assert.equal(after2.historical.sprints_sampled, 2);
});

test('computeUpdatedCalibration: reviewer_ratio_avg computed from doer/reviewer tokens', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  // revTok / doerTok = 850 / 2300
  const expected = 850 / 2300;
  assert.ok(Math.abs(u.historical.reviewer_ratio_avg - expected) < 1e-9);
});

test('computeUpdatedCalibration: role avg_output_tokens set on first sprint', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  // doer: 2300 tokens / 2 dispatches = 1150
  assert.equal(u.historical.roles['doer'].avg_output_tokens, 1150);
  assert.equal(u.historical.roles['doer'].sample_n, 2);
});

test('computeUpdatedCalibration: rolling blend capped at max_sprints_in_sample', () => {
  let cal = DEFAULT_CALIBRATION;
  const analysis = { ...SAMPLE_ANALYSIS, actualCycles: 2 };
  // Run 6 sprints -- window is 5
  for (let i = 0; i < 6; i++) {
    cal = computeUpdatedCalibration(cal, analysis, '20260620_130000');
  }
  assert.equal(cal.historical.sprints_sampled, 5); // capped at max
});

test('computeUpdatedCalibration: does not mutate original calibration', () => {
  const original = JSON.parse(JSON.stringify(DEFAULT_CALIBRATION));
  computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.deepEqual(DEFAULT_CALIBRATION.historical, original.historical);
});

test('computeUpdatedCalibration: other calibration fields preserved', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.deepEqual(u.model_prices_per_1m_output_tokens, DEFAULT_CALIBRATION.model_prices_per_1m_output_tokens);
  assert.deepEqual(u.complexity_buckets, DEFAULT_CALIBRATION.complexity_buckets);
});
