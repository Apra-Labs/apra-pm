// Drift guard: the role-contract schemas inlined into .claude/workflows/auto-sprint.js
// (between ROLE_SCHEMAS_GENERATED_BEGIN/END) must always match what
// scripts/gen-auto-sprint-schemas.mjs would produce from the canonical
// agents/schemas/<role>-output.json files right now. Runtime require('fs') to load
// them was removed because auto-sprint.js executes inside Claude's Workflow tool
// sandbox, which has no filesystem/require access (that crash -- "require is not
// defined" -- took down apra-pm e2e s10 on 2026-07-17, run 29605783512). Regenerating
// at build time instead of at runtime means a schema edit that forgets to re-run the
// generator must fail here, not silently ship a stale inlined copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');
const schemasDir = join(repoRoot, 'agents', 'schemas');
const targetFile = join(repoRoot, '.claude', 'workflows', 'auto-sprint.js');

const ROLES = [
  ['reviewer', 'REVIEW_SCHEMA'],
  ['plan-reviewer', 'PLAN_REVIEW_SCHEMA'],
  ['doer', 'DOER_STATUS_SCHEMA'],
  ['deployer', 'DEPLOYER_SCHEMA'],
  ['integ-test-runner', 'INTEG_RUN_SCHEMA'],
  ['ci-watcher', 'CI_SCHEMA'],
  ['harvester', 'HARVEST_SCHEMA'],
];

const BEGIN_MARKER = '// ROLE_SCHEMAS_GENERATED_BEGIN -- do not hand-edit; run `node scripts/gen-auto-sprint-schemas.mjs` to regenerate from agents/schemas/*.json';
const END_MARKER = '// ROLE_SCHEMAS_GENERATED_END';

function loadStrippedSchema(role) {
  const file = join(schemasDir, `${role}-output.json`);
  const parsed = JSON.parse(readFileSync(file, 'utf-8'));
  const { version, ...rest } = parsed;
  return rest;
}

test('auto-sprint.js has no module-scope require(\'fs\')/require(\'path\') -- it runs in the Workflow tool sandbox, which has neither', () => {
  const src = readFileSync(targetFile, 'utf-8');
  // Scoped to the specific `const fs = require('fs')` / `const path = require('path')`
  // module-scope statements the schema loader used to have -- NOT the many
  // `node -e "...require('fs')..."` strings elsewhere in the file, which build shell
  // commands for a separate `node -e` subprocess the doer/Haiku dispatch actually runs
  // (real Node, outside the Workflow sandbox) and are legitimate.
  assert.doesNotMatch(src, /^\s*const fs\s*=\s*require\(\s*['"]fs['"]\s*\)/m, 'auto-sprint.js must not require(\'fs\') at module scope -- the Workflow sandbox has no filesystem access');
  assert.doesNotMatch(src, /^\s*const path\s*=\s*require\(\s*['"]path['"]\s*\)/m, 'auto-sprint.js must not require(\'path\') at module scope -- the Workflow sandbox has no filesystem access');
  assert.doesNotMatch(src, /loadRoleSchema/, 'auto-sprint.js must not load role schemas from disk at runtime -- they must be inlined at build time by scripts/gen-auto-sprint-schemas.mjs');
});

test('auto-sprint.js role schemas are not stale -- matches what scripts/gen-auto-sprint-schemas.mjs would generate right now', () => {
  const src = readFileSync(targetFile, 'utf-8');
  const beginIdx = src.indexOf(BEGIN_MARKER);
  const endIdx = src.indexOf(END_MARKER);
  assert.ok(beginIdx >= 0 && endIdx >= 0, 'ROLE_SCHEMAS_GENERATED_BEGIN/END markers must be present in auto-sprint.js');

  for (const [role, constName] of ROLES) {
    const expected = loadStrippedSchema(role);
    const expectedLiteral = `const ${constName} = ${JSON.stringify(expected, null, 2)};`;
    assert.ok(
      src.includes(expectedLiteral),
      `${constName} in auto-sprint.js is stale relative to agents/schemas/${role}-output.json -- run \`node scripts/gen-auto-sprint-schemas.mjs\` and commit the result`
    );
  }
});

test('every inlined role schema has the "version" key stripped (strict-mode agent-tool validator rejects it)', () => {
  const src = readFileSync(targetFile, 'utf-8');
  const beginIdx = src.indexOf(BEGIN_MARKER);
  const endIdx = src.indexOf(END_MARKER) + END_MARKER.length;
  const block = src.slice(beginIdx, endIdx);
  assert.doesNotMatch(block, /"version":\s*\d/, 'no inlined role schema may carry a "version" key -- the agent tool\'s strict-mode schema validator rejects unrecognized keywords (see the s10 2026-07-17 failure, run 29605783512)');
});
