// Parse pm-lite e2e checkpoints. Primary source is the checkpoints.json file the
// orchestrator appends to (one JSON object per line); a stdout parser is provided
// as a fallback. A run passes when the terminal checkpoint is PASS, every expected
// checkpoint is PASS, and no checkpoint FAILED.
import fs from 'node:fs';

function evaluate(checkpoints, terminal, expected) {
  const isPass = (c) => String(c.status).toUpperCase() === 'PASS';
  const anyFail = checkpoints.some((c) => String(c.status).toUpperCase() === 'FAIL');
  const term = checkpoints.find((c) => c.id === terminal && isPass(c));
  const missing = expected.filter((id) => !checkpoints.some((c) => c.id === id && isPass(c)));
  const pass = !!term && !anyFail && missing.length === 0;
  let reason = '';
  if (anyFail) reason = 'a checkpoint FAILED';
  else if (!term) reason = `terminal "${terminal}" missing`;
  else if (missing.length) reason = `missing: ${missing.join(', ')}`;
  return { checkpoints, pass, reason, missing };
}

function collect(text, re) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    try { out.push(JSON.parse(m[m.length - 1])); } catch { /* skip malformed */ }
  }
  return out;
}

export function parseCheckpointsFile(file, terminal, expected = []) {
  if (!fs.existsSync(file)) return { checkpoints: [], pass: false, reason: 'no checkpoints.json', missing: expected };
  return evaluate(collect(fs.readFileSync(file, 'utf-8'), /(\{.*\})\s*$/), terminal, expected);
}

export function parseCheckpointsStdout(stdout, terminal, expected = []) {
  return evaluate(collect(stdout, /CHECKPOINT:\s*(\{.*\})/), terminal, expected);
}
