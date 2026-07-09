import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopPhase } from '../../skills/auto-sprint/lib/develop.js';

test('runDevelopPhase: aborts with deadlock if no ready tasks on first iteration and blockers exist', async () => {
  const calls = [];
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', base_branch: 'main', rootSummary: 'Sum',
    TIER_CHEAP: 'cheap', TIER_STANDARD: 'std', TIER_PREMIUM: 'prem',
    DOER_STATUS_SCHEMA: {}, REVIEW_SCHEMA: {},
    taskAssignments: [], calibration: {}, threshold: 1,
    updateLiveState: () => {}, writeSprintState: () => {},
    dispatchShellFleet: async (cmds, tier, opts) => {
      calls.push({ label: opts.label, type: 'shell' });
      return { outputs: [] };
    },
    dispatchFleet: async () => {}, stateFileRel: 'sprint-logs/state.jsonl',
    parseReadyStreaks: () => ({ totalCount: 0, streaks: [] }),
    truncateStreakToCeiling: (ids) => ids,
    labelTaskIds: () => 'tasks',
    parseBlockers: () => ({ count: 1 }), // Blockers exist!
    approved: () => false, log: () => {},
    fs: { writeFileSync: () => {} }, pathJoin: (...args) => args.join('/'), dispatchLedger: []
  };

  const res = await runDevelopPhase(deps);
  
  assert.equal(res.abortReason, 'deadlock: open issues but none ready');
  const labels = calls.map(c => c.label);
  assert.ok(labels.includes('ready-streaks'));
  assert.ok(labels.includes('check-blockers'));
});

test('runDevelopPhase: completes if no ready tasks and no blockers', async () => {
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', base_branch: 'main', rootSummary: 'Sum',
    TIER_CHEAP: 'cheap', TIER_STANDARD: 'std', TIER_PREMIUM: 'prem',
    DOER_STATUS_SCHEMA: {}, REVIEW_SCHEMA: {},
    taskAssignments: [], calibration: {}, threshold: 1,
    updateLiveState: () => {}, writeSprintState: () => {},
    dispatchShellFleet: async () => ({ outputs: [] }),
    dispatchFleet: async () => {}, stateFileRel: 'sprint-logs/state.jsonl',
    parseReadyStreaks: () => ({ totalCount: 0, streaks: [] }),
    truncateStreakToCeiling: (ids) => ids,
    labelTaskIds: () => 'tasks',
    parseBlockers: () => ({ count: 0 }), // No blockers
    approved: () => false, log: () => {},
    fs: { writeFileSync: () => {} }, pathJoin: (...args) => args.join('/'), dispatchLedger: []
  };

  const res = await runDevelopPhase(deps);
  assert.equal(res.abortReason, null); // Completes gracefully
});

test('runDevelopPhase: runs doer and reviewer loop', async () => {
  let iter = 0;
  const calls = [];
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', base_branch: 'main', rootSummary: 'Sum',
    TIER_CHEAP: 'cheap', TIER_STANDARD: 'std', TIER_PREMIUM: 'prem',
    DOER_STATUS_SCHEMA: {}, REVIEW_SCHEMA: {},
    taskAssignments: [], calibration: {}, threshold: 1,
    updateLiveState: () => {}, writeSprintState: () => {},
    dispatchShellFleet: async () => ({ outputs: [] }),
    dispatchFleet: async (tier, prompt, opts) => {
      calls.push({ label: opts.label, type: 'fleet' });
      if (opts.label.startsWith('doer')) return { status: 'VERIFY' };
      if (opts.label.startsWith('reviewer')) return { verdict: 'APPROVED' };
      return {};
    },
    stateFileRel: 'sprint-logs/state.jsonl',
    parseReadyStreaks: () => {
      if (iter === 0) { iter++; return { totalCount: 1, streaks: [{ model: 'std', ids: ['BD-2'] }] }; }
      return { totalCount: 0, streaks: [] }; // Done on second loop
    },
    truncateStreakToCeiling: (ids) => ids,
    labelTaskIds: () => 'BD-2',
    parseBlockers: () => ({ count: 0 }),
    approved: (rev) => rev && rev.verdict === 'APPROVED',
    log: () => {}, fs: { writeFileSync: () => {} }, pathJoin: (...args) => args.join('/'), dispatchLedger: []
  };

  const res = await runDevelopPhase(deps);
  assert.equal(res.abortReason, null);
  
  const labels = calls.map(c => c.label);
  assert.ok(labels.includes('doer-c1-r0: BD-2'));
  assert.ok(labels.includes('reviewer-c1-r1: BD-2')); // After devIter++
});
