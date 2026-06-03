#!/usr/bin/env node
// pm-lite e2e local runner.
//
// For each selected suite: clone the toy repo, render the scenario with the repo
// path and a unique branch, invoke the provider's CLI headless with the pm-lite
// skill installed, then read checkpoints.json the orchestrator wrote and decide
// pass/fail. The sprint pushes to the toy and raises a real PR (no merge); the
// runner closes that PR and deletes its branch afterward unless --keep-pr.
//
// Usage:
//   node e2e/run-e2e.mjs [--suite s1.1] [--provider claude|gemini|agy] [--timeout 1800] [--keep-pr]
//
// Selection: default is every suite whose `os` matches this host. --suite picks one
// by id; --provider filters by provider. The skill must be installed first
// (node install.mjs --llm <provider>).
//
// Auth: pushing the branch and opening the PR needs write access to the toy. Provide
// it via GH_TOKEN / E2E_GH_TOKEN (wired into the push URL and gh), or rely on the
// runner's ambient git + gh credentials.
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
// The autonomy flags matter: without them the CLI stalls on permission/trust gates
// (e.g. when dispatching a subagent) and times out. Override with PMLITE_E2E_CMD_<P>.
const CLI = {
  claude: ['claude', '-p', '{PROMPT}', '--dangerously-skip-permissions'],
  gemini: ['gemini', '-p', '{PROMPT}', '--model', 'auto', '--skip-trust'],
  agy: ['agy', '-p', '{PROMPT}', '--dangerously-skip-permissions'],
};

const hostOs = () => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf-8' });
  return r.status === 0;
}

function parseArgs() {
  const a = { suite: null, provider: null, timeout: 1800, keepPr: false };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--suite') a.suite = v[++i];
    else if (v[i] === '--provider') a.provider = v[++i];
    else if (v[i] === '--timeout') a.timeout = Number(v[++i]);
    else if (v[i] === '--keep-pr') a.keepPr = true;
    else { console.error(`unknown arg "${v[i]}"`); process.exit(2); }
  }
  return a;
}

// owner/repo slug for gh commands, derived from the toy URL.
const OWNER_REPO = (cfg.toy.match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1] || null;

// Close the e2e PR and delete its branch on the toy -- best effort, so repeated
// runs do not pile up on the shared public repo.
function teardownPr(branch, token) {
  if (!OWNER_REPO) return;
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  spawnSync('gh', ['pr', 'close', branch, '-R', OWNER_REPO, '--delete-branch'], { encoding: 'utf-8', env });
  // Drop the branch even if no PR was opened (failure before the pr step).
  spawnSync('gh', ['api', '-X', 'DELETE', `repos/${OWNER_REPO}/git/refs/heads/${branch}`], { encoding: 'utf-8', env });
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

function runSuite(suite, timeoutS, keepPr) {
  const res = { id: suite.id, provider: suite.provider, os: suite.os, status: '', notes: '', checkpoints: [] };
  const { bin } = commandFor(suite.provider, '');
  if (!which(bin)) { res.status = 'SKIP'; res.notes = `${bin} not found on PATH`; return res; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `pmlite-e2e-${suite.id}-`));
  const repo = path.join(work, 'repo');

  const clone = git(['clone', cfg.toy, repo]);
  if (clone.status !== 0) { res.status = 'FAIL'; res.notes = `clone failed: ${(clone.stderr || '').trim().slice(0, 200)}`; return res; }
  git(['-C', repo, 'config', 'user.email', 'e2e@pm-lite']);
  git(['-C', repo, 'config', 'user.name', 'pm-lite-e2e']);

  // The sprint pushes and raises a PR, so keep origin. If a token is provided, wire
  // it into the push URL (gh reads GH_TOKEN from the environment on its own).
  const token = process.env.GH_TOKEN || process.env.E2E_GH_TOKEN || '';
  if (token && OWNER_REPO) {
    git(['-C', repo, 'remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/${OWNER_REPO}.git`]);
  }

  const branch = `pmlite-e2e/${suite.id}-${Date.now()}`;
  const prompt = scenarioTpl
    .replaceAll('{{REPO}}', repo.replace(/\\/g, '/'))
    .replaceAll('{{BRANCH}}', branch);
  const { bin: cmd, args } = commandFor(suite.provider, prompt);

  console.log(`[${suite.id}] ${cmd} (cwd ${work}, branch ${branch}) ...`);
  const r = spawnSync(cmd, args, { cwd: work, encoding: 'utf-8', timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(work, 'cli.log'), `${r.stdout || ''}\n---STDERR---\n${r.stderr || ''}`);

  const cp = parseCheckpointsFile(path.join(repo, 'checkpoints.json'), cfg.terminal, cfg.checkpoints);
  res.checkpoints = cp.checkpoints;
  res.branch = branch;
  if (r.error && r.error.code === 'ETIMEDOUT') { res.status = 'FAIL'; res.notes = `timed out after ${timeoutS}s; ${cp.reason || ''}`.trim(); }
  else { res.status = cp.pass ? 'PASS' : 'FAIL'; res.notes = cp.pass ? 'all checkpoints passed' : (cp.reason || 'incomplete'); }
  res.work = work;

  if (!keepPr) teardownPr(branch, token);
  return res;
}

function main() {
  const a = parseArgs();
  const suites = selectSuites(a);
  if (!suites.length) { console.error(`no suites match (host os=${hostOs()})`); process.exit(2); }

  const results = [];
  for (const s of suites) {
    const r = runSuite(s, a.timeout, a.keepPr);
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
