import test from 'node:test';
import assert from 'node:assert';
import { STATUS_HTML, writeStaticHtmlReport } from '../../skills/auto-sprint/lib/status-html.js';
import fs from 'node:fs';
import path from 'node:path';

const mockStateInProgress = {
  branch: 'feat/test-ui',
  rootIds: ['gh-123'],
  mission: 'Implement new UI dashboard features',
  phase: 'Develop',
  cycle: 1,
  maxCycles: 5,
  costUsd: 1.23,
  ledger: [
    { phase: 'setup', label: 'System', model: '-', durationMs: 0, outTokens: '-' },
    { phase: 'Plan', label: 'pm-planner-c1-r0', model: 'pm-planner-prem', durationMs: 45000, outTokens: 1200, isRunning: false },
    { phase: 'Develop', label: 'pm-doer-c1-r0', model: 'pm-doer-std', durationMs: 120000, outTokens: 3500, isRunning: false }
  ],
  currentAgent: 'pm-reviewer-c1-r0',
  currentModel: 'pm-reviewer-prem',
  currentPhase: 'Develop',
  currentCycle: 1,
  startedAt: new Date(Date.now() - 200000).toISOString(),
  sprintBeads: [
    { id: 'gh-123', t: 'feature', s: 'in_progress', title: 'Main feature', dependencies: [{ depends_on_id: 'gh-124' }] },
    { id: 'gh-124', t: 'task', s: 'closed', title: 'Subtask 1' }
  ]
};

const mockStateGoalMet = {
  branch: 'feat/test-ui',
  rootIds: ['gh-123'],
  phase: 'Harvest',
  cycle: 2,
  maxCycles: 5,
  costUsd: 2.50,
  goalMet: true,
  endedAt: new Date().toISOString(),
  startedAt: new Date(Date.now() - 500000).toISOString(),
  ledger: [
    { phase: 'Test', label: 'pm-integ-test-runner', verdict: 'APPROVED', isRunning: false }
  ],
  sprintBeads: [
    { id: 'gh-123', t: 'feature', s: 'closed', title: 'Main feature' }
  ]
};

const mockStateAborted = {
  branch: 'feat/test-ui',
  rootIds: ['gh-123'],
  phase: 'Test',
  cycle: 2,
  costUsd: 1.50,
  abortReason: 'User stopped from UI',
  endedAt: new Date().toISOString(),
  startedAt: new Date(Date.now() - 300000).toISOString(),
  ledger: [],
  sprintBeads: []
};

const mockStateTree = {
  branch: 'feat/complex-tree',
  rootIds: ['epic-1'],
  phase: 'Develop',
  cycle: 1,
  costUsd: 0.75,
  mission: 'Complex 3-level hierarchy rendering test',
  ledger: [],
  sprintBeads: [
    { id: 'epic-1', t: 'epic', s: 'in_progress', title: 'Main Project Epic', dependencies: [
        { depends_on_id: 'feat-1', type: 'blocks' },
        { depends_on_id: 'feat-2', type: 'blocks' },
        { depends_on_id: 'feat-3', type: 'blocks' }
    ]},
    { id: 'feat-1', t: 'feature', s: 'closed', title: 'Authentication Module', dependencies: [
        { depends_on_id: 'task-1-1', type: 'blocks' },
        { depends_on_id: 'task-1-2', type: 'blocks' }
    ]},
    { id: 'task-1-1', t: 'task', s: 'closed', title: 'Setup OAuth providers' },
    { id: 'task-1-2', t: 'task', s: 'closed', title: 'Write unit tests for Auth' },
    
    { id: 'feat-2', t: 'feature', s: 'in_progress', title: 'Billing Integration', dependencies: [
        { depends_on_id: 'task-2-1', type: 'blocks' },
        { depends_on_id: 'task-2-2', type: 'blocks' }
    ]},
    { id: 'task-2-1', t: 'task', s: 'in_progress', title: 'Stripe API Webhooks' },
    { id: 'task-2-2', t: 'task', s: 'open', title: 'Invoice generation' },
    
    { id: 'feat-3', t: 'feature', s: 'open', title: 'Dashboard UI Revamp', dependencies: [
        { depends_on_id: 'task-3-1', type: 'blocks' },
        { depends_on_id: 'task-3-2', type: 'blocks' }
    ]},
    { id: 'task-3-1', t: 'task', s: 'open', title: 'Design collapsible tree view' },
    { id: 'task-3-2', t: 'task', s: 'open', title: 'Implement CSS animations' }
  ]
};

test('status-html UI rendering and injection', async (t) => {
  const outputDir = path.join(process.cwd(), 'sprint-logs', 'ui-mocks');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const safeWriteFile = (fpath, content, type) => {
    fs.writeFileSync(fpath, content, 'utf8');
  };

  await t.test('writeStaticHtmlReport properly injects in-progress state', () => {
    const outPath = writeStaticHtmlReport({
      _globalRepo: process.cwd(),
      _liveState: mockStateInProgress,
      safeWriteFile,
      log: () => {},
      pathJoin: path.join
    });
    
    // We override outPath to save to our ui-mocks folder for the user
    const html = fs.readFileSync(outPath, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'in-progress.html'), html, 'utf8');
    
    assert.ok(html.includes('const s = {'), 'HTML should inject offline JSON data payload');
    assert.ok(html.includes('"mission":"Implement new UI dashboard features"'), 'HTML should contain injected mission text');
    assert.ok(!html.includes('fetch(\'/state\')'), 'HTML should have fetch(/state) patched out');
  });

  await t.test('writeStaticHtmlReport properly injects goal met state', () => {
    const htmlPath = writeStaticHtmlReport({
      _globalRepo: process.cwd(),
      _liveState: mockStateGoalMet,
      safeWriteFile,
      log: () => {},
      pathJoin: path.join
    });
    const html = fs.readFileSync(htmlPath, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'goal-met.html'), html, 'utf8');
    
    assert.ok(html.includes('"goalMet":true'), 'HTML should contain goalMet true');
  });

  await t.test('writeStaticHtmlReport properly injects aborted state', () => {
    const htmlPath = writeStaticHtmlReport({
      _globalRepo: process.cwd(),
      _liveState: mockStateAborted,
      safeWriteFile,
      log: () => {},
      pathJoin: path.join
    });
    const html = fs.readFileSync(htmlPath, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'aborted.html'), html, 'utf8');
    
    assert.ok(html.includes('"abortReason":"User stopped from UI"'), 'HTML should contain abortReason');
  });

  await t.test('writeStaticHtmlReport generates complex 3-level tree', () => {
    const htmlPath = writeStaticHtmlReport({
      _globalRepo: process.cwd(),
      _liveState: mockStateTree,
      safeWriteFile,
      log: () => {},
      pathJoin: path.join
    });
    const html = fs.readFileSync(htmlPath, 'utf8');
    fs.writeFileSync(path.join(outputDir, 'tree-10.html'), html, 'utf8');
    
    assert.ok(html.includes('epic-1'), 'HTML should contain epic-1');
  });
});
