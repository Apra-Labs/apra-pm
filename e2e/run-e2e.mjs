#!/usr/bin/env node
// pm-lite e2e local runner.
//
// For each selected suite: clone the toy repo, render the scenario with the repo
// path and a unique branch, invoke the provider's CLI headless with the pm-lite
// skill installed, then read checkpoints.json the orchestrator wrote and decide
// pass/fail. The sprint pushes to the toy and raises a real PR (no merge).
//
// Inspection: before tearing the PR down we capture its URL and commit list and
// print them into the job summary. A closed PR with a deleted branch still serves
// /pull/<n>/commits on GitHub, so a reviewer can always click through to see exactly
// how the sprint progressed -- even though teardown keeps the toy tidy.
//
// Telemetry: providers are invoked with stream-json output so token usage (in/out,
// cache) is captured per run and reported in the summary for cost-regression tracking.
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
import { parseCheckpointsFile, checkpointsHaveTerminal, parseTelemetryFile, diagnoseFailure } from './extract-results.mjs';
import { validateSprint } from './validate-sprint.mjs';
import { postSummary } from './post-summary.mjs';

const E2E = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(E2E, 'suites.json'), 'utf-8'));
const scenarioTpl = fs.readFileSync(path.join(E2E, 'scenario.md'), 'utf-8');

// Default headless command per provider. {PROMPT} is replaced with the scenario.
// The autonomy flags matter: without them the CLI stalls on permission/trust gates
// (e.g. when dispatching a subagent) and times out. stream-json output is what lets
// us account tokens. Override with PMLITE_E2E_CMD_<P>.
const CLI = {
  claude: ['claude', '-p', '{PROMPT}', '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '--max-turns', '100'],
  gemini: ['gemini', '-p', '{PROMPT}', '--model', 'auto', '--skip-trust', '--output-format', 'stream-json'],
  // agy print mode defaults to a 5m wait; a full sprint is ~30m, so raise it. agy
  // emits no stream-json: its transcript is read from disk after exit (see runAgy).
  agy: ['agy', '--print-timeout=40m', '-p', '{PROMPT}', '--dangerously-skip-permissions'],
};

const hostOs = () => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf-8' });
  return r.status === 0;
}

function parseArgs() {
  const a = { suite: null, provider: null, timeout: 2700, keepPr: false };
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

function ghEnv(token) { return token ? { ...process.env, GH_TOKEN: token } : process.env; }

// Capture the PR raised for this branch BEFORE teardown: its URL, commit list, and
// the /commits permalink that survives branch deletion. Best effort.
function capturePr(branch, token) {
  if (!OWNER_REPO) return null;
  const r = spawnSync('gh', ['pr', 'view', branch, '-R', OWNER_REPO, '--json', 'url,number,state,commits'],
    { encoding: 'utf-8', env: ghEnv(token) });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const j = JSON.parse(r.stdout);
    if (!j.url) return null;
    return {
      number: j.number,
      url: j.url,
      state: j.state,
      commitsUrl: `${j.url}/commits`,
      commits: (j.commits || []).map((c) => ({ sha: String(c.oid || '').slice(0, 7), msg: c.messageHeadline || '' })),
    };
  } catch { return null; }
}

