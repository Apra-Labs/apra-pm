#!/usr/bin/env node
// pm-lite e2e local runner.
//
// For each selected suite: clone the toy repo, render the scenario with the repo
// path, invoke the provider's CLI headless with the pm-lite skill installed, then
// read checkpoints.json the orchestrator wrote and decide pass/fail.
//
// Usage:
//   node e2e/run-e2e.mjs [--suite s1.1] [--provider claude|gemini|agy] [--timeout 1800]
//
// Selection: default is every suite whose `os` matches this host. --suite picks one
// by id; --provider filters by provider. The skill must be installed first
// (node install.mjs --llm <provider>).
//
// CLI flags vary by tool/version; override a provider's command with
//   PMLITE_E2E_CMD_CLAUDE="claude -p {PROMPT} --permission-mode acceptEdits"
// ({PROMPT} is substituted with the rendered scenario).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCheckpointsFile } from './extract-results.mjs';
import { postSummary } from './post-summary.mjs';

const E2E = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(E2E, 'suites.json'), 'utf-8'));
const scenarioTpl = fs.readFileSync(path.join(E2E, 'scenario.md'), 'utf-8');

// Default headless command per provider. {PROMPT} is replaced with the scenario.
const CLI = {
  claude: ['claude', '-p', '{PROMPT}', '--permission-mode', 'acceptEdits'],
  gemini: ['gemini', '-p', '{PROMPT}', '--yolo'],
  agy: ['agy', '-p', '{PROMPT}'],
};

const hostOs = () => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf-8' });
  return r.status === 0;
}

function parseArgs() {
  const a = { suite: null, provider: null, timeout: 1800 };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--suite') a.suite = v[++i];
    else if (v[i] === '--provider') a.provider = v[++i];
    else if (v[i] === '--timeout') a.timeout = Number(v[++i]);
    else { console.error(`unknown arg "${v[i]}"`); process.exit(2); }
  }
  return a;
}

function selectSuites(a) {
  if (a.suite) return cfg.suites.filter((s) => s.id === a.suite);
  let s = cfg.suites.filter((x) => x.os === hostOs());
  if (a.provider) s = s.filter((x) => x.provider === a.provider);
  return s;
}

function commandFor(provider, prompt) {
  const override = process.env[`PMLITE_E2E_CMD_${provider.toUpperCase()}`];
  const tokens = override ? override.split(' ') : CLI[provider];
  const filled = tokens.map((t) => (t === '{PROMPT}' ? prompt : t));
  return { bin: filled[0], args: filled.slice(1) };
}

function git(args, opts = {}) { return spawnSync('git', args, { encoding: 'utf-8', ...opts }); }

function runSuite(suite, timeoutS) {
  const res = { id: suite.id, provider: suite.provider, os: suite.os, status: '', notes: '', checkpoints: [] };
  const { bin } = commandFor(suite.provider, '');
  if (!which(bin)) { res.status = 'SKIP'; res.notes = `${bin} not found on PATH`; return res; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `pmlite-e2e-${suite.id}-`));
  const repo = path.join(work, 'repo');

  const clone = git(['clone', '--depth', '1', cfg.toy, repo]);
  if (clone.status !== 0) { res.status = 'FAIL'; res.notes = `clone failed: ${(clone.stderr || '').trim().slice(0, 200)}`; return res; }
  git(['-C', repo, 'config', 'user.email', 'e2e@pm-lite']);
  git(['-C', repo, 'config', 'user.name', 'pm-lite-e2e']);
  // Make the clone genuinely local-only so the skill's transport detection does
  // not push the sprint work back to the toy's origin.
  git(['-C', repo, 'remote', 'remove', 'origin']);

  const prompt = scenarioTpl.replaceAll('{{REPO}}', repo.replace(/\\/g, '/'));
  const { bin: cmd, args } = commandFor(suite.provider, prompt);

  console.log(`[${suite.id}] ${cmd} (cwd ${work}) ...`);
  const r = spawnSync(cmd, args, { cwd: work, encoding: 'utf-8', timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(work, 'cli.log'), `${r.stdout || ''}\n---STDERR---\n${r.stderr || ''}`);

  const cp = parseCheckpointsFile(path.join(repo, 'checkpoints.json'), cfg.terminal, cfg.checkpoints);
  res.checkpoints = cp.checkpoints;
  if (r.error && r.error.code === 'ETIMEDOUT') { res.status = 'FAIL'; res.notes = `timed out after ${timeoutS}s; ${cp.reason || ''}`.trim(); }
  else { res.status = cp.pass ? 'PASS' : 'FAIL'; res.notes = cp.pass ? 'all checkpoints passed' : (cp.reason || 'incomplete'); }
  res.work = work;
  return res;
}

function main() {
  const a = parseArgs();
  const suites = selectSuites(a);
  if (!suites.length) { console.error(`no suites match (host os=${hostOs()})`); process.exit(2); }

  const results = [];
  for (const s of suites) {
    const r = runSuite(s, a.timeout);
    console.log(`[${r.id}] ${r.status} -- ${r.notes}`);
    results.push(r);
  }

  const outDir = path.join(E2E, '..', 'e2e-results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results }, null, 2) + '\n');

  postSummary(results);
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main();
