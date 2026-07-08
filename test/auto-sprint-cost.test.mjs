import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

// Read runner.js
const src = readFileSync(join(__dir, '../skills/auto-sprint/runner.js'), 'utf-8');

// Extract pure functions
const pureFnMatch = src.match(/\/\/ PURE_FUNCTIONS_BEGIN\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!pureFnMatch) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found in runner.js');

const pureFns = pureFnMatch[1];
const extractCostJs = `${pureFns}\nmodule.exports = { estimateCost };`;
const mod = { exports: {} };
new Function('module', extractCostJs)(mod);
const { estimateCost } = mod.exports;

test('estimateCost correctly calculates standard model cost', () => {
  // $3 input / $15 output per million
  const cost = estimateCost('pm-doer-std', 1000000, 1000000);
  assert.equal(cost, 18.00);
});

test('estimateCost correctly calculates cheap model cost', () => {
  // $0.25 input / $1.25 output per million
  const cost = estimateCost('pm-doer-cheap', 1000000, 1000000);
  assert.equal(cost, 1.50);
});

test('estimateCost correctly calculates premium model cost', () => {
  // $15 input / $75 output per million
  const cost = estimateCost('pm-doer-prem', 1000000, 1000000);
  assert.equal(cost, 90.00);
});

test('estimateCost returns 0 for native orchestrator tasks', () => {
  const cost = estimateCost('native', 5000, 5000);
  assert.equal(cost, 0);
});
