import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const skillMd = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../skills/pm/SKILL.md'),
  'utf-8'
);

const fleetAddendumMd = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../skills/pm/fleet-addendum.md'),
  'utf-8'
);

// Test 1: tags: ['doer'] appears in permission-composition guidance in SKILL.md
test('SKILL.md R9 uses tags: [\'doer\'] for doer member permission selection', () => {
  assert.match(skillMd, /tags:\s*\[\s*['"]doer['"]\s*\]/,
    'SKILL.md must contain tags: [\'doer\'] for member selection');
});

// Test 2: tags: ['reviewer'] appears in permission-composition guidance in SKILL.md
test('SKILL.md R9 uses tags: [\'reviewer\'] for reviewer member permission selection', () => {
  assert.match(skillMd, /tags:\s*\[\s*['"]reviewer['"]\s*\]/,
    'SKILL.md must contain tags: [\'reviewer\'] for member selection');
});

// Test 3: No role-based dispatch wording in SKILL.md
test('SKILL.md dispatch guidance must not contain role: doer or role: reviewer', () => {
  // Specifically look for role-based wording in permission context (not general usage of "role")
  const roleBasedDispatch = /compose_permissions.*?role:\s*['"]?(doer|reviewer)/is;
  assert.doesNotMatch(skillMd, roleBasedDispatch,
    'SKILL.md must not use role: doer or role: reviewer in dispatch/permission context');
});

// Test 4: compose_permissions is called before dispatch
test('SKILL.md R9 states compose_permissions called before dispatch', () => {
  assert.match(skillMd, /compose_permissions.*?before.*?dispatch/is,
    'SKILL.md R9 must specify compose_permissions is called before dispatch');
});

// Test 5: Verify compose_permissions is mentioned in fleet-mode rule R9
test('SKILL.md R9 rule mentions compose_permissions', () => {
  assert.match(skillMd, /R9.*compose_permissions/is,
    'SKILL.md R9 must mention compose_permissions');
});

// Test 6: fleet-addendum.md uses tags: ['doer']
test('fleet-addendum.md Permissions section uses tags: [\'doer\'] for doer members', () => {
  assert.match(fleetAddendumMd, /tags:\s*\[\s*['"]doer['"]\s*\]/,
    'fleet-addendum.md must contain tags: [\'doer\'] in permission guidance');
});

// Test 7: fleet-addendum.md uses tags: ['reviewer']
test('fleet-addendum.md Permissions section uses tags: [\'reviewer\'] for reviewer members', () => {
  assert.match(fleetAddendumMd, /tags:\s*\[\s*['"]reviewer['"]\s*\]/,
    'fleet-addendum.md must contain tags: [\'reviewer\'] in permission guidance');
});

// Test 8: No role-based dispatch wording in fleet-addendum.md
test('fleet-addendum.md permission guidance must not contain role: doer or role: reviewer', () => {
  const roleBasedDispatch = /member using tag-based selection.*?role:\s*['"]?(doer|reviewer)/is;
  assert.doesNotMatch(fleetAddendumMd, roleBasedDispatch,
    'fleet-addendum.md must not use role-based dispatch wording in permission context');
});

// Test 9: compose_permissions is called before every dispatch in fleet-addendum.md
test('fleet-addendum.md states compose_permissions called before EVERY dispatch', () => {
  assert.match(fleetAddendumMd, /compose_permissions.*?before.*?EVERY.*?dispatch/is,
    'fleet-addendum.md must state compose_permissions is called before every dispatch');
});
