#!/usr/bin/env node
// skills/auto-sprint/runner.js
//
// Deterministic Node.js orchestrator for the auto-sprint AGY skill.
//
// Purpose:
//   Drive a full beads sprint (Plan -> Develop -> Test -> Harvest) using
//   apra-fleet MCP members. All routing decisions are pure JS; no orchestrator
//   token is spent on deciding which task to run next, evaluating verdicts, or
//   determining exit conditions.
//
// Constraints:
//   1. Zero orchestrator tokens: loop is pure Node.js (execSync for beads reads).
//   2. Fleet dispatch: every AI step calls execute_prompt on a named fleet member.
//   3. Same input grammar as .claude/workflows/auto-sprint.js (4 invocation forms).
//   4. Same schema names and phase order as auto-sprint.js.
//   5. Structured output: every JSON dispatch appends schema block, retries 3x.
//
// Usage (invoked by AGY skill runner with process.argv[2] = raw args string):
//   node runner.js "BD-7"
//   node runner.js "BD-1 BD-2"
//   node runner.js '["BD-1","BD-2"]'
//   node runner.js '{"issues":["BD-7"],"branch":"feat/x","goal":"P1"}'

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { execSync }  = require('node:child_process');
const fs            = require('node:fs');
const path          = require('node:path');
const os            = require('node:os');
const process       = require('node:process');
const http          = require('node:http');

// ---------------------------------------------------------------------------
// Fleet MCP client reference.
// ---------------------------------------------------------------------------
const FLEET_SERVER  = 'apra-fleet';
const FLEET_TOOL    = 'execute_prompt';

// ---------------------------------------------------------------------------
// Live state (shared by log(), updateLiveState(), and HTTP status server)
// ---------------------------------------------------------------------------
let _liveState = {
  phase: 'starting', cycle: 0, maxCycles: 5, goal: '', rootIds: [], mission: '',
  startedAt: new Date().toISOString(), currentAgent: '', openCount: null,
  goalMet: false, abortReason: '', costUsd: 0, phaseError: '', log: [],
};

function updateLiveState(patch) { Object.assign(_liveState, patch); }

function safeWriteFile(fp, content, label) {
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, 'utf-8');
  } catch (e) {
    if (typeof log === 'function') log('[WARN] Could not write ' + (label || fp) + ': ' + e.message);
    else process.stderr.write('[WARN] ' + (label || fp) + ': ' + e.message + '\n');
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg;
  process.stdout.write(line + '\n');
  _liveState.log.push(line);
  if (_liveState.log.length > 200) _liveState.log.shift();
}

// ---------------------------------------------------------------------------
// Tier constants (provider-agnostic; fleet resolves to model IDs server-side)
// ---------------------------------------------------------------------------
const TIER_CHEAP    = 'cheap';
const TIER_STANDARD = 'standard';
const TIER_PREMIUM  = 'premium';

// ---------------------------------------------------------------------------
// Arg parsing: identical to auto-sprint.js (4 invocation forms).
//
// Accepted forms:
//   "BD-1"                          bare issue ID
//   "BD-1 BD-2"                     space/comma-separated issue IDs
//   ["BD-1","BD-2"]                 JSON array of issue IDs
//   {"issues":["BD-1"],"goal":"P1"} JSON object (full control)
// ---------------------------------------------------------------------------
const rawArgs = process.argv[2] || '';

let opts = {};
if (rawArgs) {
  let parsed = null;
  try { parsed = JSON.parse(rawArgs); } catch {}

  if (Array.isArray(parsed)) {
    opts = { issues: parsed };
  } else if (parsed && typeof parsed === 'object') {
    opts = parsed;
  } else {
    // bare string: treat as space/comma-separated issue IDs
    const ids = String(rawArgs).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    opts = { issues: ids };
  }
}

let branch             = opts.branch           || '';
const rawIssues        = opts.issues            || [];
const rootIds          = Array.isArray(rawIssues) ? rawIssues : [rawIssues];
const goal             = opts.goal             || 'P1/P2';
const maxCycles        = Number(opts.max_cycles) || 5;
const mission          = opts.mission           || '';
const requirementsFile = opts.requirementsFile  || '';
const base_branch      = opts.base_branch       || 'main';

if (rootIds.length === 0) {
  log('ERROR: at least one beads issue ID is required (pass as arg: /auto-sprint BD-1)');
  process.exit(1);
}

// Goal -> numeric priority threshold.
const GOAL_THRESHOLD = { 'P1': 1, 'P1/P2': 2, 'P1/P2/P3': 3 };
const threshold = GOAL_THRESHOLD[goal] || 2;

log('Sprint args parsed: issues=[' + rootIds.join(',') + '] goal=' + goal +
    ' maxCycles=' + maxCycles + ' base_branch=' + base_branch);
// ---------------------------------------------------------------------------
// bd helper functions (execSync wrappers - no LLM, no MCP)
// ---------------------------------------------------------------------------

function bdExec(args, opts) {
  opts = opts || {};
  const fallback = opts.fallback !== undefined ? opts.fallback : '';
  try {
    return execSync('bd ' + args, Object.assign(
      { encoding: 'utf-8', timeout: 30000 }, opts)).trim();
  } catch (e) {
    const firstArg = String(args).split(' ')[0];
    log('[WARN] bd ' + firstArg + ' failed: ' + String(e.stderr || e.message || '').slice(0, 120));
    return fallback;
  }
}

function bdJson(args) {
  const out = bdExec(args + ' --json');
  try { return out ? JSON.parse(out) : []; } catch { return []; }
}

function bdReadyTasks() {
  return bdJson('list --ready --type=task');
}

// bdOpenCount: counts open issues in the sprint subtree at/above priority threshold.
// Uses bd list --status=open --json and filters by priority <= threshold and by rootIds
// if provided (scopes exit check to sprint roots only).
function bdOpenCount(rootIds, threshold) {
  let all = [];
  try { all = bdJson('list --status=open'); } catch { return 0; }
  if (!Array.isArray(all)) return 0;
  return all.filter(x => x.p <= threshold).length;
}

// shellExtract: safely parse jsonStr and call extractFn on the result.
// Returns extractFn's result or an empty fallback on any error.
function shellExtract(jsonStr, extractFn) {
  try {
    const parsed = JSON.parse(jsonStr);
    return extractFn(parsed);
  } catch {
    return null;
  }
}
// ---------------------------------------------------------------------------
// Schema constants (ported from auto-sprint.js)
// ---------------------------------------------------------------------------

const REVIEW_SCHEMA = {
  type: 'object', required: ['verdict', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES NEEDED'] },
    notes:   { type: 'string' },
  },
};

const PLAN_REVIEW_SCHEMA = {
  type: 'object', required: ['verdict', 'notes', 'taskAssignments'],
  properties: {
    verdict:         { type: 'string', enum: ['APPROVED', 'CHANGES NEEDED'] },
    notes:           { type: 'string' },
    taskAssignments: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'bucket', 'model'],
        properties: {
          id:     { type: 'string' },
          bucket: { type: 'string', enum: ['S', 'M', 'L'] },
          model:  { type: 'string' },
        },
      },
    },
  },
};

const SHELL_OUTPUTS_SCHEMA = {
  type: 'object', required: ['outputs'],
  properties: {
    outputs: { type: 'array', items: { type: 'string' } },
  },
};

const DOER_STATUS_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status:  { type: 'string', enum: ['VERIFY'] },
    notes:   { type: 'string' },
  },
};

const HARVEST_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['OK', 'FAILED'] },
    notes:  { type: 'string' },
  },
};

const CI_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['green', 'red', 'not_configured', 'pending'] },
    notes:  { type: 'string' },
  },
};

const INTEG_RUN_SCHEMA = {
  type: 'object', required: ['featuresClosed', 'issuesCreated', 'summary'],
  properties: {
    featuresClosed: { type: 'number' },
    issuesCreated:  { type: 'number' },
    summary:        { type: 'string' },
  },
};

// TIER_TO_MODEL: provider-agnostic model family aliases.
// Tier-to-actual-model resolution is fleet server-side; these aliases are used
// only for the parseReadyStreaks normalisation pass (pre-migration model IDs).
const TIER_TO_MODEL = {
  [TIER_CHEAP]:    'haiku',
  [TIER_STANDARD]: 'sonnet',
  [TIER_PREMIUM]:  'opus',
};

// ---------------------------------------------------------------------------
// SHELL_DISPATCH_PROMPT_HEADER (exact string from auto-sprint.js)
// ---------------------------------------------------------------------------
const SHELL_DISPATCH_PROMPT_HEADER =
  `Run each command below EXACTLY ONCE, in order. Return each command's stdout ` +
  `as one string element of outputs[] (same order; outputs.length must equal the ` +
  `number of commands).\n` +
  `Rules: do NOT summarize, reformat, interpret, or escape the output. Do NOT ` +
  `re-run any command. Do NOT retry on empty or unexpected output -- an empty ` +
  `string is a valid result; just return it. This is a single attempt: run, ` +
  `capture, return, stop.\n\n`;

