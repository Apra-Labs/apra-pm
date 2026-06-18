#!/usr/bin/env node
// apra-pm installer -- plain Node, no build step, no MCP.
// Installs the pm skill and its four agents into a provider's config dir,
// and grants the minimal permissions the orchestrator needs.
//
// Usage:
//   node install.mjs [--llm claude|gemini|agy] [--force] [--help]
//
// Inspired by the apra-fleet installer, trimmed to skill + agents only.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

// --- provider config -------------------------------------------------------
// Each provider gets a config dir; the skill lands in <configDir>/skills/pm,
// the agents in <configDir>/agents, and permissions merge into settings.json.
function providerConfig(llm) {
  switch (llm) {
    case 'claude':
      return { name: 'Claude', configDir: path.join(HOME, '.claude'), settingsFile: 'settings.json' };
    case 'gemini':
      return { name: 'Gemini', configDir: path.join(HOME, '.gemini'), settingsFile: 'settings.json' };
    case 'agy':
      return { name: 'Antigravity', configDir: path.join(HOME, '.gemini', 'antigravity-cli'), settingsFile: 'settings.json' };
    case 'opencode':
      return { name: 'OpenCode', configDir: path.join(HOME, '.config', 'opencode'), settingsFile: 'opencode.json' };
    default:
      throw new Error(`unknown provider "${llm}" (expected: claude | gemini | agy | opencode)`);
  }
}

// Minimal permissions the orchestrator needs: dispatch subagents, and run git /
// beads / gh / the project's test command via the shell. Read access to the skill.
function requiredPermissions(cfg) {
  const skills = path.join(cfg.configDir, 'skills').replace(/\\/g, '/');
  return [
    'Agent',
    'Task',
    'Bash(git:*)',
    'Bash(bd:*)',
    'Bash(gh:*)',
    `Read(${skills}/**)`,
  ];
}

// --- opencode agent transform -----------------------------------------------
// OpenCode uses a different agent frontmatter schema:
//   description, mode: subagent, permission: { edit, write, bash }
// Claude uses: name, description, tools: [...]
// This mirrors the transformAgentForOpenCode in apra-fleet src/cli/agent-transform.ts.
function transformAgentForOpenCode(content) {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return content;

  const frontmatter = fmMatch[1];
  const body = content.slice(fmMatch[0].length);

  let description = '';
  let tools = [];
  let hasTools = false;

  for (const line of frontmatter.split('\n')) {
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim();
    const toolsMatch = line.match(/^tools:\s*(.+)/);
    if (toolsMatch) {
      hasTools = true;
      tools = toolsMatch[1].replace(/^\[/, '').replace(/\]$/, '').split(',').map(t => t.trim()).filter(Boolean);
    }
  }

  const toolSet = new Set(tools);
  const perm = hasTools
    ? { edit: toolSet.has('Edit') ? 'allow' : 'deny', write: 'allow', bash: toolSet.has('Bash') ? 'allow' : 'deny' }
    : { edit: 'deny', write: 'allow', bash: 'deny' };

  const opencodeFm = [
    '---',
    `description: ${description}`,
    'mode: subagent',
    'permission:',
    `  edit: ${perm.edit}`,
    `  write: ${perm.write}`,
    `  bash: ${perm.bash}`,
    '---',
    '',
  ].join('\n');

  return opencodeFm + body;
}

// --- fs helpers ------------------------------------------------------------
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function clearDir(d) {
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  ensureDir(d);
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return {}; }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// --- permission merge ------------------------------------------------------
function mergePermissions(settingsFile, perms) {
  const settings = readJson(settingsFile);
  settings.permissions = settings.permissions || {};
  const allow = new Set(settings.permissions.allow || []);
  let added = 0;
  for (const p of perms) if (!allow.has(p)) { allow.add(p); added++; }
  settings.permissions.allow = [...allow];
  writeJson(settingsFile, settings);
  return added;
}

// --- main ------------------------------------------------------------------
function parseArgs(argv) {
  const args = { llm: 'claude', force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--force') args.force = true;
    else if (a === '--llm') args.llm = argv[++i];
    else if (a.startsWith('--llm=')) args.llm = a.split('=')[1];
    else throw new Error(`unknown argument "${a}" (try --help)`);
  }
  return args;
}

