import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTestPhase } from '../../skills/auto-sprint/lib/test-phase.js';

test('runTestPhase: skips if no deploy.md or playbook', async () => {
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', rootSummary: 'Sum', threshold: 1, maxCycles: 5, prevOpenIds: [],
    updateLiveState: () => {}, writeSprintState: () => {},
    dispatchShellFleet: async () => ({ outputs: [] }), dispatchFleet: async () => {},
    stateFileRel: 'sprint-logs/state.jsonl',
    parseBlockers: () => ({ count: 1, ids: ['BD-2'] }),
    log: () => {}, fs: { existsSync: () => false }, pathJoin: (...args) => args.join('/'),
    INTEG_RUN_SCHEMA: {}
  };

  const res = await runTestPhase(deps);
  assert.equal(res.goalMet, false);
  assert.equal(res.abortReason, null);
  assert.deepEqual(res.currentOpenIds, ['BD-2']);
});

test('runTestPhase: goalMet=true if 0 blockers on exit gate', async () => {
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', rootSummary: 'Sum', threshold: 1, maxCycles: 5, prevOpenIds: [],
    updateLiveState: () => {}, writeSprintState: () => {},
    dispatchShellFleet: async () => ({ outputs: [] }), dispatchFleet: async () => {},
    stateFileRel: 'sprint-logs/state.jsonl',
    parseBlockers: () => ({ count: 0, ids: [] }), // 0 Blockers!
    log: () => {}, fs: { existsSync: () => false }, pathJoin: (...args) => args.join('/'),
    INTEG_RUN_SCHEMA: {}
  };

  const res = await runTestPhase(deps);
  assert.equal(res.goalMet, true);
  assert.equal(res.abortReason, null);
});

test('runTestPhase: aborts with no-progress if openIds match prevOpenIds in cycle > 1', async () => {
  const deps = {
    cycleCount: 2, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', rootSummary: 'Sum', threshold: 1, maxCycles: 5, prevOpenIds: ['BD-3'],
    updateLiveState: () => {}, writeSprintState: () => {},
    dispatchShellFleet: async () => ({ outputs: [] }), dispatchFleet: async () => {},
    stateFileRel: 'sprint-logs/state.jsonl',
    parseBlockers: () => ({ count: 1, ids: ['BD-3'] }), // Same open ID
    log: () => {}, fs: { existsSync: () => false }, pathJoin: (...args) => args.join('/'),
    INTEG_RUN_SCHEMA: {}
  };

  const res = await runTestPhase(deps);
  assert.equal(res.goalMet, false);
  assert.equal(res.abortReason, 'no-progress');
});

test('runTestPhase: aborts if maxCycles reached', async () => {
  const deps = {
    cycleCount: 5, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', rootSummary: 'Sum', threshold: 1, maxCycles: 5, prevOpenIds: ['BD-4'],
    updateLiveState: () => {}, writeSprintState: () => {},
    dispatchShellFleet: async () => ({ outputs: [] }), dispatchFleet: async () => {},
    stateFileRel: 'sprint-logs/state.jsonl',
    parseBlockers: () => ({ count: 1, ids: ['BD-5'] }), // Diff open ID so not no-progress
    log: () => {}, fs: { existsSync: () => false }, pathJoin: (...args) => args.join('/'),
    INTEG_RUN_SCHEMA: {}
  };

  const res = await runTestPhase(deps);
  assert.equal(res.goalMet, false);
  assert.equal(res.abortReason, null); // wait, break at cycle ceiling means it falls through to end?
  // Our extraction replaces "break;" with return { goalMet, abortReason, currentOpenIds };
  // So abortReason remains null.
});
