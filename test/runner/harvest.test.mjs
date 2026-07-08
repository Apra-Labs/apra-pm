import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHarvestPhase } from '../../skills/auto-sprint/lib/harvest.js';

test('runHarvestPhase: aborts if final review is rejected', async () => {
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', base_branch: 'main', rootSummary: 'Sum', threshold: 1,
    abortReason: null, goalMet: true, prevOpenIds: [], sprintQuote: { tasks: [] },
    calibration: {}, taskAssignments: [], opts: {}, safeBranch: 'feat_test', calibPath: 'calib.json',
    updateLiveState: () => {}, clearSprintState: () => {},
    dispatchFleet: async () => ({ verdict: 'CHANGES NEEDED', notes: 'failed' }), // Rejected!
    buildSprintSummary: () => ({}), safeWriteFile: () => {},
    computeUpdatedCalibration: () => ({}), log: () => {}, runCiWatcher: () => {},
    pathJoin: (...args) => args.join('/'), REVIEW_SCHEMA: {}, HARVEST_SCHEMA: {},
    approved: () => false
  };

  const res = await runHarvestPhase(deps);
  assert.equal(res.harvestSuccess, false);
  assert.equal(res.finalReviewRejected, true);
  assert.equal(res.finalReviewNotes, 'failed');
});

test('runHarvestPhase: runs harvester and creates PR when approved', async () => {
  const calls = [];
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', base_branch: 'main', rootSummary: 'Sum', threshold: 1,
    abortReason: null, goalMet: true, prevOpenIds: [], sprintQuote: { tasks: [] },
    calibration: {}, taskAssignments: [], opts: {}, safeBranch: 'feat_test', calibPath: 'calib.json',
    updateLiveState: () => {}, clearSprintState: () => {},
    dispatchFleet: async (tier, prompt, opts) => {
      calls.push({ label: opts.label });
      if (opts.label === 'final-reviewer') return { verdict: 'APPROVED' };
      if (opts.label === 'harvester') return { status: 'OK' };
      if (opts.label === 'harvest-pr') return { prNumber: 42 };
      return {};
    },
    buildSprintSummary: () => ({ summaryText: 'Sum' }), safeWriteFile: () => {},
    computeUpdatedCalibration: () => ({}), log: () => {}, runCiWatcher: () => {},
    pathJoin: (...args) => args.join('/'), REVIEW_SCHEMA: {}, HARVEST_SCHEMA: {},
    approved: () => true
  };

  const res = await runHarvestPhase(deps);
  assert.equal(res.harvestSuccess, true);
  assert.equal(res.prNumber, 42);

  const labels = calls.map(c => c.label);
  assert.ok(labels.includes('final-reviewer'));
  assert.ok(labels.includes('harvester'));
  assert.ok(labels.includes('dolt-push'));
  assert.ok(labels.includes('harvest-pr'));
});

test('runHarvestPhase: triggers runCiWatcher if passed in', async () => {
  let ciWatcherCalled = false;
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', base_branch: 'main', rootSummary: 'Sum', threshold: 1,
    abortReason: null, goalMet: true, prevOpenIds: [], sprintQuote: { tasks: [] },
    calibration: {}, taskAssignments: [], opts: {}, safeBranch: 'feat_test', calibPath: 'calib.json',
    updateLiveState: () => {}, clearSprintState: () => {},
    dispatchFleet: async (tier, prompt, opts) => {
      if (opts.label === 'harvest-pr') return { prNumber: 99 };
      return { verdict: 'APPROVED', status: 'OK' };
    },
    buildSprintSummary: () => ({}), safeWriteFile: () => {},
    computeUpdatedCalibration: () => ({}), log: () => {},
    runCiWatcher: async ({ prNumber }) => {
      if (prNumber === 99) ciWatcherCalled = true;
    },
    pathJoin: (...args) => args.join('/'), REVIEW_SCHEMA: {}, HARVEST_SCHEMA: {},
    approved: () => true
  };

  await runHarvestPhase(deps);
  assert.equal(ciWatcherCalled, true);
});