const HELP = `apra-pm installer

Installs the auto-sprint workflow, pm skill, and eight agents into your agent
harness's config directory, and grants minimal permissions.

Usage:
  node install.mjs [options]

Options:
  --llm <provider>   claude (default) | gemini | agy | opencode
  --force            reinstall even if already present
  --help             show this help

What it installs:
  <configDir>/skills/pm/      the skill (SKILL.md + sub-docs)
  <configDir>/agents/*.md     eight sprint agents (see below)
  <configDir>/settings.json   minimal permissions (merged, non-destructive)
  ~/.claude/workflows/auto-sprint.js  deterministic workflow (claude only)

Agents:
  planner            reads open epics, creates feature+task DAG in beads
  plan-reviewer      validates beads DAG: coverage, size, acceptance criteria
  doer               works bd-ready tasks, commits after each, stops at VERIFY
  reviewer           reviews diff vs beads acceptance criteria, can reopen tasks
  deployer           follows deploy.md and integ-test-playbook.md
  integ-test-runner  executes integration tests, closes features, files bugs
  ci-watcher         polls CI for the sprint HEAD SHA
  harvester          extracts durable knowledge, updates docs/README/CHANGELOG

Requires: git, gh (GitHub CLI), and beads (bd) for task tracking.`;

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`error: ${e.message}`); process.exit(2); }

  if (args.help) { console.log(HELP); return; }

  let cfg;
  try { cfg = providerConfig(args.llm); }
  catch (e) { console.error(`error: ${e.message}`); process.exit(2); }

  const skillSrc = path.join(ROOT, 'skills', 'pm');
  const agentsSrc = path.join(ROOT, 'agents');
  if (!fs.existsSync(skillSrc) || !fs.existsSync(agentsSrc)) {
    console.error('error: run this from the apra-pm repo root (skills/ and agents/ not found)');
    process.exit(1);
  }

  const skillDest = path.join(cfg.configDir, 'skills', 'pm');
  const agentsDest = path.join(cfg.configDir, 'agents');
  const settingsFile = path.join(cfg.configDir, cfg.settingsFile);

  if (fs.existsSync(skillDest) && !args.force) {
    console.error(`pm already installed at ${skillDest} (use --force to reinstall)`);
    process.exit(1);
  }

  console.log(`Installing pm for ${cfg.name} ...`);

  // 1) skill
  clearDir(skillDest);
  copyDir(skillSrc, skillDest);
  console.log(`  [1/3] skill   -> ${skillDest}`);

  // 2) agents (overwrite the eight; leave any others in place)
  ensureDir(agentsDest);
  const agents = fs.readdirSync(agentsSrc).filter(f => f.endsWith('.md'));
  for (const a of agents) {
    let content = fs.readFileSync(path.join(agentsSrc, a), 'utf-8');
    if (args.llm === 'opencode') content = transformAgentForOpenCode(content);
    fs.writeFileSync(path.join(agentsDest, a), content);
  }
  console.log(`  [2/3] agents  -> ${agentsDest} (${agents.length}: ${agents.map(a => a.replace('.md', '')).join(', ')})`);

  // 3) permissions
  let added;
  if (args.llm === 'opencode') {
    // OpenCode does not support a permissions key in opencode.json -- it rejects
    // any unrecognized key as invalid config. Permissions are passed via CLI flags
    // (--dangerously-skip-permissions) at invocation time; nothing to write here.
    // Remove any stale permissions key a prior install run may have added.
    const settings = readJson(settingsFile);
    if (Object.prototype.hasOwnProperty.call(settings, 'permissions')) {
      delete settings.permissions;
      writeJson(settingsFile, settings);
    }
    added = 0;
  } else {
    added = mergePermissions(settingsFile, requiredPermissions(cfg));
  }
  console.log(`  [3/3] perms   -> ${settingsFile} (${added} added)`);

  // 4) workflow (claude provider only -- auto-sprint.js -> ~/.claude/workflows/)
  if (args.llm === 'claude') {
    const workflowSrc = path.join(ROOT, '.claude', 'workflows', 'auto-sprint.js');
    const workflowDest = path.join(HOME, '.claude', 'workflows', 'auto-sprint.js');
    if (fs.existsSync(workflowSrc)) {
      ensureDir(path.dirname(workflowDest));
      fs.copyFileSync(workflowSrc, workflowDest);
      console.log(`  [wf]  workflow -> ${workflowDest}`);
    }
  }

  // beads check -- install automatically if missing
  console.log('');
  const bdCheck = spawnSync('bd', ['--version'], { encoding: 'utf-8', shell: true });
  if (bdCheck.error || bdCheck.status !== 0) {
    console.log('  beads (bd) not found -- installing via npm...');
    const bdInstall = spawnSync('npm', ['install', '-g', '@beads/bd'], { encoding: 'utf-8', shell: true, stdio: 'inherit' });
    if (bdInstall.error || bdInstall.status !== 0) {
      console.error('  [!] beads install failed. Run manually:  npm install -g @beads/bd');
    } else {
      const bdRecheck = spawnSync('bd', ['--version'], { encoding: 'utf-8', shell: true });
      console.log(`  beads OK: ${bdRecheck.stdout.trim()}`);
    }
  } else {
    console.log(`  beads OK: ${bdCheck.stdout.trim()}`);
  }
  console.log('');
  console.log('pm installed. Invoke the "pm" skill to drive a sprint.');
}

main();
