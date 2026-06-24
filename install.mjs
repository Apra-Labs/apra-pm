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
// Permissions shared across all providers that support settings.json.
function requiredPermissions(cfg) {
  const skills = path.join(cfg.configDir, 'skills').replace(/\\/g, '/');
  return [
    'Agent',
    'Task',
    'Bash(git:*)',
    'Bash(bd:*)',   // beads CLI -- required by all agents on all providers
    'Bash(gh:*)',
    `Read(${skills}/**)`,
  ];
}

// Additional permissions specific to Claude Code (not understood by other providers).
function claudeOnlyPermissions() {
  return [
    'Skill(auto-sprint)',    // suppress "Use skill 'auto-sprint'?" prompt
    'Workflow(auto-sprint)', // suppress "Run a dynamic workflow?" prompt
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
  <configDir>/skills/pm/cost.js  pure JS cost functions extracted from auto-sprint.js (all providers)
  ~/.claude/workflows/auto-sprint.js  native /auto-sprint workflow (claude only)

Agents:
  planner            reads open sprint goals, creates feature+task DAG in beads
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
  console.log(`  [1/4] skill   -> ${skillDest}`);

  // 2) agents (overwrite the eight; leave any others in place)
  ensureDir(agentsDest);
  const agents = fs.readdirSync(agentsSrc).filter(f => f.endsWith('.md'));
  for (const a of agents) {
    let content = fs.readFileSync(path.join(agentsSrc, a), 'utf-8');
    if (args.llm === 'opencode') content = transformAgentForOpenCode(content);
    fs.writeFileSync(path.join(agentsDest, a), content);
  }
  console.log(`  [2/4] agents  -> ${agentsDest} (${agents.length}: ${agents.map(a => a.replace('.md', '')).join(', ')})`);

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
    const perms = requiredPermissions(cfg);
    if (args.llm === 'claude') perms.push(...claudeOnlyPermissions());
    added = mergePermissions(settingsFile, perms);
  }
  console.log(`  [3/4] perms   -> ${settingsFile} (${added} added)`);

  // 4) cost.js -- extract the PURE_FUNCTIONS_BEGIN/END block from auto-sprint.js
  //    and write it as a self-contained CommonJS module alongside the skill files,
  //    i.e. <configDir>/skills/pm/cost.js. Co-locating it with cost.md means it is
  //    always refreshed on every install (step 1 clears and repopulates skillDest),
  //    no --force needed. The orchestrator builds the path as skillDir + '/cost.js'.
  //    The source file is never copied whole (it contains Claude Code APIs that do
  //    not exist on other providers).
  //    For Claude, also copy the full auto-sprint.js to ~/.claude/workflows/ so the
  //    native /auto-sprint slash command works.
  const workflowSrc = path.join(ROOT, '.claude', 'workflows', 'auto-sprint.js');
  if (fs.existsSync(workflowSrc)) {
    const fullSrc = fs.readFileSync(workflowSrc, 'utf-8');
    const blockStart  = fullSrc.indexOf('// PURE_FUNCTIONS_BEGIN');
    const blockEndIdx = fullSrc.indexOf('// PURE_FUNCTIONS_END');
    const blockEnd    = blockEndIdx >= 0 ? blockEndIdx + '// PURE_FUNCTIONS_END'.length : -1;
    if (blockStart < 0 || blockEnd < 0 || blockEnd <= blockStart) {
      console.error('  [!] PURE_FUNCTIONS_BEGIN/END markers not found in auto-sprint.js -- cost.js not written');
    } else {
      const block = fullSrc.slice(blockStart, blockEnd);
      const costJs = [
        '// Auto-generated by apra-pm install.mjs -- do not edit directly.',
        '// Source: .claude/workflows/auto-sprint.js (PURE_FUNCTIONS_BEGIN..END block)',
        '// Refreshed automatically on every install run.',
        '',
        block,
        '',
        '// CommonJS exports for require() in cost.md snippets and pm orchestrators.',
        'if (typeof module !== \'undefined\') {',
        '  module.exports = {',
        '    DEFAULT_CALIBRATION,',
        '    computeSprintQuote,',
        '    computeSprintAnalysis,',
        '    accumulateBucketTokens,',
        '    computeUpdatedCalibration,',
        '    buildSprintSummary,',
        '    reviewerModelFor,',
        '  };',
        '}',
      ].join('\n');

      const costDest = path.join(skillDest, 'cost.js');
      fs.writeFileSync(costDest, costJs);  // skillDest already ensured by step 1
      console.log(`  [4/4] cost.js  -> ${costDest}`);
    }

    if (args.llm === 'claude') {
      const claudeDest = path.join(HOME, '.claude', 'workflows', 'auto-sprint.js');
      ensureDir(path.dirname(claudeDest));
      fs.copyFileSync(workflowSrc, claudeDest);
      console.log(`        workflow -> ${claudeDest}  (Claude Code native)`);
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
  console.log('pm installed.');
  console.log('');
  if (args.llm === 'claude') {
    console.log('  Claude Code: /auto-sprint BD-1              (uses current branch)');
    console.log('               /auto-sprint BD-1 BD-2         (multiple sprint goals)');
    console.log('               /auto-sprint {"issues":["BD-1"],"branch":"feat/x","goal":"P1"}');
    console.log('  Other sessions: /pm  (provider-agnostic skill)');
  } else {
    console.log('  Invoke the "pm" skill to drive a sprint.');
  }
}

main();
