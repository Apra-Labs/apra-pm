import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- appendNewEntries flush-timestamp behaviour (source-introspection) -------

test('appendNewEntries uses __FLUSH_TS__ placeholder, not the static sprint-start timestamp', () => {
  const fnStart = src.indexOf('async function appendNewEntries(');
  assert.ok(fnStart >= 0, 'appendNewEntries function must exist');
  // Find the closing brace of the function by scanning for the next top-level async function
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const region = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart, fnStart + 1500);

  assert.match(region, /__FLUSH_TS__/,
    'appendNewEntries must embed __FLUSH_TS__ placeholder in log lines, not the static sprintTs');
  assert.doesNotMatch(region, /ts:\s*sprintTs/,
    'appendNewEntries must not stamp log lines with the static sprint-start sprintTs');
});

test('appendNewEntries prompts the log-append agent to run date for local wall-clock time', () => {
  const fnStart = src.indexOf('async function appendNewEntries(');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const region = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart, fnStart + 1500);

  assert.match(region, /date\s+\+%Y-%m-%dT%H:%M:%S%z/,
    'log-append prompt must invoke `date +%Y-%m-%dT%H:%M:%S%z` for local timestamp with tz offset');
  assert.doesNotMatch(region, /date\s+-u\s+\+%Y-%m-%dT%H:%M:%SZ/,
    'log-append prompt must not use UTC date (-u flag)');
});

test('appendNewEntries instructs agent to substitute __FLUSH_TS__ before appending', () => {
  const fnStart = src.indexOf('async function appendNewEntries(');
  const fnEnd = src.indexOf('\nasync function ', fnStart + 1);
  const region = fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart, fnStart + 1500);

  assert.match(region, /replace.*__FLUSH_TS__|__FLUSH_TS__.*replace/i,
    'log-append prompt must instruct the agent to replace __FLUSH_TS__ with the captured timestamp');
});