// Close the e2e PR and delete its branch on the toy -- good housekeeping so repeated
// runs do not pile up on the shared public repo. The commits stay visible via the
// captured /pull/<n>/commits URL even after the branch is gone.
function teardownPr(branch, token) {
  if (!OWNER_REPO) return;
  const env = ghEnv(token);
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

// agy writes its conversation to disk, not stdout. After it exits we look up the
// conversation id for the run cwd and dump its transcript.jsonl. Mirrors the proven
// fleet e2e approach.
const AGY_TRANSCRIPT_SCRIPT =
  "const fs=require('fs'),path=require('path');const home=process.env.USERPROFILE||process.env.HOME||'';" +
  "const cache=JSON.parse(fs.readFileSync(path.join(home,'.gemini','antigravity-cli','cache','last_conversations.json'),'utf8'));" +
  "const norm=p=>path.resolve(p).toLowerCase().split(path.sep).join('/');const target=norm(process.argv[1]);" +
  "let id='';for(const k of Object.keys(cache)){if(norm(k)===target){id=cache[k];break;}}" +
  "if(!id){process.stdout.write('FLEET_TRANSCRIPT_MISSING:NO_CONV\\n');process.exit(0);}" +
  "const tp=path.join(home,'.gemini','antigravity-cli','brain',id,'.system_generated','logs','transcript.jsonl');" +
  "if(fs.existsSync(tp)){process.stdout.write('FLEET_TRANSCRIPT_START\\n');process.stdout.write(fs.readFileSync(tp,'utf8'));process.stdout.write('\\nFLEET_TRANSCRIPT_END\\n');}" +
  "else{process.stdout.write('FLEET_TRANSCRIPT_MISSING:'+id+'\\n');}";

function appendAgyTranscript(cwd, logPath) {
  const r = spawnSync('node', ['-e', AGY_TRANSCRIPT_SCRIPT, cwd], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  fs.appendFileSync(logPath, `\n${r.stdout || ''}${r.stderr || ''}`);
}

// agy -p stops after each text response, so a full sprint needs resuming until the
// terminal checkpoint lands. Returns { timedOut }.
function runAgy(cmd, args, cwd, logPath, repo, terminal, timeoutS) {
  const first = spawnSync(cmd, args, { cwd, encoding: 'utf-8', timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(logPath, `${first.stdout || ''}\n---STDERR---\n${first.stderr || ''}`);
  appendAgyTranscript(cwd, logPath);
  if (first.error && first.error.code === 'ETIMEDOUT') return { timedOut: true };

  for (let i = 1; i <= 4; i++) {
    if (checkpointsHaveTerminal(path.join(repo, 'checkpoints.json'), terminal)) break;
    console.log(`[agy] resume attempt ${i} -- terminal "${terminal}" not yet in checkpoints.json`);
    const cont = ['--print-timeout=40m', '--continue', '-p',
      'Continue from where you left off. Complete all remaining checkpoints without stopping, then write the terminal checkpoint.',
      '--dangerously-skip-permissions'];
    const r = spawnSync(cmd, cont, { cwd, encoding: 'utf-8', timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024 });
    fs.appendFileSync(logPath, `\n---RESUME ${i}---\n${r.stdout || ''}\n${r.stderr || ''}`);
    appendAgyTranscript(cwd, logPath);
    if (r.error && r.error.code === 'ETIMEDOUT') return { timedOut: true };
  }
  return { timedOut: false };
}

function runSuite(suite, timeoutS, keepPr) {
  const res = { id: suite.id, provider: suite.provider, os: suite.os, status: '', notes: '', checkpoints: [], pr: null, telemetry: null, gates: null };
  const { bin } = commandFor(suite.provider, '');
  if (!which(bin)) { res.status = 'SKIP'; res.notes = `${bin} not found on PATH`; return res; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `pmlite-e2e-${suite.id}-`));
  const repo = path.join(work, 'repo');
  const logPath = path.join(work, 'cli.log');

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
  let timedOut = false;
  if (suite.provider === 'agy') {
    ({ timedOut } = runAgy(cmd, args, work, logPath, repo, cfg.terminal, timeoutS));
  } else {
    const r = spawnSync(cmd, args, { cwd: work, encoding: 'utf-8', timeout: timeoutS * 1000, maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(logPath, `${r.stdout || ''}\n---STDERR---\n${r.stderr || ''}`);
    timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  }

  const cp = parseCheckpointsFile(path.join(repo, 'checkpoints.json'), cfg.terminal, cfg.checkpoints);
  res.checkpoints = cp.checkpoints;
  res.branch = branch;
  res.work = work;
  res.telemetry = parseTelemetryFile(logPath, suite.provider);

  // Capture the PR (URL + commits) and run the independent validation gates BEFORE
  // teardown, while the branch still exists on origin.
  res.pr = capturePr(branch, token);
  let gatesPass = false;
  if (!timedOut) {
    const v = validateSprint({ repo, branch, pr: res.pr });
    res.gates = v.gates;
    gatesPass = v.pass;
  }

  if (timedOut) {
    const why = diagnoseFailure(logPath);
    res.status = 'FAIL';
    res.notes = `timed out after ${timeoutS}s; ${why || cp.reason || ''}`.trim();
  } else if (cp.pass && gatesPass) {
    res.status = 'PASS';
    res.notes = 'checkpoints + all validation gates passed';
  } else if (!cp.pass) {
    res.status = 'FAIL';
    res.notes = cp.reason || diagnoseFailure(logPath) || 'incomplete';
  } else {
    const failed = (res.gates || []).filter((g) => !g.pass).map((g) => g.name);
    res.status = 'FAIL';
    res.notes = `validation gates failed: ${failed.join(', ')}`;
  }

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
    if (r.pr) console.log(`[${r.id}] commits: ${r.pr.commitsUrl}`);
    results.push(r);
  }

  const outDir = path.join(E2E, '..', 'e2e-results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results }, null, 2) + '\n');

  // Copy each run's raw CLI log into the artifact dir so a failed run is inspectable
  // (the tmp work dir is otherwise discarded by the runner).
  for (const r of results) {
    const src = r.work && path.join(r.work, 'cli.log');
    if (src && fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(outDir, `${r.id}-cli.log`)); } catch { /* non-fatal */ }
    }
  }

  postSummary(results);
  process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main();
