import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanPhase } from '../../skills/auto-sprint/lib/plan.js';

test('runPlanPhase skips planner if planDone is true', async () => {
  const calls = [];
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', base_branch: 'main', rootSummary: 'Sum', mission: '', requirementsFile: '',
    TIER_CHEAP: 'cheap', TIER_STANDARD: 'std', TIER_PREMIUM: 'prem',
    PLAN_REVIEW_SCHEMA: {},
    stateFileRel: 'sprint-logs/state.jsonl',
    updateLiveState: () => {},
    writeSprintState: () => {},
    dispatchShellFleet: async (cmds, tier, opts) => {
      calls.push({ label: opts.label, type: 'shell' });
      return { outputs: [] }; // Mock cycle state outputs
    },
    dispatchFleet: async (tier, prompt, opts) => {
      calls.push({ label: opts.label, type: 'fleet' });
      return {};
    },
    parseCycleState: () => ({ planDone: true, inProgressIds: [], allIssues: [] }),
    log: () => {},
    approved: () => false,
    computeSprintQuote: () => {},
    fs: { writeFileSync: () => {} },
    execSync: () => {},
    dispatchLedger: [],
    sprintQuote: null, calibration: {}, taskAssignments: [], pathJoin: (...args) => args.join('/')
  };

  const res = await runPlanPhase(deps);
  
  assert.equal(res.planApproved, true);
  // Only cycle-state should be called
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, 'cycle-state');
});

test('runPlanPhase runs planner and reviewer and commits on approval', async () => {
  const calls = [];
  const deps = {
    cycleCount: 1, branch: 'feat/test', goal: 'Test', rootIds: ['BD-1'], startedAt: 'ts',
    repo: '.', base_branch: 'main', rootSummary: 'Sum', mission: '', requirementsFile: '',
    TIER_CHEAP: 'cheap', TIER_STANDARD: 'std', TIER_PREMIUM: 'prem',
    PLAN_REVIEW_SCHEMA: {},
    stateFileRel: 'sprint-logs/state.jsonl',
    updateLiveState: () => {},
    writeSprintState: () => {},
    dispatchShellFleet: async (cmds, tier, opts) => {
      calls.push({ label: opts.label, type: 'shell', cmds });
      return { outputs: [] };
    },
    dispatchFleet: async (tier, prompt, opts) => {
      calls.push({ label: opts.label, type: 'fleet' });
      if (opts.label.startsWith('plan-reviewer')) {
        return { verdict: 'APPROVED', taskAssignments: [{id: 'BD-2', bucket: 'S', model: 'haiku'}] };
      }
      return {};
    },
    parseCycleState: () => ({ planDone: false, inProgressIds: [], allIssues: [] }),
    log: () => {},
    approved: (rev) => rev && rev.verdict === 'APPROVED',
    computeSprintQuote: () => ({ scenarios: { expected: { outputOnly: 1 } }, tasks: [{id: 'BD-2', bucket: 'S', model: 'haiku'}] }),
    fs: { writeFileSync: () => {} },
    execSync: () => {},
    dispatchLedger: [],
    sprintQuote: null, calibration: {}, taskAssignments: [], pathJoin: (...args) => args.join('/')
  };

  const res = await runPlanPhase(deps);
  
  assert.equal(res.planApproved, true);
  
  // Sequence: cycle-state -> planner -> plan-reviewer -> plan-commit
  const labels = calls.map(c => c.label);
  assert.ok(labels.includes('cycle-state'));
  assert.ok(labels.includes('planner-c1-r0'));
  assert.ok(labels.includes('plan-reviewer-c1-r0'));
  assert.ok(labels.includes('plan-commit-c1'));
  
  const commitCall = calls.find(c => c.label === 'plan-commit-c1');
  assert.match(commitCall.cmds.join(' '), /bd export -o/);
});
