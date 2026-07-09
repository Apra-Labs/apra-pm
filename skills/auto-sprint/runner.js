#!/usr/bin/env node
let runCiWatcher;
let writeStaticHtmlReport;
let startStatusServer;
let runPlanPhase;
let runDevelopPhase;
let runTestPhase;
let runHarvestPhase;
let collectSubtreeIds;
let parseBlockers;
let parseReadyStreaks;
let parseCycleState;
let truncateStreakToCeiling;
let approved;
let labelTaskIds;
let estimateCost;
let STATUS_HTML;

const dispatchLedger = [];
const dispatchOutputs = {};

const _initPromise = Promise.all([
  import('./lib/ci-watcher.js').then(m => runCiWatcher = m.runCiWatcher),
  import('./lib/status-html.js').then(m => { writeStaticHtmlReport = m.writeStaticHtmlReport; STATUS_HTML = m.STATUS_HTML; }),
  import('./lib/status-server.js').then(m => startStatusServer = m.startStatusServer),
  import('./lib/plan.js').then(m => runPlanPhase = m.runPlanPhase),
  import('./lib/develop.js').then(m => runDevelopPhase = m.runDevelopPhase),
  import('./lib/test-phase.js').then(m => runTestPhase = m.runTestPhase),
  import('./lib/harvest.js').then(m => runHarvestPhase = m.runHarvestPhase),
  import('./lib/pure.mjs').then(m => {
    collectSubtreeIds = m.collectSubtreeIds;
    parseBlockers = m.parseBlockers;
    parseReadyStreaks = m.parseReadyStreaks;
    parseCycleState = m.parseCycleState;
    truncateStreakToCeiling = m.truncateStreakToCeiling;
    approved = m.approved;
    labelTaskIds = m.labelTaskIds;
    estimateCost = m.estimateCost;
    if (!DEFAULT_CALIBRATION) DEFAULT_CALIBRATION = m.DEFAULT_CALIBRATION;
    if (!computeSprintQuote) computeSprintQuote = m.computeSprintQuote;
    if (!computeUpdatedCalibration) computeUpdatedCalibration = m.computeUpdatedCalibration;
    if (!buildSprintSummary) buildSprintSummary = m.buildSprintSummary;
  })
]);

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

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  try {
    const fs = require('node:fs');
    fs.appendFileSync('crash.log', new Date().toISOString() + ' Uncaught Exception: ' + (err.stack || err) + '\n');
  } catch(e) {}
});

process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled Rejection:', err);
  try {
    const fs = require('node:fs');
    fs.appendFileSync('crash.log', new Date().toISOString() + ' Unhandled Rejection: ' + (err.stack || err) + '\n');
  } catch(e) {}
});

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

// Pure parsers moved to lib/pure.js

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

// Pure cost functions fallback logic moved to lib/pure.js

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


(async function main() {
  await _initPromise;
  updateLiveState({ startedAt: Date.now() });
  // ---- Setup block ----

  // Derive repo from git.
  let repo = '';
  try {
    repo = require('child_process').execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    log('ERROR: could not determine repo root (not a git repo?)');
    process.exit(1);
  }

  // Auto-detect branch if not provided.
  if (!branch) {
    try {
      branch = require('child_process').execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
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

  // ---- Browser status server (T3.6) ----
  const _statusPort = 3000 + Math.floor(Math.random() * 1000);
  let _statusServer = null;
  if (startStatusServer) {
    _statusServer = startStatusServer({
      port: _statusPort,
      repo: repo || '.',
      STATUS_HTML,
      getLiveState: () => _liveState,
      dispatchLedger,
      dispatchOutputs,
      fs: require('fs'),
      pathJoin: require('path').join,
      log,
      setAbortRequested: v => { _abortRequested = v; _liveState.abortReason = 'User stopped from UI'; },
      execSync: require('child_process').execSync,
      platform: require('os').platform(),
      saveReport: () => {
        if (typeof writeStaticHtmlReport === 'function') {
          writeStaticHtmlReport({ _globalRepo: repo || '.', _globalStartedAt: _liveState.startedAt, _liveState, safeWriteFile: (p,c)=>require('fs').writeFileSync(p,c), log, pathJoin: require('path').join });
        }
      }
    });
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
    try {
      cycleCount++;
    
    const currentCost = dispatchLedger.reduce((s, e) => s + (e.costUsd || 0), 0);
    if (currentCost > sprintBudget * 2) {
      abortReason = 'Cost limit exceeded ($' + currentCost.toFixed(2) + ' / $' + sprintBudget.toFixed(2) + ')';
      log('ABORT: ' + abortReason);
      break;
    }
    log('\n=== Cycle ' + cycleCount + '/' + maxCycles + ' | goal: ' + goal + ' ===');
    const planRes = await runPlanPhase({
      cycleCount, branch, goal, rootIds, startedAt,
      repo, base_branch, rootSummary, mission, requirementsFile,
      TIER_CHEAP, TIER_STANDARD, TIER_PREMIUM,
      PLAN_REVIEW_SCHEMA,
      updateLiveState, writeSprintState, dispatchShellFleet, dispatchFleet, stateFileRel,
      parseCycleState, log, approved, computeSprintQuote, fs: require('fs'), execSync,
      dispatchLedger, sprintQuote, calibration, taskAssignments, pathJoin: require('path').join
    });
    
    let planApproved = false;
    let planFeedback = '';
    
    planApproved = planRes.planApproved;
    planFeedback = planRes.planFeedback;
    sprintQuote = planRes.sprintQuote || sprintQuote;
    taskAssignments = planRes.taskAssignments || taskAssignments;
    const devRes = await runDevelopPhase({
      cycleCount, branch, goal, rootIds, startedAt, repo, base_branch, rootSummary,
      TIER_CHEAP, TIER_STANDARD, TIER_PREMIUM, DOER_STATUS_SCHEMA, REVIEW_SCHEMA,
      taskAssignments, calibration, threshold,
      updateLiveState, writeSprintState, dispatchShellFleet, dispatchFleet, stateFileRel,
      parseReadyStreaks, truncateStreakToCeiling, labelTaskIds, parseBlockers, approved,
      log, fs: require('fs'), pathJoin: require('path').join, dispatchLedger
    });
    abortReason = devRes.abortReason;
    let devFeedback = devRes.devFeedback;

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

  const harvestRes = await runHarvestPhase({
    cycleCount, branch, goal, rootIds, startedAt, repo, base_branch, rootSummary, threshold,
    abortReason, goalMet, prevOpenIds, sprintQuote, calibration, taskAssignments, opts, safeBranch, calibPath,
    updateLiveState, dispatchFleet, clearSprintState, buildSprintSummary, safeWriteFile,
    computeUpdatedCalibration, log, runCiWatcher, pathJoin: path.join.bind(path), REVIEW_SCHEMA, HARVEST_SCHEMA, approved, stateFileRel
  });

  if (!harvestRes.harvestSuccess) {
    return {
      cycles: cycleCount, goalMet, goal,
      abortReason: harvestRes.abortReason || abortReason || 'final review rejected',
      finalReviewNotes: harvestRes.finalReviewNotes || '',
    };
  }
  const prNumber = harvestRes.prNumber;

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
