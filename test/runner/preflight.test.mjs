import test from 'node:test';
import assert from 'node:assert';
import { runPreflightChecks } from '../../skills/auto-sprint/lib/preflight.js';

test('runPreflightChecks validates shape and collects multiple errors', (t) => {
  const badOpts = {
    issues: [''], // empty string
    branch: '  ', // empty branch
    goal: 'P99', // invalid goal
    max_cycles: -1, // invalid cycles
    base_branch: '', // invalid base branch
    skip_dolt_push: 'yes' // invalid boolean
  };

  const { ok, errors, warnings } = runPreflightChecks(badOpts, badOpts);
  assert.strictEqual(ok, false);
  assert.strictEqual(errors.length, 6);
  assert.ok(errors.some(e => e.includes('every entry in "issues" must be a non-empty string')));
  assert.ok(errors.some(e => e.includes('"branch" must be a non-empty string')));
  assert.ok(errors.some(e => e.includes('"goal" must be one of')));
  assert.ok(errors.some(e => e.includes('"max_cycles" must be a positive integer')));
  assert.ok(errors.some(e => e.includes('"base_branch" must be a non-empty string')));
  assert.ok(errors.some(e => e.includes('"skip_dolt_push" must be a boolean')));
  assert.strictEqual(warnings.length, 0);
});

test('runPreflightChecks returns multiple beads root failures', (t) => {
  const opts = { issues: ['BD-1', 'BD-2'] };
  
  // Mock exec that fails for both beads issues
  const mockExec = (cmd) => {
    if (cmd.includes('bd show BD-1')) throw new Error('not found');
    if (cmd.includes('bd show BD-2')) throw new Error('not found');
    return ''; // git fetch succeeds
  };

  const { ok, errors } = runPreflightChecks(opts, opts, mockExec);
  assert.strictEqual(ok, false);
  assert.strictEqual(errors.length, 2);
  assert.ok(errors.some(e => e.includes('root BD-1 not found')));
  assert.ok(errors.some(e => e.includes('root BD-2 not found')));
});

test('runPreflightChecks captures git fetch failure as a warning', (t) => {
  const opts = { issues: ['BD-1'] };
  
  // Mock exec that succeeds for beads but fails for git fetch
  const mockExec = (cmd) => {
    if (cmd.includes('bd show')) return '';
    if (cmd.includes('git fetch')) throw new Error('offline');
  };

  const { ok, errors, warnings } = runPreflightChecks(opts, opts, mockExec);
  assert.strictEqual(ok, true);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('git fetch failed (non-fatal network issue)'));
});
