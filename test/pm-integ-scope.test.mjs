import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for the /pm skill (suites s1-s9): the integ-test-runner agent must
// test/close ONLY features in THIS sprint's root subtree. It used to run the unscoped
// `bd list --type=feature --status=open` -- every open feature in the whole beads DB --
// so on a populated DB it would test, close, or file bugs against unrelated features
// from other epics/sprints (and the toy's noise items). This mirrors the auto-sprint
// (s10) getSprintOpenFeatures fix; see integ-scope.test.mjs.

const dir = dirname(fileURLToPath(import.meta.url));
const agentMd = readFileSync(join(dir, '../agents/integ-test-runner.md'), 'utf-8');
const sprintMd = readFileSync(join(dir, '../skills/pm/sprint.md'), 'utf-8');

test('integ-test-runner agent does NOT instruct the unscoped `bd list --type=feature --status=open`', () => {
  // The doc legitimately names the anti-pattern in a "do NOT run" warning, so assert it
  // never appears as an imperative command (in a fenced bash block or as a bare command).
  assert.doesNotMatch(agentMd, /```bash\s*\n\s*bd list --type=feature --status=open/,
    'the agent must not have a fenced `bd list --type=feature --status=open` command block');
});

test('integ-test-runner agent scopes to the sprint root via bd graph', () => {
  assert.match(agentMd, /sprint root id/i, 'must reference the sprint root id it is handed');
  assert.match(agentMd, /bd graph --json <sprint-id>/,
    'must enumerate the sprint via `bd graph --json <sprint-id>`');
  assert.match(agentMd, /issue_type == "feature"/,
    'must filter the graph to features');
  assert.match(agentMd, /status != "closed"/,
    'must filter to open (non-closed) features');
  assert.match(agentMd, /sprint-root subtree/i,
    'must describe scoping to the sprint-root subtree');
});

test('integ-test-runner agent explicitly warns against the unscoped list', () => {
  assert.match(agentMd, /Do NOT run `bd list --type=feature --status=open`/,
    'must explicitly warn against the unscoped global list');
});

test('sprint.md Test phase passes the sprint root id to the integ-test-runner dispatch', () => {
  const idx = sprintMd.indexOf('**Integration tests**');
  assert.ok(idx >= 0, 'sprint.md must have an Integration tests dispatch step');
  const region = sprintMd.slice(idx, idx + 500);
  assert.match(region, /sprint root id/i,
    'the Integration tests dispatch must pass the sprint root id');
  assert.match(region, /sprint-root subtree only|subtree only/i,
    'the dispatch must restrict testing to the sprint-root subtree');
});