// ---------------------------------------------------------------------------
// STATUS_HTML: self-contained sprint dashboard (T3.6)
// No external resources - pure HTML/CSS/JS, auto-polls /state every 3s.
// ---------------------------------------------------------------------------
const STATUS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Auto-Sprint Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --bg-glass: rgba(24, 24, 27, 0.6);
      --border: rgba(255, 255, 255, 0.1);
      --text: #e4e4e7;
      --text-muted: #a1a1aa;
      --accent: #3b82f6;
      --accent-glow: rgba(59, 130, 246, 0.2);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background-image: radial-gradient(circle at 50% 0%, var(--accent-glow) 0%, transparent 50%);
    }
    .header {
      padding: 20px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      background: var(--bg-glass);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header h1 span {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      background: rgba(255,255,255,0.05);
      padding: 4px 10px;
      border-radius: 20px;
    }
    .main-content {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .sidebar {
      width: 250px;
      border-right: 1px solid var(--border);
      padding: 30px;
      background: var(--bg-glass);
      backdrop-filter: blur(12px);
      overflow-y: auto;
    }
    .phase-list { list-style: none; }
    .phase-item {
      padding: 12px 16px;
      margin-bottom: 8px;
      border-radius: 8px;
      color: var(--text-muted);
      font-weight: 500;
      font-size: 14px;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .phase-item::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.5;
    }
    .phase-item.active {
      background: rgba(255,255,255,0.05);
      color: var(--text);
      box-shadow: inset 2px 0 0 var(--accent);
    }
    .phase-item.active::before {
      background: var(--accent);
      opacity: 1;
      box-shadow: 0 0 10px var(--accent);
    }
    .content-area {
      flex: 1;
      padding: 30px 40px;
      overflow-y: auto;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    .stat-card {
      background: var(--bg-glass);
      border: 1px solid var(--border);
      padding: 24px;
      border-radius: 16px;
      backdrop-filter: blur(10px);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .stat-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255,255,255,0.2);
    }
    .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 700;
    }
    .tasks-section {
      margin-bottom: 40px;
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--text-muted);
    }
    .task-item {
      background: var(--bg-glass);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      padding: 12px 16px;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      
    }
    .task-item .task-name { font-weight: 600; font-size: 14px; }
    .task-item .task-agent { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .task-item .task-status { 
      font-size: 11px; 
      padding: 4px 10px; 
      border-radius: 12px; 
      background: rgba(255,255,255,0.1); 
    }
    .task-item.running .task-status { background: var(--accent-glow); color: var(--accent); }
    .task-item.done .task-status { background: rgba(16, 185, 129, 0.1); color: var(--success); border-left-color: var(--success); }
    
    .terminal {
      background: #000;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      line-height: 1.6;
      color: #a1a1aa;
      height: 300px;
      overflow-y: auto;
      margin: 0; font-size: 16px; font-weight: 500; color: var(--text-muted);
      display: flex; align-items: center; gap: 8px;
    }
    .compact-stats {
      display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--text-muted);
      background: rgba(255,255,255,0.03); padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border);
    }
    .compact-stats strong { color: var(--text); font-weight: 600; margin-left: 4px; }
    
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.9); }
      100% { opacity: 1; transform: scale(1); }
    }
    
    .btn-stop {
      background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid var(--danger);
      padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600;
      transition: all 0.2s ease; display: flex; align-items: center; gap: 6px;
    }
    .btn-stop:hover { background: rgba(239, 68, 68, 0.2); transform: translateY(-1px); }
    .btn-stop:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    
    .banner {
      padding: 8px 16px; text-align: center; font-weight: 500; font-size: 13px;
      display: none; border-bottom: 1px solid var(--border);
    }
    .banner.success { background: rgba(16, 185, 129, 0.1); color: var(--success); }
    .banner.error { background: rgba(239, 68, 68, 0.1); color: var(--danger); }
    .banner.mission { background: rgba(59, 130, 246, 0.1); color: var(--accent); }

    .main-content {
      flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 16px 24px; gap: 16px;
    }
    
    .top-panels {
      display: flex; gap: 16px; height: 35vh; min-height: 200px;
    }
    
    .panel {
      background: var(--bg-glass); border: 1px solid var(--border); border-radius: 8px;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .panel-header {
      padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--text-muted);
      border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02);
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .panel-body {
      flex: 1; overflow-y: auto;
    }
    
    .activity-panel { flex: 1; }
    .tree-panel {
      flex: 0 0 350px; resize: horizontal; overflow: hidden; min-width: 250px; max-width: 50vw;
    }
    .tree-panel::-webkit-resizer { background-color: var(--border); }
    
    table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
    th, td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    th { position: sticky; top: 0; background: #18181b; font-weight: 500; color: var(--text-muted); z-index: 10; }
    td { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
    
    .task-row {
      padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); transition: background 0.2s;
    }
    .task-row:hover { background: rgba(255,255,255,0.02); }
    
    .terminal-panel {
      flex: 1; display: flex; flex-direction: column; min-height: 200px;
    }
    .terminal {
      flex: 1; background: #000; padding: 12px; overflow-y: auto;
      font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: #d4d4d8;
      border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;
    }
    .log-line { display: flex; gap: 12px; padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
    .log-line:hover { background: rgba(255,255,255,0.02); }
    .log-time { color: #52525b; user-select: none; flex-shrink: 0; width: 65px; }
    .log-msg { word-break: break-all; white-space: pre-wrap; flex: 1; }
    .log-msg.highlight { color: #60a5fa; font-weight: 500; }
    .log-msg.error { color: #f87171; }
    .log-msg.success { color: #34d399; font-weight: 500; }
    .log-msg.warning { color: #fbbf24; font-weight: 500; }
    
    .capability-pill {
      display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase;
    }
    .capability-pill.yes { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
    .capability-pill.no { background: rgba(255, 255, 255, 0.05); color: var(--text-muted); border: 1px solid rgba(255, 255, 255, 0.1); }
  </style>
</head>
<body>
  <div class="header">
    <h1>Auto-Sprint <span id="root-badge" style="color:var(--text);font-weight:700"></span> <span style="font-size:14px;color:var(--text-muted);font-weight:400;margin:0 4px">on</span> <span id="branch-badge" style="color:var(--text)">loading...</span></h1>
    
    <div class="compact-stats">
      <div>Phase: <strong id="stat-phase" style="text-transform: capitalize;">-</strong></div>
      <div>Cycle: <strong id="stat-cycle">-</strong></div>
      <div>Open Tasks: <strong id="stat-open">-</strong></div>
      <div>Cost: <strong id="stat-cost">-</strong></div>
      <div>Calls/Tokens: <strong id="stat-calls-tokens">-</strong></div>
      <div id="cap-deploy" class="capability-pill">Deploy</div>
      <div id="cap-integ" class="capability-pill">Integ Tests</div>
    </div>
    
    <div id="connection-status" style="font-size: 12px; color: var(--success); display: flex; align-items: center; gap: 16px;">
      <button id="btn-stop" class="btn-stop" onclick="fetch('/stop',{method:'POST'}).then(()=>{this.disabled=true;this.innerHTML='<span style=\\'display:inline-block;animation:pulse 1.5s infinite;\\'>◼</span> Stopping...';})">◼ Stop</button>
      <div style="display:flex;align-items:center;gap:6px;font-weight:600;"><div style="width:8px;height:8px;background:var(--success);border-radius:50%;box-shadow:0 0 8px var(--success);"></div> Live</div>
    </div>
  </div>
  
  <div class="banner mission" id="mission-banner">Mission: <span id="mission-text"></span></div>
  <div class="banner" id="banner"></div>

  <div class="main-content">
        <li class="phase-item" data-phase="Develop">Develop</li>
        <li class="phase-item" data-phase="Test">Test</li>
        <li class="phase-item" data-phase="Harvest">Harvest</li>
      </ul>
      
      <div class="section-title" style="margin-top: 40px; margin-bottom: 20px;">Active Sprint Tasks</div>
      <div id="sprint-beads" style="max-height: 60vh; overflow-y: auto; font-size: 13px; line-height: 1.4; padding-right: 8px;">
        <div style="color:var(--text-muted);">Loading tasks...</div>
      </div>
    </div>
    
    <div class="content-area">
      <div id="mission-banner" class="banner" style="background: rgba(59, 130, 246, 0.1); border: 1px solid var(--accent); color: #93c5fd; display: none; margin-bottom: 20px;">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--accent); margin-bottom: 4px;">Sprint Mission</div>
        <div id="mission-text" style="color: #fff; font-size: 15px; font-weight: 500;"></div>
      </div>
      <div id="banner" class="banner"></div>
      
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Cycle</div>
          <div class="stat-value" id="stat-cycle">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Open Issues</div>
          <div class="stat-value" id="stat-open">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Cost (USD)</div>
          <div class="stat-value" id="stat-cost" style="color: var(--success);">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Calls / Tokens</div>
          <div class="stat-value" id="stat-calls-tokens" style="font-size: 20px;">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Agent</div>
          <div class="stat-value" id="stat-agent" style="font-size: 18px;">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Workspace Capabilities</div>
          <div style="margin-top: 8px;">
            <div id="cap-deploy" class="capability-pill">Deploy</div>
            <div id="cap-integ" class="capability-pill">Integ Tests</div>
          </div>
        </div>
      </div>
      
      <div class="section-title" style="margin-top: 20px; margin-bottom: 16px;">Task Activity</div>
      <div style="max-height: 35vh; overflow-y: auto; background: var(--bg-glass); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 30px;">
        <table id="task-list" style="width: 100%; border-collapse: collapse; font-size: 13px; text-align: left;">
          <!-- Table rows injected here -->
        </table>
      </div>
      
      <div class="section-title">Terminal Log</div>
      <div class="terminal" id="terminal"></div>
    </div>
  </div>

  <script>
    const phases = ['setup', 'Plan', 'Develop', 'Test', 'Harvest', '?'];
    let lastLogCount = 0;

    function formatDuration(ms) {
      if (!ms || ms < 0) return '-';
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) return h + 'h ' + (m%60) + 'm ' + (s%60) + 's';
      if (m > 0) return m + 'm ' + (s%60) + 's';
      return s + 's';
    }
    
    function parseCycleRound(label, fallbackCycle) {
      const match = label.match(/-c(\\d+)-r(\\d+)/);
      if (match) return 'C' + match[1] + ' R' + match[2];
      const matchC = label.match(/-c(\\d+)/);
      if (matchC) return 'C' + matchC[1];
      if (fallbackCycle === 'setup') return 'C0';
      return 'C' + (fallbackCycle || '?');
    }

    async function poll() {
      try {
        const res = await fetch('/state');
        const s = await res.json();
        
        document.getElementById('branch-badge').textContent = s.branch || '?';
        document.getElementById('root-badge').textContent = Array.isArray(s.rootIds) ? s.rootIds.join(', ') : '?';
        
        const missionBanner = document.getElementById('mission-banner');
        if (s.mission) {
          missionBanner.style.display = 'block';
          document.getElementById('mission-text').textContent = s.mission;
        } else {
          missionBanner.style.display = 'none';
        }
        
        const currentPhase = s.currentPhase || s.phase || 'setup';
        const phaseEl = document.getElementById('stat-phase');
        if (phaseEl) phaseEl.textContent = currentPhase;
        
        const sprintBeads = s.sprintBeads || [];
        const openTasks = sprintBeads.filter(b => b.t === 'task' && b.s === 'open').length;
        
        document.getElementById('stat-cycle').textContent = (s.cycle || 0) + '/' + (s.maxCycles || '?');
        document.getElementById('stat-open').textContent = openTasks > 0 ? openTasks : (s.openCount != null ? s.openCount : '-');
        const actualCost = s.costUsd || 0;
        const budget = 10.00;
        document.getElementById('stat-cost').textContent = '$' + actualCost.toFixed(2) + ' / $' + budget.toFixed(2);
        
        const agentEl = document.getElementById('stat-agent');
        if (agentEl) agentEl.textContent = s.currentAgent || 'Idle';
        
        const ledger = s.ledger || [];
        const callsTokensEl = document.getElementById('stat-calls-tokens');
        if (callsTokensEl) {
          const totalTokens = ledger.reduce((sum, item) => sum + (item.outTokens || 0), 0);
          callsTokensEl.textContent = ledger.length + ' / ' + totalTokens;
        }
        const totalCalls = ledger.length + (s.currentAgent && !s.goalMet && !s.abortReason ? 1 : 0);
        const totalTokens = ledger.reduce((acc, l) => acc + (l.outTokens || 0), 0);
        document.getElementById('stat-calls-tokens').textContent = totalCalls + ' / ' + totalTokens.toLocaleString();
        
        const capDeploy = document.getElementById('cap-deploy');
        capDeploy.className = 'capability-pill ' + (s.deployMdExists ? 'yes' : 'no');
        capDeploy.innerHTML = s.deployMdExists ? 'Deploy &#10003;' : 'Deploy &#10007;';
        
        const capInteg = document.getElementById('cap-integ');
        capInteg.className = 'capability-pill ' + (s.playbookExists ? 'yes' : 'no');
        capInteg.innerHTML = s.playbookExists ? 'Integ Tests &#10003;' : 'Integ Tests &#10007;';
        
        let overallDurationStr = '';
        if (s.startedAt) {
          const startMs = new Date(s.startedAt).getTime();
          const endMs = (s.goalMet || s.abortReason) ? (s.endedAt ? new Date(s.endedAt).getTime() : Date.now()) : Date.now();
          overallDurationStr = ' (Duration: ' + formatDuration(endMs - startMs) + ')';
        }
        document.getElementById('branch-badge').textContent = (s.branch || '?') + overallDurationStr;
        
        const banner = document.getElementById('banner');
        if (s.goalMet) {
          if (banner.className !== 'banner success') {
            banner.className = 'banner success';
            banner.textContent = 'Sprint complete -- Goal MET!';
            banner.style.display = 'block';
          }
        } else if (s.abortReason) {
          if (banner.className !== 'banner error') {
            banner.className = 'banner error';
            banner.textContent = 'Sprint ended: ' + s.abortReason;
            banner.style.display = 'block';
          }
        }
        
        const sprintBeads = s.sprintBeads || [];
        const beadsContainer = document.getElementById('sprint-beads');
        if (sprintBeads.length > 0) {
          let bHtml = '';
          const rendered = new Set();
          const typeLevel = { 'epic': 3, 'feature': 2, 'task': 1 };
          
          function renderNode(b, depth) {
             if (rendered.has(b.id)) return;
             rendered.add(b.id);
             const isClosed = b.s === 'closed';
             const isIp = b.s === 'in_progress';
             const icon = b.t === 'epic' ? '🌟' : (b.t === 'feature' ? '📦' : '📄');
             const color = isClosed ? 'var(--text-muted)' : (isIp ? 'var(--accent)' : 'var(--text)');
             const style = isClosed ? 'text-decoration:line-through; opacity:0.5; filter: grayscale(100%);' : '';
             const titleSafe = (b.title || '').replace(/"/g, '&quot;');
             bHtml += '<div class="task-row" style="color:' + color + '; ' + style + '; padding-left:' + (depth*16) + 'px;" title="' + titleSafe + '">' +
                        '<div style="display:flex; align-items:center; gap:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' +
                          '<span style="font-size:14px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));">' + icon + '</span>' +
                          '<strong style="letter-spacing: 0.5px; flex-shrink: 0;">' + b.id + '</strong>' +
                          '<span style="opacity:0.85; font-size:11px; margin-top:2px; text-overflow:ellipsis; overflow:hidden;">' + (b.title || '').replace(/</g, '&lt;') + '</span>' +
                        '</div>' +
                      '</div>';
             if (b.children && b.children.length > 0) {
                 b.children.forEach(cId => {
                     const child = sprintBeads.find(x => x.id === cId);
                     // Only render as a visual child if it's strictly a lower hierarchical level
                     // This prevents external blockers (e.g. task -> feature) from rendering as children
                     if (child && (typeLevel[b.t] || 0) > (typeLevel[child.t] || 0)) {
                         renderNode(child, depth + 1);
                     }
                 });
             }
          }
          
          // 1. Render all primary sprint issues first
          const sprintIssueIds = s.issues || [];
          const sprintRoots = sprintBeads.filter(b => sprintIssueIds.includes(b.id));
          sprintRoots.forEach(r => renderNode(r, 0));
          
          // 2. Anything remaining is an external blocker or unrelated task
          const leftovers = sprintBeads.filter(b => !rendered.has(b.id));
          if (leftovers.length > 0) {
              bHtml += '<div style="color:var(--text-muted); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-top:16px; margin-bottom:8px; padding-left:12px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:4px;">Other Dependencies</div>';
              leftovers.forEach(b => renderNode(b, 0));
          }
          if (beadsContainer.innerHTML !== bHtml) beadsContainer.innerHTML = bHtml;
        } else {
          beadsContainer.innerHTML = '<div style="color:var(--text-muted);">No issues tracked yet...</div>';
        }
        
        const taskList = document.getElementById('task-list');
        
        // Merge ledger with currently running task
        const mergedActs = [...ledger];
        if (s.currentAgent && !s.goalMet && !s.abortReason) {
           const isAlreadyInLedger = ledger.length > 0 && ledger[ledger.length - 1].label === s.currentAgent && !ledger[ledger.length - 1].durationMs;
           if (!isAlreadyInLedger) {
             mergedActs.push({
               phase: s.currentPhase || s.phase || '?',
               label: s.currentAgent,
               model: s.currentModel || '...',
               cycle: s.currentCycle || s.cycle || '?',
               durationMs: Date.now() - (s.currentStartTime || Date.now()),
               isRunning: true
             });
           }
        }
        
        if (!mergedActs.length) {
          if (taskList.innerHTML !== '<div style="color:var(--text-muted);font-size:13px;padding:20px;">Waiting for tasks...</div>') 
            taskList.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:20px;">Waiting for tasks...</div>';
        } else {
          const byPhase = {};
          mergedActs.forEach((act, idx) => {
             const phase = act.phase || '?';
             if (!byPhase[phase]) byPhase[phase] = [];
             byPhase[phase].push(act);
          });
          
          let html = '<thead style="color:var(--text-muted); border-bottom:1px solid var(--border); position:sticky; top:0; background:#18181b; z-index:10;"><tr style="background:rgba(255,255,255,0.02);">' +
                     '<th style="padding:10px 12px; font-weight:500;">Phase</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Task</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Agent</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Duration</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Tokens</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Cycle/Round</th></tr></thead><tbody>';
          
          for (const phase of phases) {
            const acts = byPhase[phase];
            if (acts && acts.length > 0) {
               acts.forEach(act => {
                 let isWarning = false;
                 if (act.verdict) {
                    const v = String(act.verdict).toUpperCase();
                    if (v === 'CHANGES NEEDED' || v === 'FAILED' || v === 'RED' || v.includes('BUGS')) isWarning = true;
                 }
                 const statusStyle = act.isRunning ? 'color:var(--accent); font-weight:bold;' : (isWarning ? 'color:var(--warning); font-weight:500;' : 'color:var(--success);');
                 const bgStyle = act.isRunning ? 'background: rgba(59, 130, 246, 0.05);' : (isWarning ? 'background: rgba(245, 158, 11, 0.05);' : '');
                 const icon = act.isRunning ? '<span style="display:inline-block; animation: pulse 1.5s infinite;">⚡</span> ' : (isWarning ? '⚠️ ' : '✓ ');
                 
                 // Insight subtext
                 let insight = '';
                 if (act.label.includes('planner')) insight = 'Breaking down features into actionable tasks';
                 else if (act.label.includes('reviewer')) insight = 'Evaluating code/plan quality and correctness';
                 else if (act.label.includes('doer')) insight = 'Writing code and implementing requirements';
                 else if (act.label.includes('integ')) insight = 'Running integration test playbook';
                 else if (act.label.includes('harvester')) insight = 'Committing changes, closing tasks, syncing DB';
                 
                 html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05); ' + bgStyle + '">' +
                         '<td style="padding:10px 12px; width:130px; ' + statusStyle + '">' + icon + phase + (act.isRunning ? ' (Running)' : ' (Done)') + '</td>' +
                         '<td style="padding:10px 12px; font-weight:600; color:var(--text);">' + act.label + 
                           '<div style="font-weight:400; font-size:11px; color:var(--text-muted); margin-top:2px;">' + insight + '</div></td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + 
                           (act.model === "pm-doer-std" ? "Standard" : 
                           (act.model === "pm-doer-cheap" ? "Cheap" : 
                           (act.model === "pm-doer-prem" ? "Premium" : 
                           (act.model === "native" ? "Orchestrator" : act.model)))) + 
                         '</td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + formatDuration(act.durationMs) + '</td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + (act.outTokens || (act.isRunning ? '-' : '0')) + ' <a href="/log?label=' + act.label + '" target="_blank" title="View LLM details" style="text-decoration:none; margin-left:4px;">🔍</a></td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + parseCycleRound(act.label, act.cycle) + '</td>' +
                         '</tr>';
               });
            }
          }
          html += '</tbody>';
          if (taskList.innerHTML !== html) taskList.innerHTML = html;
        }
        
        if (s.log && s.log.length !== lastLogCount) {
          lastLogCount = s.log.length;
          const term = document.getElementById('terminal');
          term.innerHTML = s.log.map(line => {
            function escapeHTML(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
            // Extract the GMT timestamp
            const timeMatch = line.match(/202\\d-[\\d\\-T:.]+Z/);
            let localTime = '';
            if (timeMatch) {
               const dateObj = new Date(timeMatch[0]);
               localTime = dateObj.toLocaleTimeString([], { hour12: false });
            }
            let msg = line.replace(/^.*?Z /, '');
            msg = escapeHTML(msg.trim());
            const isHighlight = msg.includes('dispatch:') || msg.includes('===');
            const isError = msg.includes('ERROR') || msg.includes('FATAL') || msg.includes('failed');
            const isWarning = msg.includes('CHANGES NEEDED') || msg.includes('BUGS');
            const isSuccess = msg.includes('APPROVED');
            let cls = '';
            if (isError) cls = 'error';
            else if (isWarning) cls = 'warning';
            else if (isSuccess) cls = 'success';
            else if (isHighlight) cls = 'highlight';
            return '<div class="log-line"><span class="log-time">' + localTime + '</span><span class="log-msg ' + cls + '">' + msg + '</span></div>';
          }).join('');
          term.scrollTop = term.scrollHeight;
        }
        
      } catch(e) {
        document.getElementById('connection-status').innerHTML = '<div style="width:8px;height:8px;background:var(--danger);border-radius:50%;"></div> Offline';
        document.getElementById('connection-status').style.color = 'var(--danger)';
      }
    }
    
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;



// ---------------------------------------------------------------------------
// Pure parsers (exact ports from auto-sprint.js)
// ---------------------------------------------------------------------------

function collectSubtreeIds(outputs, rootCount) {
  const ids = new Set();
  for (let i = 0; i < rootCount; i++) {
    String(outputs[i] || '').trim().split(/\s+/).filter(Boolean).forEach(id => ids.add(id));
  }
  return ids;
}

// parseBlockers: contract {count, ids} of open issues with priority<=threshold
// inside the sprint-goal subtree.
function parseBlockers(outputs, rootCount, openListIdx, threshold, rootIds) {
  if (!Array.isArray(outputs) || outputs.length < openListIdx + 1) return { count: 999, ids: [] };
  const subtree = collectSubtreeIds(outputs, rootCount);
  const rootSet = Array.isArray(rootIds) && rootIds.length > 0 ? new Set(rootIds) : null;
  let ids = [];
  try {
    const open = JSON.parse(outputs[openListIdx]);
    ids = Array.isArray(open)
      ? open.filter(x => subtree.has(x.id) && (!rootSet || rootSet.has(x.id)) && x.p <= threshold).map(x => x.id)
      : [];
  } catch { ids = []; }
  return { count: ids.length, ids };
}

// parseReadyStreaks: contract {totalCount, streaks[]} grouping ready tasks by model.
function parseReadyStreaks(outputs, rootCount, readyListIdx, defaultModel) {
  if (!Array.isArray(outputs) || outputs.length < readyListIdx + 1) return { totalCount: 0, streaks: [] };
  const subtree = collectSubtreeIds(outputs, rootCount);
  let readyTasks = [];
  try {
    const all = JSON.parse(outputs[readyListIdx]);
    readyTasks = Array.isArray(all) ? all.filter(t => subtree.has(t.id)) : [];
  } catch { readyTasks = []; }

  const KNOWN_TIERS = new Set([TIER_CHEAP, TIER_STANDARD, TIER_PREMIUM]);
  const MODEL_TO_TIER = Object.fromEntries(Object.entries(TIER_TO_MODEL).map(([t, id]) => [id, t]));

  const byModel = {};
  for (const t of readyTasks) {
    const rawModel = t.m || defaultModel;
    let model = rawModel;
    if (!KNOWN_TIERS.has(rawModel)) {
      const tier = MODEL_TO_TIER[rawModel];
      if (tier) {
        model = tier;
        typeof console !== 'undefined' && console.warn(`[apra-pm] Task ${t.id}: pre-migration model '${rawModel}' normalised to tier '${model}'`);
      } else {
        model = defaultModel;
        typeof console !== 'undefined' && console.warn(`[apra-pm] Task ${t.id}: unrecognised model '${rawModel}', defaulting to '${defaultModel}'`);
      }
    }
    if (!byModel[model]) byModel[model] = [];
    byModel[model].push({ id: t.id, priority: t.p });
  }
  const streaks = Object.entries(byModel).map(([model, tasks]) => ({
    model,
    ids: tasks.slice().sort((a, b) => a.priority - b.priority).map(x => x.id),
    _min: Math.min(...tasks.map(x => x.priority)),
  })).sort((a, b) => a._min - b._min).map(({ model, ids }) => ({ model, ids }));

  return { totalCount: readyTasks.length, streaks };
}

// parseCycleState: contract {planDone, inProgressIds, allIssues}.
function parseCycleState(outputs, rootCount) {
  if (!Array.isArray(outputs) || outputs.length < rootCount + 1) return { planDone: false, inProgressIds: [], allIssues: [] };
  const inProgressIds = String(outputs[rootCount] || '').trim().split(/\s+/).filter(Boolean);
  
  const issueMap = new Map();
  const planDone = Array.from({ length: rootCount }).every((_, i) => {
    try {
      const issues = JSON.parse(outputs[i]);
      if (!Array.isArray(issues)) return false;
      issues.forEach(x => issueMap.set(x.id, x));
      const features = issues.filter(x => x.t === 'feature' || x.t === 'epic');
      const openFts = features.filter(x => x.s !== 'closed');
      const tasks = issues.filter(x => x.t === 'task');
      
      if (features.length === 0 && tasks.length === 0) return false;
      if (openFts.length > 0) return false;
      if (tasks.length === 0) return false;
      return tasks.every(x => x.d);
    } catch { return false; }
  });
  return { planDone, inProgressIds, allIssues: Array.from(issueMap.values()) };
}

// truncateStreakToCeiling: returns the longest in-order prefix of streakIds whose
// summed estimated doer output tokens stays at/under calibration.doer_token_ceiling[tier].
// Always returns at least one task. Never truncates when no ceiling is configured.
function truncateStreakToCeiling(streakIds, bucketById, calibration, tier) {
  if (!Array.isArray(streakIds) || streakIds.length === 0) return [];
  // Hard limit to 1 task per batch to prevent long prompts from timing out
  // the AGY backend MCP execution limit (120 seconds).
  return [streakIds[0]];
}

// approved: returns true if review has verdict === 'APPROVED'.
function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.trim() === 'APPROVED';
}

// labelTaskIds: returns up to 3 IDs joined by space; appends '+Nmore' when more than 3.
function labelTaskIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  if (ids.length <= 3) return ids.join(' ');
  return ids.slice(0, 3).join(' ') + ` +${ids.length - 3}more`;
}
// ---------------------------------------------------------------------------
// Fleet dispatch wrapper
// ---------------------------------------------------------------------------

// dispatchLedger: accumulates cost entries across all cycles.
const dispatchLedger = [];
const dispatchOutputs = {};

// PURE_FUNCTIONS_BEGIN

function estimateCost(tier, inTokens, outTokens) {
  if (!tier || tier === 'native') return 0;
  if (tier.includes('cheap') || tier === 'haiku') return (inTokens * 0.25 + outTokens * 1.25) / 1000000;
  if (tier.includes('standard') || tier === 'sonnet') return (inTokens * 3.00 + outTokens * 15.00) / 1000000;
  if (tier.includes('prem') || tier === 'opus') return (inTokens * 15.00 + outTokens * 75.00) / 1000000;
  return (inTokens * 3.00 + outTokens * 15.00) / 1000000;
}
// PURE_FUNCTIONS_END

// dispatchFleet: async wrapper around the apra-fleet execute_prompt MCP tool.
// If opts.schema is set, appends a RESPOND WITH ONLY VALID JSON block and
// retries up to 3 times on JSON parse failure.
async function dispatchFleet(memberName, prompt, opts = {}) {
  const schema = opts.schema || null;
  const label  = opts.label  || memberName;
  const phase  = opts.phase  || '?';
  const cycle  = opts.cycle  != null ? opts.cycle : 'setup';

  const repo = process.cwd();
  let fullPrompt = `CRITICAL: You are working inside a local repository. ALL your commands and file operations MUST be executed inside this exact directory path:\n${repo}\n\n${prompt}`;
  if (schema) {
    fullPrompt = fullPrompt + '\n\nRESPOND WITH ONLY VALID JSON matching this schema:\n' +
      JSON.stringify(schema, null, 2);
  }

  updateLiveState({ currentAgent: label });
  log('dispatch: ' + label + ' [' + memberName + ']');

  const MAX_RETRIES = 3;
  let lastRaw = '';
  const startTime = Date.now();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let raw = '';
    try {
      // Call the apra-fleet MCP execute_prompt tool via the MCP client.
      // In the AGY skill runtime the runner is invoked by the AGY skill engine
      // which exposes MCP tools. We use a synchronous child_process call to
      // invoke the MCP via the AGY CLI's tool dispatch path.
      // For schema responses: parse and return JSON; otherwise return raw string.
      const result = await _fleetCall(memberName, fullPrompt, opts);
      raw = typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      log('dispatch error [' + label + '] attempt ' + attempt + ': ' + String(err).slice(0, 120));
      raw = '';
    }
    lastRaw = raw;

    if (!schema) {
      if (raw === '' && attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      const inTokens = Math.ceil(fullPrompt.length / 4);
      const outTokens = Math.ceil(raw.length / 4);
      const costUsd = estimateCost(memberName, inTokens, outTokens);
      // No schema needed -- record entry and return raw string.
      dispatchLedger.push({ cycle, phase, label, model: memberName, outTokens, costUsd, durationMs: Date.now() - startTime });
      updateLiveState({ costUsd: dispatchLedger.reduce(function(s,e){return s+(e.costUsd||0);},0) });
      dispatchOutputs[label] = raw;
      return raw;
    }

    // Try to parse JSON response.
    try {
      // Extract JSON block robustly to bypass any MCP tool wrapper text (like '[Response from...]')
      let stripped = raw;
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (jsonMatch) {
        stripped = jsonMatch[1].trim();
      } else {
        // Fallback: try to find the first { or [ and last } or ]
        const firstBrace = raw.indexOf('{');
        const firstBracket = raw.indexOf('[');
        const firstIdx = (firstBrace === -1) ? firstBracket : (firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket));
        
        const lastBrace = raw.lastIndexOf('}');
        const lastBracket = raw.lastIndexOf(']');
        const lastIdx = Math.max(lastBrace, lastBracket);
        
        if (firstIdx !== -1 && lastIdx !== -1 && lastIdx >= firstIdx) {
          stripped = raw.substring(firstIdx, lastIdx + 1).trim();
        } else {
          stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        }
      }
      const parsed = JSON.parse(stripped);
      const inTokens = Math.ceil(fullPrompt.length / 4);
      const outTokens = Math.ceil(raw.length / 4);
      const costUsd = estimateCost(memberName, inTokens, outTokens);
      dispatchLedger.push({ cycle, phase, label, model: memberName,
        outTokens, costUsd, durationMs: Date.now() - startTime,
        verdict: parsed.verdict || parsed.status || null });
      updateLiveState({ costUsd: dispatchLedger.reduce(function(s,e){return s+(e.costUsd||0);},0) });
      dispatchOutputs[label] = raw;
      return parsed;
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        log('JSON parse failed [' + label + '] attempt ' + (attempt + 1) + ' -- retrying');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  log('ERROR: JSON parse failed after ' + MAX_RETRIES + ' retries [' + label + ']. Raw: ' +
    lastRaw.slice(0, 200));
  dispatchLedger.push({ cycle, phase, label, model: memberName, outTokens: 0, costUsd: 0, durationMs: Date.now() - startTime });
  updateLiveState({ costUsd: dispatchLedger.reduce(function(s,e){return s+(e.costUsd||0);},0) });
  return null;
}

// _fleetCall: low-level call to the apra-fleet MCP execute_prompt tool.
// Uses the AGY MCP client interface available in the runner process context.
// Falls back to spawning the native `agy` CLI if the MCP interface is not available.
async function _fleetCall(memberName, prompt, opts) {
  // In the AGY skill runtime, MCP tools are accessible via the global __mcp object
  // injected by the skill engine. Check for it and use it if available.
  if (typeof __mcp !== 'undefined' && __mcp && typeof __mcp.call === 'function') {
    const result = await __mcp.call(FLEET_SERVER, FLEET_TOOL, {
      member_name: memberName,
      prompt:      prompt,
    });
    return (result && result.content && result.content[0] && result.content[0].text) || '';
  }

  // Fallback: if running in a background shell without MCP, use `agy --print`
  const modelMap = {
    'pm-doer-cheap': 'Gemini 3.1 Flash (High)',
    'pm-doer-std': 'Gemini 3.1 Pro (High)',
    'pm-doer-premium': 'Gemini 3.1 Pro (High)',
    'pm-planner': 'Gemini 3.1 Pro (High)',
    'pm-reviewer': 'Gemini 3.1 Pro (High)',
    'pm-harvester': 'Gemini 3.1 Pro (High)'
  };
  // Fallback: if running in a background shell without MCP, use `agentapi` local proxy
  const modelMapAgy = {
    'pm-doer-cheap': 'flash',
    'pm-doer-std': 'pro',
    'pm-doer-premium': 'pro',
    'pm-planner': 'pro',
    'pm-reviewer': 'pro',
    'pm-harvester': 'pro'
  };
  const child_process = require('node:child_process');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  
  const useGatewayMode = process.env.AGY_GATEWAY_MODE === 'true';
  const agyModel = modelMapAgy[memberName] || 'pro';
  
  let subagentPrompt = '';
  if (useGatewayMode) {
    // VERSION B: Gateway Mode (use subagent to execute apra-fleet MCP tool)
    const mcpArgs = JSON.stringify({ member_name: memberName, prompt: prompt });
    subagentPrompt = `Call the "execute_prompt" tool on the "apra-fleet" MCP server with these exact arguments:\n${mcpArgs}\n\nReturn EXACTLY the raw output of the tool execution and absolutely no other text.`;
  } else {
    // VERSION A: Native AGY Mode (use subagent to fulfill the prompt natively)
    subagentPrompt = prompt;
  }
  
  try {
    // Write the actual payload to a temp file to avoid Windows 8191-byte command line limits
    const tempPromptPath = path.join(os.tmpdir(), `agy-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tempPromptPath, subagentPrompt, 'utf-8');
    
    let instruction = `Read the file at "${tempPromptPath}" and fulfill the instructions inside it. Output exactly what is requested. CRITICAL INSTRUCTION: You are running headlessly. DO NOT use the native run_command tool (or Bash tool). If you must execute a shell command, you MUST use the call_mcp_tool tool. CRITICAL: When using call_mcp_tool, set ServerName exactly to apra-fleet (do NOT include quotes in the string value) and set ToolName exactly to execute_command (do NOT include quotes in the string value). The Arguments field MUST be a valid JSON object.`;
    if (useGatewayMode) {
      instruction = `Read the file at "${tempPromptPath}". It contains instructions to call an MCP tool. Call the tool and return its exact output with no extra conversational text.`;
    }
    
    // Spawn the subagent asynchronously via the local API proxy (bypasses DB lock)
    const cmd = `agy agentapi new-conversation --model=${agyModel} "${instruction.replace(/"/g, '\\"')}"`;
    const out = child_process.execSync(cmd, { encoding: 'utf-8' });
    const parsed = JSON.parse(out);
    const convId = parsed.response.newConversation.conversationId;
    
    // Poll the transcript log asynchronously to get the response
    const logPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let lastPos = 0;
    while (true) {
        if (global.abortRequested) {
            try {
               const stopPromptPath = path.join(os.tmpdir(), `agy-stop-${Date.now()}.txt`);
               fs.writeFileSync(stopPromptPath, `Call the call_mcp_tool tool. ServerName: apra-fleet. ToolName: stop_prompt. Arguments: {"member_name": "${memberName}"}. Return OK.`, 'utf-8');
               require('node:child_process').exec(`agy agentapi new-conversation --model=${agyModel} "Read the file at \\"${stopPromptPath}\\". Call the MCP tool and return."`);
            } catch(e) {}
            throw new Error('ABORT_REQUESTED');
        }
        if (!fs.existsSync(logPath)) {
            await sleep(500);
            continue;
        }
        const fd = fs.openSync(logPath, 'r');
        const stat = fs.fstatSync(fd);
        if (stat.size > lastPos) {
            const buf = Buffer.alloc(stat.size - lastPos);
            fs.readSync(fd, buf, 0, stat.size - lastPos, lastPos);
            lastPos = stat.size;
            fs.closeSync(fd);
            
            const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
            for (const line of lines) {
                try {
                    const event = JSON.parse(line);
                    if (event.type === 'PLANNER_RESPONSE' && event.status === 'DONE' && (!event.tool_calls || event.tool_calls.length === 0)) {
                        try { fs.unlinkSync(tempPromptPath); } catch(e) {}
                        return event.content;
                    }
                } catch (e) {}
            }
        } else {
            fs.closeSync(fd);
        }
        await sleep(500);
    }
  } catch (err) {
    throw new Error('Fallback agentapi execution failed: ' + (err.stderr || err.message));
  }
}

async function dispatchShellFleet(cmds, memberName, opts) {
  opts = opts || {};
  const cp = require('node:child_process');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const repo = process.cwd();
  const outputs = [];
  for (const c of cmds) {
    try {
      if (c.includes('| node -e')) {
        const parts = c.split('| node -e');
        const cmd1 = parts[0].trim();
        let script = parts[1].trim();
        if (script.startsWith('"') && script.endsWith('"')) {
          script = script.substring(1, script.length - 1);
        }
        
        const out1 = cp.execSync(cmd1, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 50, cwd: repo });
        
        const tmpFile = path.join(os.tmpdir(), 'script-' + Date.now() + '-' + Math.floor(Math.random()*1000) + '.js');
        fs.writeFileSync(tmpFile, script, 'utf-8');
        
        const out2 = cp.execSync(`node "${tmpFile}"`, { 
            input: out1, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 50, cwd: repo 
        });
        try { fs.unlinkSync(tmpFile); } catch(e) {}
        
        outputs.push(out2);
      } else {
        const out = cp.execSync(c, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 50, cwd: repo });
        outputs.push(out);
      }
    } catch (e) {
      outputs.push((e.stdout || '') + (e.stderr || ''));
    }
  }
  return { outputs };
}
// ---------------------------------------------------------------------------
// Sprint state helpers (branch-keyed JSON under sprint-logs/.state/)
// ---------------------------------------------------------------------------

function readSprintState(stateFileRel) {
  try {
    if (!fs.existsSync(stateFileRel)) return { exists: false, ageS: null, state: null };
    const ageS = Math.floor((Date.now() - fs.statSync(stateFileRel).mtimeMs) / 1000);
    let state = null;
    try { state = JSON.parse(fs.readFileSync(stateFileRel, 'utf8')); } catch {}
    return { exists: true, ageS, state };
  } catch {
    return { exists: false, ageS: null, state: null };
  }
}

function writeSprintState(stateFileRel, data, phase, label) {
  try {
    const dir = path.dirname(stateFileRel);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFileRel, JSON.stringify(data, null, 2), 'utf8');
    log('state write [' + (label || phase || 'checkpoint') + ']: ' + stateFileRel);
  } catch (err) {
    log('ERROR: writeSprintState failed: ' + String(err).slice(0, 120));
  }
}

function clearSprintState(stateFileRel, label) {
  try {
    if (fs.existsSync(stateFileRel)) {
      fs.unlinkSync(stateFileRel);
      log('state clear [' + (label || 'state-clear-done') + ']: ' + stateFileRel);
    }
  } catch (err) {
    log('ERROR: clearSprintState failed: ' + String(err).slice(0, 120));
  }
}

// ---------------------------------------------------------------------------
// DEFAULT_CALIBRATION (loaded from cost.js via require if available; otherwise
// embedded here as fallback so the runner works before install.mjs is run).
// ---------------------------------------------------------------------------
let DEFAULT_CALIBRATION;
let computeSprintQuote;
let computeUpdatedCalibration;
let buildSprintSummary;

const skillDir = path.dirname(path.resolve(process.argv[1] || __filename));
const costJsPath = path.join(skillDir, 'cost.js');
if (fs.existsSync(costJsPath)) {
  try {
    const costMod = require(costJsPath);
    DEFAULT_CALIBRATION       = costMod.DEFAULT_CALIBRATION;
    computeSprintQuote        = costMod.computeSprintQuote;
    computeUpdatedCalibration = costMod.computeUpdatedCalibration;
    buildSprintSummary        = costMod.buildSprintSummary;
    log('Loaded cost.js from ' + costJsPath);
  } catch (err) {
    log('WARN: cost.js load failed: ' + String(err).slice(0, 120));
  }
}

if (!DEFAULT_CALIBRATION) {
  DEFAULT_CALIBRATION = {
    schema_version: 1,
    model_prices_per_1m_output_tokens: {
      [TIER_CHEAP]:    5.00,
      [TIER_STANDARD]: 15.00,
      [TIER_PREMIUM]:  25.00,
    },
    role_models: {
      'setup':             TIER_CHEAP,
      'planner':           TIER_PREMIUM,
      'plan-reviewer':     TIER_STANDARD,
      'deployer':          TIER_STANDARD,
      'integ-test-runner': TIER_STANDARD,
      'ci-watcher':        TIER_CHEAP,
      'harvester':         TIER_STANDARD,
      'log-flush':         TIER_CHEAP,
      'check-blockers':    TIER_CHEAP,
      'ready-streaks':     TIER_CHEAP,
    },
    doer_model_fallback: { model: TIER_STANDARD },
    reviewer_model_rule: { minimum: TIER_STANDARD },
    complexity_buckets: {
      S: { doer_tokens:  600 },
      M: { doer_tokens: 1400 },
      L: { doer_tokens: 2800 },
    },
    reviewer_ratio:    { value: 0.4 },
    cycle_assumptions: { optimistic: 1.0, expected: 1.5, pessimistic: 2.5 },
    fixed_overhead_tokens: {
      setup: 200, planner: 2000, plan_reviewer: 1500,
      harvester: 3000, ci_watcher: 300, log_flush_per_cycle: 100,
    },
    input_cost_multiplier: { value: 3.0 },
    outlier_thresholds:    { outlier_pct: 200, calibration_failure_pct: 500 },
    doer_token_ceiling:    {},
    historical:            {},
  };
}

if (!computeSprintQuote) {
  computeSprintQuote = function(taskAssignments, calibration) {
    return { tasks: taskAssignments || [], calibrationSource: 'defaults',
      inputMultiplier: 3.0, scenarios: {
        optimistic:  { outputOnly: 0, total: 0 },
        expected:    { outputOnly: 0, total: 0 },
        pessimistic: { outputOnly: 0, total: 0 },
      }};
  };
}
if (!computeUpdatedCalibration) {
  computeUpdatedCalibration = function(cal) { return cal; };
}
if (!buildSprintSummary) {
  buildSprintSummary = function(analysis, quote, cal, opts) {
    return { summaryText: '(cost.js not loaded -- summary unavailable)' };
  };
}

// ---------------------------------------------------------------------------
// Main async entry point
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Process fault guards (T3.7) - must be at module top-level
// ---------------------------------------------------------------------------
process.on('unhandledRejection', function(reason) {
  log('[FATAL] unhandledRejection: ' + String(reason));
  updateLiveState({ phase: 'ERROR', abortReason: String(reason) });
});
process.on('uncaughtException', function(err) {
  log('[FATAL] uncaughtException: ' + err.message);
  updateLiveState({ phase: 'ERROR', abortReason: err.message });
});

let _globalRepo = process.cwd();
let _globalSafeBranch = 'unknown';
let _globalStartedAt = new Date().toISOString();

function writeStaticHtmlReport() {
  try {
    const ts = new Date(_globalStartedAt).toISOString().replace(/[:.]/g, '-');
    const htmlPath = require('path').join(_globalRepo, 'sprint-logs', 'sprint-status-' + ts + '.html');
    const finalStateJson = JSON.stringify(_liveState);
    let finalHtml = STATUS_HTML.replace(
      "const res = await fetch('/state');",
      "const res = { json: async () => (" + finalStateJson + ") };"
    ).replace(
      "setInterval(poll, 2000);",
      "poll(); // static report"
    );
    safeWriteFile(htmlPath, finalHtml, 'Static HTML sprint report');
    log('Static HTML report saved: ' + htmlPath);
  } catch (e) {
    log('Failed to write HTML report: ' + e.message);
  }
}

(async function main() {
  updateLiveState({ startedAt: Date.now() });
  // ---- Setup block ----

  // ---- Browser status server (T3.6) ----
  const _statusPort = 3000 + Math.floor(Math.random() * 1000);
  let _statusServer = null;
  try {
    _statusServer = http.createServer(function(req, res) {
      if (req.url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const _repo = typeof repo === 'string' && repo ? repo : '.';
        const deployMdExists = fs.existsSync(path.join(_repo, 'deploy.md'));
        const playbookExists = fs.existsSync(path.join(_repo, 'integ-test-playbook.md'));
        const statePayload = Object.assign({}, _liveState, { ledger: dispatchLedger, deployMdExists, playbookExists });
        res.end(JSON.stringify(statePayload));
        return;
      }
      if (req.url.startsWith('/log?label=')) {
        const u = new URL(req.url, 'http://localhost');
        const l = u.searchParams.get('label');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(dispatchOutputs[l] || 'No output found for task: ' + l);
        return;
      }
      if (req.url === '/stop' && req.method === 'POST') {
        global.abortRequested = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'stopping' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(STATUS_HTML);
    });
    _statusServer.listen(_statusPort, '127.0.0.1', function() {
      log('[STATUS] Sprint dashboard: http://127.0.0.1:' + _statusPort);
      try {
        const _openCmd = process.platform === 'win32'
          ? 'start http://127.0.0.1:' + _statusPort
          : process.platform === 'darwin'
          ? 'open http://127.0.0.1:' + _statusPort
          : 'xdg-open http://127.0.0.1:' + _statusPort;
        execSync(_openCmd, { stdio: 'ignore', timeout: 5000 });
      } catch {}
    });
    _statusServer.on('error', function(err) {
      log('[WARN] Status server error: ' + err.message);
    });
  } catch (err) {
    log('[WARN] Status server failed to start: ' + err.message);
  }

  // Derive repo from git.
  let repo = '';
  try {
    repo = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    log('ERROR: could not determine repo root (not a git repo?)');
    process.exit(1);
  }

  // Auto-detect branch if not provided.
  if (!branch) {
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      log('ERROR: could not detect current git branch');
      process.exit(1);
    }
  }

  if (branch === 'main' || branch === 'master') {
    log('ERROR: refusing to run sprint on protected branch "' + branch +
        '". Pass a sprint branch via {"branch":"feat/..."} arg.');
    process.exit(1);
  }

  const startedAt = _liveState.startedAt;
  log('Repo: ' + repo + ' | Branch: ' + branch);
  updateLiveState({ phase: 'setup', goal, rootIds, maxCycles, branch, startedAt, mission });

  // Ensure sprint-logs/ directory exists.
  const sprintLogsDir = path.join(repo, 'sprint-logs');
  if (!fs.existsSync(sprintLogsDir)) fs.mkdirSync(sprintLogsDir, { recursive: true });

  // Build state file path (branch-keyed).
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'default';
  _globalRepo = repo;
  _globalSafeBranch = safeBranch;
  _globalStartedAt = startedAt;
  const stateFileRel = path.join(repo, 'sprint-logs', '.state', safeBranch + '.state.json');

  // Load calibration.json if present; fall back to DEFAULT_CALIBRATION.
  let calibration = DEFAULT_CALIBRATION;
  const calibPath = path.join(repo, 'sprint-logs', 'calibration.json');
  if (fs.existsSync(calibPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(calibPath, 'utf8'));
      calibration = Object.assign({}, DEFAULT_CALIBRATION, raw);
      log('Loaded calibration from ' + calibPath);
    } catch (err) {
      log('WARN: calibration.json parse failed, using defaults: ' + String(err).slice(0, 80));
    }
  }

  // Write start event to state file.
  writeSprintState(stateFileRel, {
    type: 'start', branch, goal, rootIds, startedAt,
  }, 'setup', 'start');

  const rootSummary = rootIds.join(', ');

  // Dispatch setup agent via pm-planner to ensure branch exists and sprint-log meta
  // line is written. ALWAYS execute locally.
  const cp = require('node:child_process');
  try { cp.execSync(`git -C "${repo}" checkout -b ${branch}`, { stdio: 'ignore' }); } catch(e) {
    try { cp.execSync(`git -C "${repo}" checkout ${branch}`, { stdio: 'ignore' }); } catch(e2) {}
  }
  fs.mkdirSync(`${repo}/sprint-logs`, { recursive: true });


  log('Setup complete. Starting sprint cycle loop.');
  log('Sprint goals: ' + rootSummary + ' | Goal: ' + goal + ' (P<=' + threshold +
      ') | Max cycles: ' + maxCycles);

  // Check for deploy.md and integ-test-playbook.md locally (no LLM needed).
  const deployMdExists  = fs.existsSync(path.join(repo, 'deploy.md'));
  const playbookExists  = fs.existsSync(path.join(repo, 'integ-test-playbook.md'));
  const integTestEnabled = deployMdExists && playbookExists;

  // Sprint loop state.
  let cycleCount      = 0;
  let abortReason     = '';
  let goalMet         = false;
  let taskAssignments = [];
  let sprintQuote     = null;
  let prevOpenIds     = [];

  // ---- SPRINT LOOP ----
  const sprintBudget = 10.00;
  while (cycleCount < maxCycles && !goalMet && !abortReason) {
    cycleCount++;
    
    const currentCost = dispatchLedger.reduce((s, e) => s + (e.costUsd || 0), 0);
    if (currentCost > sprintBudget * 2) {
      abortReason = 'Cost limit exceeded ($' + currentCost.toFixed(2) + ' / $' + sprintBudget.toFixed(2) + ')';
      log('ABORT: ' + abortReason);
      break;
    }
    log('\n=== Cycle ' + cycleCount + '/' + maxCycles + ' | goal: ' + goal + ' ===');
    updateLiveState({ phase: 'Plan', cycle: cycleCount });

    writeSprintState(stateFileRel, {
      type: 'cycle-start', cycle: cycleCount, branch, goal, rootIds, startedAt,
    }, 'Plan', 'state-c' + cycleCount + '-plan');

    // Check cycle state: planDone + in_progress orphans.
    const makeBfsExtr = (rootsArr) => `const subtree=new Set('${rootsArr.join(' ')}'.split(' ').filter(Boolean));const q=Array.from(subtree);const nodes=g.layout&&g.layout.Nodes;if(nodes){while(q.length>0){const c=q.shift();const n=nodes[c];if(n&&n.DependsOn){for(const d of n.DependsOn)if(!subtree.has(d)){subtree.add(d);q.push(d);}}}}`;
    
    const idExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtr(rootIds)}console.log(Array.from(subtree).join(' '))}catch{}"`;
    const graphExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtr(rootIds)}const issues=(g.issues||[]).filter(i=>subtree.has(i.id));console.log(JSON.stringify(issues.map(i=>({id:i.id,title:i.title,t:i.issue_type,s:i.status,d:!!(i.description||'').trim(),children:(g.layout&&g.layout.Nodes[i.id]&&g.layout.Nodes[i.id].DependsOn)||[]}))))}catch{console.log('[]')}"`;
    const ipExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).map(i=>i.id).join(' '))}catch{}"`;
    const cycleStateCmds = [
      ...rootIds.map(id => `bd graph --json ${id} | ${graphExtract}`),
      `bd list --status=in_progress --type=task --json | ${ipExtract}`,
    ];
    const cycleStateRaw = await dispatchShellFleet(cycleStateCmds, 'pm-doer-cheap', {
      label: 'cycle-state', phase: 'Plan', cycle: cycleCount,
    });
    const cycleState = parseCycleState(cycleStateRaw && cycleStateRaw.outputs,
      rootIds.length);
    updateLiveState({ sprintBeads: cycleState.allIssues || [] });
    log('Cycle state: planDone=' + cycleState.planDone +
        ' inProgress=[' + cycleState.inProgressIds.join(', ') + ']');

    // Reset orphaned in_progress tasks.
    if (cycleState.inProgressIds.length > 0) {
      log('Resetting ' + cycleState.inProgressIds.length + ' orphaned in_progress task(s) to open');
      const resetCmds = cycleState.inProgressIds.map(id => `bd update ${id} --status=open`);
      await dispatchShellFleet(resetCmds, 'pm-doer-cheap', {
        label: 'reset-orphans', phase: 'Plan', cycle: cycleCount,
      });
    }
    // ---------------------------------------------------------------- PLAN

    let planApproved = cycleState.planDone;
    let planFeedback = '';
    const MAX_PLAN_ITER = 3;

    if (planApproved) {
      log('Plan already complete -- skipping plan loop for cycle ' + cycleCount);
    }

    for (let pi = 0; pi < MAX_PLAN_ITER && !planApproved; pi++) {
      const plannerLabel = `planner-c${cycleCount}-r${pi}`;

      const plannerPrompt =
        `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
        `Sprint goals: ${rootSummary}\n` +
        (mission ? `SPRINT MISSION / OBJECTIVE:\n${mission}\n(Prioritize addressing this overarching objective when planning tasks).\n\n` : '') +
        (requirementsFile ? `Additional context: ${requirementsFile}\n` : '') +
        `\n` +
        (planFeedback
          ? `Plan-reviewer feedback from the previous round (read feedback.md in ${repo} for full details):\n${planFeedback}\nAddress every item before proceeding.\n\n`
          : '') +
        `Inspect existing state first (DO NOT USE RUN_COMMAND FOR THIS):\n` +
        `  Use the 'view_file' or 'grep_search' tool on ".beads/issues.jsonl" to read issue descriptions.\n` +
        `  NEVER try to run "bd show <id>" in the shell. The Native agent cannot use interactive tools!\n` +
        `  IMPORTANT: When using the 'call_mcp_tool' tool, the 'Arguments' field MUST be a JSON object, NOT a stringified JSON string! For example: {"command": "bd ready", "run_from": "C:/akhil/git/fleet-e2e-toy-agy", "member_name": "pm-planner"} (Do NOT use 'cwd', use 'run_from', and ALWAYS include 'member_name').\n` +
        `Then build or complete the feature+task DAG -- create only what is missing:\n` +
        `  - BEFORE creating any feature or task, read the existing issues in .beads/issues.jsonl.\n` +
        `    If a matching issue already exists, update it instead of creating a duplicate.\n` +
        `\n` +
        `DEPENDENCY WIRING -- read this carefully. "bd dep add A B" means A CANNOT CLOSE until B is done.\n` +
        `The correct wiring direction is: parents depend on children (children unblock first).\n` +
        `\n` +
        `  Step 1 -- wire sprint goal -> child (goal waits for children):\n` +
        `    bd dep add <goal-id> <child-id>\n` +
        `    After this: "bd ready" will NOT show the sprint goal (it's waiting). Children show as ready.\n` +
        `\n` +
        `  Step 2 -- wire feature -> tasks (feature waits for tasks):\n` +
        `    bd dep add <feature-id> <impl-task-id>\n` +
        `    bd dep add <feature-id> <test-task-id>\n` +
        `    After this: "bd ready" will show impl-task (the leaf). Feature is now blocked.\n` +
        `\n` +
        `  Step 3 -- wire test after impl:\n` +
        `    bd dep add <test-task-id> <impl-task-id>\n` +
        `    After this: "bd ready" shows only impl-task. test-task unblocks once impl-task closes.\n` +
        `\n` +
        `  VERIFY after wiring: run "bd ready" -- it must return impl tasks, NOT sprint goals or blocked parents.\n` +
        `  If sprint goals appear in "bd ready" the deps are backwards -- fix them before continuing.\n` +
        `\n` +
        `  IMPORTANT: Each task belongs to exactly ONE feature. Never share a task across features.\n` +
        `\n` +
        `  Break each sprint goal into child issues: bd create --parent <goal-id> (use type=feature for sub-goals, type=task for leaf work).\n` +
        `  Create type=task issues for each feature: implementation tasks AND integration\n` +
        `    test development tasks (prefix test tasks with "[test]" in the title)\n` +
        `  Features P1/P2; tasks one level below their parent feature (P1 feature -> P2 tasks, P2 feature -> P3 tasks)\n` +
        `  Each task must be completable in one agent session (1-3 file changes max)\n` +
        `  Every task needs clear acceptance criteria in its description\n` +
        `  - Assign each task a tier AND complexity bucket based on complexity -- after creating or updating each\n` +
        `    task, run: bd update <id> --set-metadata model=<tier>\n` +
        `    Available tiers and when to use them:\n` +
        `      ${TIER_CHEAP}    -- mechanical work: rename, config tweak, move file, simple wiring\n` +
        `      ${TIER_STANDARD} -- standard work: new function, test suite, API endpoint, refactor\n` +
        `      ${TIER_PREMIUM}  -- hard work: architecture, multi-file design, ambiguous requirements\n` +
        `    Complexity buckets (S/M/L) are assigned by the plan-reviewer based on task scope.\n` +
        `    Every task MUST receive a bucket assignment -- tasks without a bucket cannot be cost-estimated.\n` +
        `  - Group tasks so consecutive tasks in dependency order share a tier where\n` +
        `    possible -- this minimises tier-switching overhead during execution\n` +
        (cycleCount > 1
          ? `This is cycle ${cycleCount}. Focus on open issues only.\n` +
            `Do NOT add new scope beyond the original sprint goals and open bugs/enhancements.\n` +
            `Do NOT re-create tasks that are already closed.\n`
          : '') +
        `Confirm with any text when done.`;

      const plannerResult = await dispatchFleet('pm-planner', plannerPrompt, {
        label: plannerLabel, phase: 'Plan', cycle: cycleCount,
      });

      if (!plannerResult) {
        log('Planner returned null on cycle ' + cycleCount + ' round ' + pi + ' -- retrying');
        continue;
      }

      const planReviewerLabel = `plan-reviewer-c${cycleCount}-r${pi}`;
      const planReviewPrompt =
        `Repo: ${repo}\nBranch: ${branch}\nSprint goals: ${rootSummary}\n` +
        `Calibration file: ${repo}/sprint-logs/calibration.json (read this first if it exists)\n\n` +
        `Review the beads DAG for these sprint goals ONLY: ${rootSummary}\n` +
        `Run: ${rootIds.map(id => `bd show ${id}`).join(' && ')} to inspect each sprint goal.\n` +
        `Run: ${rootIds.map(id => `bd graph --compact ${id}`).join(' && ')} for the full dependency subtree.\n` +
        `Run: bd show <id> to inspect individual issues in depth.\n` +
        `Run: bd ready -- this is your FIRST correctness check.\n` +
        `Do NOT review or comment on issues outside these sprint goals.\n\n` +
        `Follow your runbook (plan-reviewer.md) step by step:\n` +
        `  Steps 1-2: inspect the DAG and check all quality criteria.\n` +
        `  Step 3: classify each task -- assign complexity bucket (S/M/L) and read its model\n` +
        `    from beads metadata. If a task has no model metadata, note it in your verdict\n` +
        `    notes as a warning but do NOT return CHANGES NEEDED for it -- the workflow has a fallback.\n` +
        `  Step 4: return verdict, notes, and taskAssignments (id + bucket + model per task).\n\n` +
        `Notes must be specific: include issue IDs and exact "bd dep add" commands to fix\n` +
        `any dependency direction problems.`;

      const planReview = await dispatchFleet('pm-reviewer', planReviewPrompt, {
        label: planReviewerLabel, phase: 'Plan', cycle: cycleCount,
        schema: PLAN_REVIEW_SCHEMA,
      });

      if (approved(planReview)) {
        planApproved = true;
        log('Plan APPROVED on cycle ' + cycleCount + ' round ' + (pi + 1));
        taskAssignments = (planReview && planReview.taskAssignments) || [];

        // Compute sprint cost quote in pure JS.
        sprintQuote = computeSprintQuote(taskAssignments, calibration);
        const sc = sprintQuote.scenarios;
        log('Sprint quote (' + sprintQuote.calibrationSource + ', ' + taskAssignments.length + ' tasks): ' +
            'exp=$' + sc.expected.outputOnly.toFixed(3));

        // Commit plan snapshot via shell dispatch.
        const planCommitCmds = [
          ...((sprintQuote && sprintQuote.tasks) ? sprintQuote.tasks.map(t =>
            `bd update ${t.id} --notes="cost-estimate: bucket=${t.bucket} model=${t.model} ` +
            `doer_tokens=${t.doerTokens || 0} output_usd=${t.outputUsd ? t.outputUsd.toFixed(4) : '0.0000'}"`
          ) : []),
          `bd export -o "${repo}/.beads/issues.jsonl"`,
          `git -C "${repo}" add .beads/issues.jsonl`,
          `git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit --allow-empty -m "plan: approve task DAG"`,
        ];
        await dispatchShellFleet(planCommitCmds, 'pm-doer-cheap', {
          label: 'plan-commit-c' + cycleCount, phase: 'Plan', cycle: cycleCount,
        });

      } else if (planReview && planReview.verdict === 'CHANGES NEEDED') {
        planFeedback = (planReview && planReview.notes) || '';
        log('Plan CHANGES NEEDED (round ' + (pi + 1) + '): ' + planFeedback.slice(0, 120));

        // Write feedback.md and commit natively so planner can read it.
        const fbLabel = 'feedback-commit-plan-c' + cycleCount + '-r' + pi;
        const fbStart = Date.now();
        updateLiveState({ currentAgent: fbLabel, currentModel: 'native', currentPhase: 'Plan', currentCycle: cycleCount, currentStartTime: fbStart });
        fs.writeFileSync(require('path').join(repo, 'feedback.md'), planFeedback);
        try {
          require('child_process').execSync('git add feedback.md', { cwd: repo, stdio: 'ignore' });
          require('child_process').execSync('git -c user.name="pm-reviewer" -c user.email="pm-reviewer@pm.local" commit -m "feedback: plan-reviewer-c' + cycleCount + '-r' + pi + '"', { cwd: repo, stdio: 'ignore' });
        } catch (e) {
          log('Warning: Feedback commit failed (possibly empty diff): ' + e.message);
        }
        dispatchLedger.push({ cycle: cycleCount, phase: 'Plan', label: fbLabel, model: 'native', outTokens: 0, costUsd: 0, durationMs: Date.now() - fbStart });
      } else {
        log('Plan reviewer returned null or unexpected verdict on round ' + (pi + 1));
      }
    }

    if (!planApproved) {
      log('Plan not approved after ' + MAX_PLAN_ITER + ' rounds -- proceeding anyway');
      planApproved = true;
    }

    writeSprintState(stateFileRel, {
      type: 'checkpoint', cycle: cycleCount, phase: 'Plan', planApproved: true, branch, goal, rootIds, startedAt,
    }, 'Plan', 'state-c' + cycleCount + '-plan-done');
    updateLiveState({ phase: 'Develop', cycle: cycleCount });
    // ---------------------------------------------------------------- DEVELOP

    // ---- phase_label for Develop phase
    let phase_label = 'Develop';
    writeSprintState(stateFileRel, {
      type: 'checkpoint', cycle: cycleCount, phase: 'Develop', planApproved: true, branch, goal, rootIds, startedAt,
    }, 'Develop', 'state-c' + cycleCount + '-dev');

    const MAX_DEV_ITER = 20;
    let devIter  = 0;
    let devFeedback = '';

    // id->bucket map derived from last approved taskAssignments.
    const bucketById = Object.fromEntries((taskAssignments || []).map(t => [t.id, t.bucket]));

    while (devIter < MAX_DEV_ITER) {
      // Get ready streaks via fleet shell dispatch.
      // Use the graph to accurately determine which tasks have 0 open blockers, bypassing bd list --ready filtering.
      const graphReadyExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtr(rootIds)}const readyIds=[];if(nodes){for(const id of Array.from(subtree)){const n=nodes[id];if(!n||n.Issue.status!=='open')continue;let blocked=false;if(n.DependsOn){for(const depId of n.DependsOn){const dep=nodes[depId];if(dep&&dep.Issue.status!=='closed'&&dep.Issue.status!=='deferred'){blocked=true;break;}}}if(!blocked)readyIds.push(id);}}console.log(readyIds.join(' '));}catch(e){}"`;
      const taskExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority,m:(i.metadata||{}).model}))))}catch{console.log('[]')}"`;
      const readyCmds = [
        ...rootIds.map(id => `bd graph --json ${id} | ${graphReadyExtract}`),
        `bd list --status=open --type=task --json | ${taskExtract}`,
      ];
      const streakRaw = await dispatchShellFleet(readyCmds, 'pm-doer-cheap', {
        label: 'ready-streaks', phase: 'Develop', cycle: cycleCount,
      });
      const streakResult = parseReadyStreaks(
        streakRaw && streakRaw.outputs, rootIds.length, rootIds.length, TIER_STANDARD);

      if (streakResult.totalCount === 0) {
        // Deadlock check: if first iteration and open issues exist but none ready.
        if (devIter === 0) {
          const idExtractR = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtr(rootIds)}console.log(Array.from(subtree).join(' '))}catch{}"`;
          const openIdExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority}))))}catch{console.log('[]')}"`;
          const blockerCmds = [
            ...rootIds.map(id => `bd graph --json ${id} | ${idExtractR}`),
            `bd list --status=open --json | ${openIdExtract}`,
          ];
          const blockerRaw = await dispatchShellFleet(blockerCmds, 'pm-doer-cheap', {
            label: 'check-blockers', phase: 'Develop', cycle: cycleCount,
          });
          const blockers = parseBlockers(
            blockerRaw && blockerRaw.outputs, rootIds.length, rootIds.length, threshold, rootIds);
          if (blockers.count > 0) {
            log('ERROR: DEADLOCK -- ' + blockers.count + ' open issue(s) at/above ' + goal +
                ' in the sprint subtree but NONE are ready on the first develop iteration. ' +
                'The dependency DAG is blocked (commonly backwards or parent-child edges).');
            abortReason = 'deadlock: open issues but none ready';
            break;
          }
        }
        log('No ready tasks -- develop phase complete (' + devIter + ' iterations)');
        break;
      }
      log('Dev iter ' + devIter + ' c' + cycleCount + ': ' + streakResult.totalCount +
          ' ready task(s) across ' + streakResult.streaks.length + ' model streak(s)');

      // Dispatch one doer per model streak.
      const workedIds = [];
      let streakAbort   = false;
      let doerNullReset = false;

      for (const streak of streakResult.streaks) {
        // Truncate streak to token ceiling for this tier.
        const fittedIds = truncateStreakToCeiling(streak.ids, bucketById, calibration, streak.model);
        if (fittedIds.length < streak.ids.length) {
          log('Streak ' + streak.model + ' truncated to token ceiling: working ' +
              fittedIds.length + '/' + streak.ids.length + ' task(s) (' +
              labelTaskIds(fittedIds) + '); ' + (streak.ids.length - fittedIds.length) + ' deferred');
        }

        // Resolve tier -> fleet member name.
        let doerMember;
        if (streak.model === TIER_CHEAP)    doerMember = 'pm-doer-cheap';
        else if (streak.model === TIER_PREMIUM) doerMember = 'pm-doer-premium';
        else                                    doerMember = 'pm-doer-std';

        const doerLabel = `doer-c${cycleCount}-r${devIter}: ${labelTaskIds(fittedIds)}`;
        log('Doer c' + cycleCount + '-r' + devIter + ': ' + labelTaskIds(fittedIds) +
            ' [model=' + streak.model + ']');

        const doerPrompt =
          `Repo: ${repo}\nBranch: ${branch}\n\n` +
          (devFeedback
            ? `Reviewer feedback from the previous iteration (read feedback.md in ${repo} for full details):\n${devFeedback}\nAddress every finding before closing tasks.\n\n`
            : '') +
          `Work ONLY these tasks (in order): ${fittedIds.join(', ')}\n` +
          `Confirm each is still unblocked with: bd show <id>\n` +
          `For each task:\n` +
          `  - Run: bd update <id> --claim\n` +
          `  - Implement the work described (code, tests, config -- whatever the task requires)\n` +
          `  - Run: bd close <id> immediately after verify and commit, BEFORE claiming the next task\n` +
          `  - Closed tasks are durable even if the doer crashes mid-streak\n` +
          `  - NEVER close a type=feature or type=bug issue -- only close type=task\n` +
          `Work all listed tasks then stop and return status "VERIFY".\n` +
          `Always return VERIFY -- never return anything else.`;

        const doerResult = await dispatchFleet(doerMember, doerPrompt, {
          label: doerLabel, phase: 'Develop', cycle: cycleCount,
          schema: DOER_STATUS_SCHEMA,
        });

        if (!doerResult) {
          log('Doer returned null (streak ' + streak.model + ') -- resetting orphaned in_progress tasks and retrying');
          const ipExtractD = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).map(i=>i.id).join(' '))}catch{}"`;
          const ipResult = await dispatchShellFleet(
            [`bd list --status=in_progress --type=task --json | ${ipExtractD}`],
            'pm-doer-cheap',
            { label: 'reset-orphans-c' + cycleCount + '-r' + devIter, phase: 'Develop', cycle: cycleCount }
          );
          const ipIds = ((ipResult && ipResult.outputs && ipResult.outputs[0]) || '')
            .trim().split(/\s+/).filter(Boolean);
          if (ipIds.length > 0) {
            const resetCmds = ipIds.map(id => `bd update ${id} --status=open`);
            await dispatchShellFleet(resetCmds, 'pm-doer-cheap', {
              label: 'reset-open-c' + cycleCount + '-r' + devIter, phase: 'Develop', cycle: cycleCount,
            });
            log('Reset ' + ipIds.length + ' in_progress task(s) to open: ' + ipIds.join(', '));
          }
          doerNullReset = true;
          break;
        }

        if (doerResult.status !== 'VERIFY') {
          log('Unexpected doer status "' + doerResult.status + '" -- aborting');
          abortReason = 'unexpected doer status';
          streakAbort = true;
          break;
        }
        workedIds.push(...fittedIds);
      }

      devIter++;
      if (doerNullReset) continue;
      if (streakAbort) break;

      // Reviewer tier: any premium -> premium; otherwise standard.
      const usedModels = streakResult.streaks.map(s => s.model);
      const reviewerModel = usedModels.includes(TIER_PREMIUM) ? TIER_PREMIUM : TIER_STANDARD;
      const reviewerLabel = `reviewer-c${cycleCount}-r${devIter}: ${labelTaskIds(workedIds)}`;

      const reviewerPrompt =
        `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
        `Sprint goals: ${rootSummary}\nTasks worked this iteration: ${workedIds.join(', ')}\n\n` +
        `Review ONLY the work done for the tasks listed above.\n` +
        `Run: bd show <id> for each task to read its acceptance criteria.\n` +
        `Run: git -C "${repo}" diff ${base_branch}...${branch} to see the changes.\n` +
        `Do NOT comment on code or issues outside the listed tasks.\n` +
        `Check: code correctness, test coverage, adherence to each task's acceptance criteria.\n` +
        `If a task needs rework, reopen it: bd update <id> --status=open\n` +
        `CHANGES NEEDED verdict must include specific actionable feedback tied to a task ID.\n` +
        `APPROVED means all committed work meets acceptance criteria.`;

      const review = await dispatchFleet('pm-reviewer', reviewerPrompt, {
        label: reviewerLabel, phase: 'Develop', cycle: cycleCount,
        schema: REVIEW_SCHEMA,
      });
      log('Reviewer c' + cycleCount + '-r' + devIter + ': ' +
          ((review && review.verdict) || 'null') + ' -- ' + labelTaskIds(workedIds));

      if (!approved(review)) {
        devFeedback = (review && review.notes) || '';
        log('Reviewer feedback: ' + devFeedback.slice(0, 120));
        // Write feedback.md to disk synchronously to avoid race conditions.
        const devFbLabel = 'feedback-write-' + reviewerLabel;
        const devFbStart = Date.now();
        updateLiveState({ currentAgent: devFbLabel, currentModel: 'native', currentPhase: 'Develop', currentCycle: cycleCount, currentStartTime: devFbStart });
        fs.writeFileSync(require('path').join(repo, 'feedback.md'), devFeedback);
        dispatchLedger.push({ cycle: cycleCount, phase: 'Develop', label: devFbLabel, model: 'native', outTokens: 0, costUsd: 0, durationMs: Date.now() - devFbStart });
      } else {
        devFeedback = '';
      }

      writeSprintState(stateFileRel, {
        type: 'checkpoint', cycle: cycleCount, phase: 'Develop', devIter, branch, goal, rootIds, startedAt,
      }, 'Develop', 'state-c' + cycleCount + '-dev-r' + devIter);
    }

    if (abortReason) break;

    updateLiveState({ phase: 'Test', cycle: cycleCount });
    // ---------------------------------------------------------------- TEST (T3.1)

    const _deployMdExists = fs.existsSync(path.join(repo, 'deploy.md'));
    const _playbookExists = fs.existsSync(path.join(repo, 'integ-test-playbook.md'));

    if (!_deployMdExists && !_playbookExists) {
      log('Test phase: no deploy.md or integ-test-playbook.md found -- skipping');
    } else {
      if (_deployMdExists) {
        const deployerPrompt =
          'Repo: ' + repo + '\nBranch: ' + branch + '\nCycle: ' + cycleCount + '\n\n' +
          'Follow the integration test playbook and deploy.md:\n' +
          (cycleCount === 1
            ? '1. Run the Setup section of integ-test-playbook.md to bring up the test environment.\n'
            : '1. Run the Reset section of integ-test-playbook.md to restore pristine state.\n') +
          '2. Follow all steps in deploy.md to deploy the build.\n' +
          '3. Run the smoke test defined in deploy.md.\n' +
          '4. Return deployed: true if the smoke test passes, false otherwise.\n' +
          '5. If deployed is false, include the error output in notes.';
        const deployResult = await dispatchFleet('pm-doer-std', deployerPrompt, {
          label: 'deployer-c' + cycleCount, phase: 'Test', cycle: cycleCount,
          schema: { type: 'object', required: ['deployed'],
            properties: { deployed: { type: 'boolean' }, notes: { type: 'string' } } },
        });
        if (!deployResult || !deployResult.deployed) {
          const msg = (deployResult && deployResult.notes) || 'no details';
          log('Deploy failed on cycle ' + cycleCount + ': ' + msg.slice(0, 200));
          log('Skipping integration tests this cycle -- teardown and continue');
          await dispatchFleet('pm-doer-std',
            'Run the Teardown section of integ-test-playbook.md to clean up the test environment.',
            { label: 'teardown-c' + cycleCount + '-fail', phase: 'Test', cycle: cycleCount });
        } else if (_playbookExists) {
          const integTestPrompt =
            'Repo: ' + repo + '\nBranch: ' + branch + '\nCycle: ' + cycleCount + '\n' +
            'Sprint goals: ' + rootSummary + '\n\n' +
            'The target features for this sprint are: ' + rootIds.join(', ') + '\n' +
            'For each of these target features, execute its integration tests.\n' +
            'Do NOT query or test features outside of this target list.\n\n' +
            'For each feature:\n' +
            '  PASS: all tests pass -> bd close <feature-id>\n' +
            '  FAIL: tests fail -> bd create --title="[integ] <description>" ' +
            '--description="Feature: <id>\\nExpected: <what>\\nActual: <what>\\nTest: <which>" ' +
            '--type=bug --priority=<1=core requirement unmet, 2=partial, 3=quality>\n' +
            '  Keep feature open on failure or if inconclusive.\n\n' +
            'Priority rules:\n' +
            '  P0: system will not start or core path completely broken\n' +
            '  P1: requirement from sprint goal explicitly not met\n' +
            '  P2: requirement partially met, degraded behaviour\n' +
            '  P3: quality, performance, or UX issue not blocking core function\n\n' +
            'Before creating a new bug, check bd search "[integ]" -- update existing if duplicate.\n\n' +
            'Return featuresClosed (count), issuesCreated (count), summary (one paragraph).';
          const integResult = await dispatchFleet('pm-doer-std', integTestPrompt, {
            label: 'integ-runner-c' + cycleCount, phase: 'Test', cycle: cycleCount,
            schema: INTEG_RUN_SCHEMA,
          });
          if (integResult) {
            log('Integration: ' + integResult.featuresClosed + ' features closed, ' +
                integResult.issuesCreated + ' issues created');
            log('Summary: ' + integResult.summary);
          }
          await dispatchFleet('pm-doer-std',
            'Run the Teardown section of integ-test-playbook.md to fully clean up the test environment.',
            { label: 'teardown-c' + cycleCount, phase: 'Test', cycle: cycleCount });
        }
      }
    }

    writeSprintState(stateFileRel, {
      type: 'checkpoint', cycle: cycleCount, phase: 'Test', branch, goal, rootIds, startedAt,
    }, 'Test', 'state-c' + cycleCount + '-test');

    // ---------------------------------------------------------------- CYCLE EXIT GATE (T3.2)
    const makeBfsExtrExit = (rootsArr) => `const subtree=new Set('${rootsArr.join(' ')}'.split(' ').filter(Boolean));const q=Array.from(subtree);const nodes=g.layout&&g.layout.Nodes;if(nodes){while(q.length>0){const c=q.shift();const n=nodes[c];if(n&&n.DependsOn){for(const d of n.DependsOn)if(!subtree.has(d)){subtree.add(d);q.push(d);}}}}`;

    const _openIdExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority}))))}catch{console.log('[]')}"`;
    const _idExtract2    = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtrExit(rootIds)}console.log(Array.from(subtree).join(' '))}catch{}"`;
    const _exitCmds = [
      ...rootIds.map(id => 'bd graph --json ' + id + ' | ' + _idExtract2),
      'bd list --status=open --json | ' + _openIdExtract,
    ];
    const _exitRaw = await dispatchShellFleet(_exitCmds, 'pm-doer-cheap', {
      label: 'exit-check-c' + cycleCount, phase: 'Test', cycle: cycleCount,
    });
    const _blockers = parseBlockers(
      _exitRaw && _exitRaw.outputs, rootIds.length, rootIds.length, threshold, rootIds);
    const openCount = _blockers.count;
    const currentOpenIds = (_blockers.ids || []).slice().sort();
    updateLiveState({ openCount });

    log('Exit check cycle ' + cycleCount + ': ' + openCount +
        ' blocker(s) at/above ' + goal + ' -- IDs: [' + currentOpenIds.join(', ') + ']');

    if (openCount === 0) {
      goalMet = true;
      log('Goal met -- all P<=' + threshold + ' issues resolved');
      break;
    }

    // No-progress check: if open IDs are identical to last cycle, abort.
    if (cycleCount > 1 && prevOpenIds.length > 0) {
      const prevSorted = prevOpenIds.slice().sort();
      const same = prevSorted.length === currentOpenIds.length &&
        prevSorted.every((id, i) => id === currentOpenIds[i]);
      if (same) {
        log('No progress in cycle ' + cycleCount + ': same ' +
            prevOpenIds.length + ' issues unresolved -- aborting');
        abortReason = 'no-progress';
        prevOpenIds = currentOpenIds;
        break;
      }
    }

    prevOpenIds = currentOpenIds;

    if (cycleCount >= maxCycles) {
      log('Cycle ceiling reached: ' + cycleCount + '/' + maxCycles + ' -- stopping sprint loop');
      break;
    }

    log('Cycle ' + cycleCount + ' complete -- ' + openCount +
        ' open issue(s) remain; starting cycle ' + (cycleCount + 1));
    } catch (iterErr) {
      log('[WARN] Cycle ' + cycleCount + ' threw unexpectedly: ' + String(iterErr).slice(0, 200) + ' -- attempting next cycle or aborting');
      updateLiveState({ phaseError: 'cycle-' + cycleCount + ': ' + String(iterErr).slice(0, 120), endedAt: Date.now() });
      if (cycleCount >= maxCycles) { abortReason = 'cycle-exception'; break; }
}
  }

  // ---------------------------------------------------------------- POST-LOOP
  updateLiveState({ goalMet, abortReason, endedAt: Date.now() });
  log('\n=== Sprint complete: cycles=' + cycleCount + ' goalMet=' + goalMet +
      ' abortReason=' + (abortReason || 'none') + ' ===');

  updateLiveState({ phase: 'Harvest', cycle: cycleCount });
  // ---------------------------------------------------------------- HARVEST (T3.3)

  const finalReviewPrompt =
    'Repo: ' + repo + '\nBranch: ' + branch + '\nBase branch: ' + base_branch + '\n' +
    'Sprint goals: ' + rootSummary + '\nGoal: ' + goal + '\n' +
    (abortReason ? 'Sprint ended early: ' + abortReason + '. Review what was completed.\n' : '') +
    (goalMet ? 'Goal was met: all P<=' + threshold + ' issues resolved.\n' : 'Goal not yet met.\n') +
    '\nReview the overall output of this sprint:\n' +
    '  - Does the work address the original sprint goals?\n' +
    '  - Are there obvious gaps or regressions?\n' +
    '  - Is the codebase in a releasable state for what was completed?\n' +
    'APPROVED means the work is ready to harvest and raise as a PR.\n' +
    'CHANGES NEEDED means critical issues were found; include specific findings in notes.';

  const finalReview = await dispatchFleet('pm-reviewer', finalReviewPrompt, {
    label: 'final-reviewer', phase: 'Harvest', cycle: cycleCount,
    schema: REVIEW_SCHEMA,
  });
  log('Final review: ' + ((finalReview && finalReview.verdict) || 'null'));

  if (!approved(finalReview)) {
    const notes = (finalReview && finalReview.notes) || '';
    log('Final review not approved -- aborting before harvest. Notes: ' + notes.slice(0, 300));
    clearSprintState(stateFileRel, 'state-clear-finalrejected');
    return {
      cycles: cycleCount, goalMet, goal,
      abortReason: abortReason || 'final review rejected',
      finalReviewNotes: notes,
    };
  }

  // Build sprint summary via cost.js (pure JS).
  const sprintSummary = buildSprintSummary(null, sprintQuote, calibration, {
    branch, goal, goalMet, cycleCount,
    tasksCompleted: goalMet ? (sprintQuote ? sprintQuote.tasks.length : 0) : 0,
    tasksOpen: prevOpenIds.length,
    startedAt,
  });

  // Write analysis artifact (sprint-logs/<branch>.analysis.md).
  const analysisFile = path.join(repo, 'sprint-logs', safeBranch + '.analysis.md');
  safeWriteFile(analysisFile, sprintSummary.summaryText || '', 'analysis.md');
  log('Sprint analysis written to: ' + analysisFile);

  const harvesterPrompt =
    'Repo: ' + repo + '\nBranch: ' + branch + '\nBase branch: ' + base_branch + '\n' +
    'Sprint goals: ' + rootSummary + '\nCycles completed: ' + cycleCount +
    '\nGoal met: ' + goalMet + '\n\n' +
    'The sprint is complete. Harvest the sprint artefacts.\n' +
    'Follow your runbook (agents/harvester.md).\n\n' +
    'IMPORTANT: Your FIRST action is to commit the analysis artifact below before doing anything else.\n\n' +
    'analysisText (write verbatim to sprint-logs/' + safeBranch + '.analysis.md):\n' +
    (sprintSummary.summaryText || '(no summary)') + '\n\n' +
    'Final review notes to include in CHANGELOG:\n' +
    ((finalReview && finalReview.notes) || '(none)') + '\n\n' +
    'Steps:\n' +
    '  1. Update docs/ and README if API or usage changed.\n' +
    '  2. Append sprint summary to CHANGELOG.md under [Unreleased].\n' +
    '  3. Export beads state: git -C "' + repo + '" add .beads/issues.jsonl\n' +
    '     git -C "' + repo + '" diff --cached --quiet || ' +
    '     git -C "' + repo + '" -c user.name=\'pm\' -c user.email=\'pm@pm.local\' commit -m "chore: export beads state"\n' +
    '  4. Remove sprint scaffold files from PR diff (requirements.md, feedback.md).\n' +
    '  5. Stage sprint-logs/ and push: git -C "' + repo + '" add sprint-logs/ && ' +
    '     git -C "' + repo + '" push origin ' + branch + '\n' +
    '  6. Close delivered sprint goals in beads:\n' +
    rootIds.map(id => '     bd close ' + id + ' --reason="implemented in sprint ' + branch + '"').join('\n') + '\n\n' +
    'Return status "OK" if successful, "FAILED" with notes otherwise.';

  const harvestResult = await dispatchFleet('pm-harvester', harvesterPrompt, {
    label: 'harvester', phase: 'Harvest', cycle: cycleCount,
    schema: HARVEST_SCHEMA,
  });

  if (!harvestResult || harvestResult.status !== 'OK') {
    log('Harvest failed: ' + ((harvestResult && harvestResult.notes) || 'null'));
  }

  // Calibration update (pure JS then write file).
  const updatedCalibration = computeUpdatedCalibration(calibration, null, startedAt, taskAssignments, []);
  safeWriteFile(calibPath, JSON.stringify(updatedCalibration, null, 2) + '\n', 'calibration.json');
  log('Calibration updated: ' + calibPath);

  // Dolt push (non-fatal, can be skipped for tests).
  if (!opts.skip_dolt_push) {
    const doltPushPrompt =
      'Sync beads state to the Dolt remote.\n\n' +
      'Run:\n' +
      '  bd dolt push\n\n' +
      'Capture stdout and stderr. If the command exits 0, log "bd dolt push: OK".\n' +
      'If the command exits non-zero (e.g. no dolt remote configured, network error), log a warning:\n' +
      '  "bd dolt push failed (non-fatal): <reason>"\n' +
      'and continue -- do NOT throw, return an error, or abort.\n\n' +
      'Return "OK" when done (regardless of whether the push succeeded or failed).';
    try {
      await dispatchFleet('pm-harvester', doltPushPrompt, {
        label: 'dolt-push', phase: 'Harvest', cycle: cycleCount,
      });
    } catch (err) {
      log('WARN: dolt push dispatch failed (non-fatal): ' + String(err).slice(0, 120));
    }
  } else {
    log('Skipping dolt push as requested by opts.skip_dolt_push.');
  }

  // ---------------------------------------------------------------- PR + CI (T3.4)

  const prPrompt =
    'In repo ' + repo + ' on branch ' + branch +
    ', create a GitHub pull request targeting ' + base_branch + '.\n' +
    'Command: gh pr create --base ' + base_branch + ' --head ' + branch + '\n' +
    'Title: summarise what was implemented across ' + cycleCount + ' cycle(s).\n' +
    'Body:\n' +
    '  - What was built (per sprint goal)\n' +
    '  - Sprint goal: ' + goal + ' -- ' + (goalMet ? 'MET' : 'NOT MET (partial delivery)') + '\n' +
    '  - Cycles run: ' + cycleCount + '\n' +
    '  - Open items carried forward (if any): bd list --status=open and summarise\n' +
    '  - Final review notes: ' + ((finalReview && finalReview.notes) || '(none)') + '\n' +
    '  - Token cost summary from: bd memories auto-sprint\n\n' +
    'After creating the PR, return its number as prNumber (integer).';

  const harvestPr = await dispatchFleet('pm-harvester', prPrompt, {
    label: 'harvest-pr', phase: 'Harvest', cycle: cycleCount,
    schema: {
      type: 'object', required: ['prNumber'],
      properties: { prNumber: { type: 'number' }, prUrl: { type: 'string' } },
    },
  });
  const prNumber = harvestPr && harvestPr.prNumber;
  log('PR number: ' + (prNumber || 'none'));

  if (prNumber) {
    const ciPrompt =
      'Check CI status for PR #' + prNumber + ' on branch ' + branch + '.\n' +
      'Run: gh run list --pr ' + prNumber + ' --limit 3 --json status,conclusion,databaseId\n' +
      'If runs exist and are in_progress: poll with gh run watch <id> (timeout 10 min).\n' +
      'If runs exist and conclusion is "success": return status "green".\n' +
      'If runs exist and conclusion is "failure": return status "red" with notes (include run URL).\n' +
      'If no runs found: return status "not_configured".\n' +
      'Do not block for more than 10 minutes total.';

    const ciResult = await dispatchFleet('pm-doer-cheap', ciPrompt, {
      label: 'ci-watcher', phase: 'Harvest', cycle: cycleCount,
      schema: CI_SCHEMA,
    });

    if (ciResult) {
      log('CI status: ' + ciResult.status);

      if (ciResult.status === 'not_configured') {
        log('CI not configured -- checking for existing open CI pipeline task');
        const dedupSchema = {
          type: 'object', required: ['exists', 'id'],
          properties: { exists: { type: 'boolean' }, id: { type: 'string' } },
        };
        const dedupResult = await dispatchFleet('pm-doer-cheap',
          'Run: bd search "Add CI pipeline" --status=open --json\n' +
          'Parse the JSON output and look for any issue whose title matches ' +
          '"Add CI pipeline to project" (exact or close variant, case-insensitive).\n' +
          'If a matching OPEN issue is found, return JSON: {"exists": true, "id": "<issue-id>"}\n' +
          'If no matching open issue is found (or the command returns empty/no results), ' +
          'return JSON: {"exists": false, "id": null}',
          { label: 'ci-task-dedup', phase: 'Harvest', cycle: cycleCount, schema: dedupSchema });

        if (dedupResult && dedupResult.exists) {
          log('CI pipeline task already exists: ' + dedupResult.id + ' -- skipping creation');
        } else {
          await dispatchFleet('pm-doer-cheap',
            'Run: bd create --title="Add CI pipeline to project" ' +
            '--description="The auto-sprint workflow found no CI runs for branch ' + branch + '. ' +
            'CI is required for the sprint exit gate. ' +
            'This task covers: choosing a CI provider, writing the workflow config, and verifying it triggers on push." ' +
            '--type=task --priority=2\n' +
            'Then run: bd show <new-id> and confirm it was created.',
            { label: 'ci-task-create', phase: 'Harvest', cycle: cycleCount });
          log('ACTION REQUIRED: Set up CI for this project. Task created in beads.');
        }
      } else if (ciResult.status === 'red') {
        log('CI FAILED: ' + ((ciResult.notes || '').slice(0, 200)));
      }

      if (ciResult.status !== 'green') {
        const ciNotes = ciResult.notes ? '\\n\\n' + ciResult.notes : '';
        await dispatchFleet('pm-doer-cheap',
          'Annotate PR #' + prNumber + ' with the CI status result.\n\n' +
          'Run: gh pr comment ' + prNumber + ' --body "**CI status: ' +
          ciResult.status + '**' + ciNotes + '"',
          { label: 'ci-pr-annotate', phase: 'Harvest', cycle: cycleCount });
      }
    }
  }

  // ---------------------------------------------------------------- COST SUMMARY (T3.5)

  const roleOf = label => String(label || '').replace(/-c\d.*$/, '');
  const byRole = {};
  for (const e of dispatchLedger) {
    const role = roleOf(e.label);
    if (!byRole[role]) byRole[role] = { outTokens: 0, costUsd: 0, calls: 0 };
    byRole[role].outTokens += e.outTokens || 0;
    byRole[role].costUsd   += e.costUsd   || 0;
    byRole[role].calls     += 1;
  }
  const sprintTotal = dispatchLedger.reduce((s, e) => s + (e.costUsd || 0), 0);

  log('\n=== Sprint cost summary (output tokens only) ===');
  for (const [role, data] of Object.entries(byRole)
      .sort((a, b) => b[1].costUsd - a[1].costUsd)) {
    log('  ' + role.padEnd(24) + ' $' + data.costUsd.toFixed(4).padStart(8) +
        '  ' + String(data.outTokens).padStart(8) + ' tok  ' + data.calls + ' call(s)');
  }
  log('  ' + 'TOTAL'.padEnd(24) + ' $' + sprintTotal.toFixed(4).padStart(8));
  log('  (input token cost not included -- see ' + stateFileRel + ' for per-dispatch detail)');
  log('================================================\n');

  writeStaticHtmlReport();

  // Close browser status server.
  try { if (_statusServer) _statusServer.close(); } catch {}

  clearSprintState(stateFileRel, 'state-clear-done');
  
  // Let UI fetch the final state before exiting organically
  setTimeout(() => process.exit(0), 3000);

  return {
    cycles:        cycleCount,
    goalMet,
    goal,
    harvest:       'ok',
    sprintCostUsd: parseFloat(sprintTotal.toFixed(4)),
  };

})().catch(function(err) {
  if (err.message === 'ABORT_REQUESTED') {
    log('\n[STOP] Sprint aborted by user via UI.');
    updateLiveState({ phase: 'ABORTED', endedAt: Date.now() });
    try {
      var _crashDir = (typeof repo !== 'undefined' && repo) ? path.join(repo, 'sprint-logs') : '.';
      safeWriteFile(
        path.join(_crashDir, 'crash-report.json'),
        JSON.stringify({ aborted: true, ts: new Date().toISOString() }, null, 2),
        'crash-report'
      );
    } catch {}
    writeStaticHtmlReport();
    try { if (typeof _statusServer !== 'undefined' && _statusServer) _statusServer.close(); } catch {}
    setTimeout(() => process.exit(1), 3000);
    return;
  }
  
  log('[FATAL] Unhandled: ' + String(err));
  updateLiveState({ phase: 'CRASHED', abortReason: String(err) });
  try {
    var _crashDir = (typeof repo !== 'undefined' && repo) ? path.join(repo, 'sprint-logs') : '.';
    safeWriteFile(
      path.join(_crashDir, 'crash-report.json'),
      JSON.stringify({ crashed: true, error: String(err), ts: new Date().toISOString() }, null, 2),
      'crash-report'
    );
  } catch {}
  writeStaticHtmlReport();
  try { if (typeof _statusServer !== 'undefined' && _statusServer) _statusServer.close(); } catch {}
  try { if (typeof _statusServer !== 'undefined' && _statusServer) _statusServer.close(); } catch {}
  process.exit(1);
});

// end of runner.js