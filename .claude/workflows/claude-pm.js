export const meta = {
  name: 'claude-pm',
  description: 'Deterministic sprint: plan -> execute -> harvest',
  phases: [
    { title: 'Plan' },
    { title: 'Execute' },
    { title: 'Harvest' },
  ],
};

// Generic sprint workflow. Orchestrates the 5 installed agents (planner,
// plan-reviewer, doer, reviewer, harvester) against any repo and any requirements.
// The orchestrator is pure control flow -- all policy lives in the agents.
//
// Separation of concerns:
//   setup         -- asserts/creates sprint branch, locates repo root, checks req file
//   planner       -- writes PLAN.md with per-task model assignments
//   scaffold      -- reads PLAN.md, derives progress.json (haiku, deterministic)
//   plan-reviewer -- reviews PLAN.md vs requirements, writes feedback.md
//   doer          -- executes tasks phase by phase, stops at VERIFY
//   reviewer      -- reviews a completed phase
//   harvester     -- extracts durable knowledge, cleans up, returns OK/FAILED
//
// progress.json schema (written by scaffold agent, maintained by doer):
// {
//   "tasks":  [ { "id":"...", "title":"...", "phase":"1", "status":"pending", "model":"..." } ],
//   "phases": [ { "id":"1", "title":"...", "model":"...", "reviewer_model":"..." } ],
//   "token_log": []
// }
//
// Full model IDs used throughout (canonical, never hallucinated):
//   haiku  -> claude-haiku-4-5-20251001
//   sonnet -> claude-sonnet-4-6
//   opus   -> claude-opus-4-8
//
// args (JSON object serialized to string by the Workflow runtime):
//   branch           - sprint branch name (required); assert/create at startup
//   requirementsFile - requirements file path relative to repo root (default: requirements.md)
//   base_branch      - PR target branch (default: main)

// args arrives as a JSON-serialized string. Parse to object; fall back gracefully.
let opts = {};
if (args) {
  try {
    const parsed = JSON.parse(args);
    opts = (parsed && typeof parsed === 'object') ? parsed : { branch: String(parsed) };
  } catch (e) {
    // plain string (not valid JSON object) -- treat as branch name
    opts = { branch: String(args) };
  }
}

const branch           = opts.branch           || '';
const requirementsFile = opts.requirementsFile || 'requirements.md';
const base_branch      = opts.base_branch      || 'main';

if (!branch) {
  log('ERROR: branch is required (pass as args.branch or as a plain string)');
  return { error: 'missing branch' };
}

// Known canonical full model IDs. Any string not in this set returned by scaffold
// is invalid and will be replaced by the fallback before dispatch.
const KNOWN_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-8',
];
const MODEL_FALLBACK = 'claude-sonnet-4-6';

function safeModel(id) {
  return KNOWN_MODELS.includes(id) ? id : MODEL_FALLBACK;
}

// ------------------------------------------------------------------ schemas

const TOKENS_SCHEMA = {
  type: 'object',
  properties: {
    input:      { type: 'number' },
    output:     { type: 'number' },
    cache_read: { type: 'number' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES NEEDED'] },
    notes:   { type: 'string' },
    tokens:  TOKENS_SCHEMA,
  },
};

const DOER_STATUS_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['VERIFY'] },
    notes:  { type: 'string' },
    tokens: TOKENS_SCHEMA,
  },
};

const RAW_JSON_SCHEMA = {
  type: 'object',
  required: ['json'],
  properties: { json: { type: 'string' } },
};

const HARVEST_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['OK', 'FAILED'] },
    notes:  { type: 'string' },
    tokens: TOKENS_SCHEMA,
  },
};

const SETUP_SCHEMA = {
  type: 'object',
  required: ['repo', 'branch', 'requirementsFileExists'],
  properties: {
    repo:                   { type: 'string' },
    branch:                 { type: 'string' },
    requirementsFileExists: { type: 'boolean' },
  },
};

// ------------------------------------------------------------------ helpers

async function readProgress(label) {
  const r = await agent(
    `Read progress.json in the repo and return its entire raw contents verbatim in the json field. Do not summarise or modify it.`,
    { model: 'claude-haiku-4-5-20251001', label: label || 'read-progress', phase: 'Execute', schema: RAW_JSON_SCHEMA }
  );
  if (!r || !r.json) {
    log(`readProgress(${label}): agent returned null or empty json field`);
    return null;
  }
  try {
    return JSON.parse(r.json);
  } catch (e) {
    log(`readProgress(${label}): JSON parse error -- raw prefix: ${r.json.slice(0, 200)}`);
    return null;
  }
}

function tokenLogInstr(label, model) {
  return (
    `\nWhen done, append one entry to the token_log array in progress.json ` +
    `(read it first; add the array if missing):\n` +
    `{"agent":"${label}","model":"${model}","tokens":{"input":<N>,"output":<N>,"cache_read":<N>}}\n` +
    `Estimate input as total tokens received; output as total tokens generated. Commit and push.`
  );
}

function logTokens(label, model, t) {
  if (!t) return;
  log(`tokens ${label} (${model}): in=${t.input || 0} out=${t.output || 0} cache=${t.cache_read || 0}`);
}

function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.trim() === 'APPROVED';
}

// ------------------------------------------------------------------ SETUP

phase('Plan');

// Assert/create the sprint branch and locate the repo root in one step.
// This runs before any other agent so every subsequent call works on the right branch.
const setup = await agent(
  `Sprint workspace setup.\n\n` +
  `Step 1: Get the repo root.\n` +
  `  Run: git rev-parse --show-toplevel\n\n` +
  `Step 2: Assert sprint branch "${branch}".\n` +
  `  - If already on "${branch}": do nothing.\n` +
  `  - Else if "${branch}" exists locally: git checkout "${branch}"\n` +
  `  - Else if "${branch}" exists on origin: git checkout --track origin/"${branch}"\n` +
  `  - Otherwise: git checkout -b "${branch}"\n\n` +
  `Step 3: Check requirements file.\n` +
  `  Run: test -f "${requirementsFile}" && echo EXISTS || echo MISSING\n` +
  `  requirementsFileExists = true if output is EXISTS.\n\n` +
  `Return repo (absolute path), branch (confirmed name), requirementsFileExists.`,
  { model: 'claude-haiku-4-5-20251001', label: 'setup', phase: 'Plan', schema: SETUP_SCHEMA }
);

if (!setup) {
  log('ERROR: setup agent returned null -- aborting');
  return { error: 'setup failed' };
}
if (!setup.repo || !setup.branch) {
  log(`ERROR: setup missing repo or branch: ${JSON.stringify(setup)}`);
  return { error: 'setup failed' };
}
if (!setup.requirementsFileExists) {
  log(`ERROR: "${requirementsFile}" not found in ${setup.repo} -- create it before running the sprint`);
  return { error: `requirements file not found: ${requirementsFile}` };
}

const repo = setup.repo;
log(`Repo: ${repo} | Branch: ${setup.branch} | Requirements: ${requirementsFile}`);

// ------------------------------------------------------------------ PLAN

let planFeedback = '';
let planApproved = false;

for (let round = 0; round < 3 && !planApproved; round++) {
  const plannerLabel = `planner-r${round}`;

  const plannerResult = await agent(
    `Repo: ${repo}\nBranch: ${branch}\n` +
    (planFeedback ? `\nPrevious reviewer feedback to address:\n${planFeedback}\n` : '') +
    `\nRequirements are in ${requirementsFile}.\n\n` +
    `Produce PLAN.md with phases and tasks. Assign each task a concrete model sized to its complexity.\n` +
    `Use only these exact full model IDs: claude-haiku-4-5-20251001 (simple), claude-sonnet-4-6 (moderate), claude-opus-4-8 (complex).\n` +
    `Each phase MUST end with a task of type "verify" -- the doer stops there and the orchestrator\n` +
    `runs a reviewer before the next phase. Without a verify task the phase has no review gate.\n` +
    `Commit and push PLAN.md. A separate scaffold step will create progress.json from it.\n` +
    `Respond with any text to confirm completion.`,
    { model: 'claude-opus-4-8', label: plannerLabel, phase: 'Plan', agentType: 'planner' }
  );

  if (!plannerResult) {
    log(`Planner returned null on round ${round} -- skipping to next round`);
    continue;
  }

  const scaffoldLabel = `scaffold-r${round}`;
  const scaffoldResult = await agent(
    `Read PLAN.md in repo ${repo}.\n` +
    (round > 0
      ? `Also read the existing progress.json (if present) to extract its token_log array.\n`
      : '') +
    `Create (or overwrite) progress.json with this exact schema and commit + push:\n` +
    `{\n` +
    `  "tasks":  [ { "id":"<task-id>", "title":"<title>", "phase":"<phase-id>",\n` +
    `                "status":"pending", "model":"<exact-full-model-id>" } ],\n` +
    `  "phases": [ { "id":"<phase-id>", "title":"<phase-title>",\n` +
    `                "model":"<highest-tier-task-model-in-phase>",\n` +
    `                "reviewer_model":"<one-tier-up>" } ],\n` +
    (round > 0
      ? `  "token_log": [<copy token_log entries verbatim from existing progress.json>]\n`
      : `  "token_log": []\n`) +
    `}\n\n` +
    `IMPORTANT -- use ONLY these exact model IDs (no short names, no invented versions):\n` +
    `  Tier 1 (simple):   claude-haiku-4-5-20251001\n` +
    `  Tier 2 (moderate): claude-sonnet-4-6\n` +
    `  Tier 3 (complex):  claude-opus-4-8\n\n` +
    `Tier ordering for "highest in phase": haiku < sonnet < opus.\n` +
    `Tier ladder for reviewer_model: haiku -> sonnet, sonnet -> opus, opus -> opus.\n` +
    `phases[].model = the highest-tier full model ID assigned to any task in that phase.\n` +
    `Respond with any text to confirm completion.`,
    { model: 'claude-haiku-4-5-20251001', label: scaffoldLabel, phase: 'Plan' }
  );

  if (!scaffoldResult) {
    log(`Scaffold returned null on round ${round} -- skipping to next round`);
    continue;
  }

  const reviewerLabel = `plan-reviewer-r${round}`;
  const review = await agent(
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
    `Requirements file: ${requirementsFile}\n\n` +
    `Verify PLAN.md and progress.json against ${requirementsFile}.\n` +
    `Fail (CHANGES NEEDED) if: phases array is empty, tasks array is empty, any phase lacks a\n` +
    `verify task, any phase lacks "model" or "reviewer_model", or any model ID is not one of:\n` +
    `claude-haiku-4-5-20251001 / claude-sonnet-4-6 / claude-opus-4-8.\n\n` +
    `IMPORTANT: if verdict is CHANGES NEEDED, notes MUST contain specific actionable feedback.` +
    tokenLogInstr(reviewerLabel, 'claude-sonnet-4-6'),
    { model: 'claude-sonnet-4-6', label: reviewerLabel, phase: 'Plan', schema: REVIEW_SCHEMA, agentType: 'plan-reviewer' }
  );
  logTokens(reviewerLabel, 'claude-sonnet-4-6', review && review.tokens);

  if (approved(review)) {
    planApproved = true;
    log(`Plan APPROVED on round ${round + 1}`);
  } else {
    planFeedback = (review && review.notes) || '';
    log(`Plan needs changes on round ${round + 1}: ${planFeedback.slice(0, 120)}`);
  }
}

if (!planApproved) {
  log('Plan not approved after 3 rounds -- aborting');
  return { error: 'plan not approved' };
}

// ----------------------------------------------------------------- EXECUTE

phase('Execute');

const progress = await readProgress('read-progress-init');

if (!progress || !Array.isArray(progress.phases) || progress.phases.length === 0) {
  log('ERROR: progress.json missing, unreadable, or has no phases -- aborting');
  return { error: 'empty plan' };
}

const phases = progress.phases;
log(`Executing ${phases.length} phase(s): ${phases.map((p) => `${p.id}:${p.title}`).join(', ')}`);

const MAX_PHASE_ITER = 5;
let allDone     = false;
let abortedPhase = null;

outer: for (const ph of phases) {
  const phModel         = safeModel(ph.model);
  const phReviewerModel = safeModel(ph.reviewer_model);
  if (phModel !== ph.model) log(`WARNING: phase ${ph.id} model "${ph.model}" invalid -- using fallback ${phModel}`);
  if (phReviewerModel !== ph.reviewer_model) log(`WARNING: phase ${ph.id} reviewer_model "${ph.reviewer_model}" invalid -- using fallback ${phReviewerModel}`);
  log(`Phase ${ph.id} "${ph.title}" | doer=${phModel} reviewer=${phReviewerModel}`);

  let phaseApproved = false;
  let phFeedback    = '';
  let iter          = 0;

  while (!phaseApproved && iter < MAX_PHASE_ITER) {
    const doerLabel = `doer-p${ph.id}-i${iter}`;
    const doerResult = await agent(
      `Repo: ${repo}\nBranch: ${branch}\n` +
      `Current phase: ${ph.id} - ${ph.title}\n\n` +
      (phFeedback ? `Reviewer found these issues to address before continuing:\n${phFeedback}\n\n` : '') +
      `Execute pending tasks for this phase from PLAN.md.\n` +
      `When you reach the VERIFY checkpoint for this phase, stop and return status "VERIFY".\n` +
      `Always return VERIFY -- do not return DONE even if this is the last task.`,
      { model: phModel, label: doerLabel, phase: 'Execute', schema: DOER_STATUS_SCHEMA, agentType: 'doer' }
    );

    iter++;

    if (!doerResult) {
      log(`Doer returned null in phase ${ph.id} iteration ${iter} -- aborting sprint`);
      abortedPhase = ph.id;
      break outer;
    }
    logTokens(doerLabel, phModel, doerResult.tokens);

    const statusUp = doerResult.status ? doerResult.status.toUpperCase() : '';

    if (statusUp !== 'VERIFY') {
      log(`Unexpected doer status "${doerResult.status}" in phase ${ph.id} -- aborting sprint`);
      abortedPhase = ph.id;
      break outer;
    }

    const reviewerLabel = `reviewer-p${ph.id}-i${iter}`;
    const review = await agent(
      `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
      `Reviewing phase ${ph.id}: ${ph.title}\n\n` +
      `IMPORTANT: if verdict is CHANGES NEEDED, notes MUST contain specific actionable feedback.` +
      tokenLogInstr(reviewerLabel, phReviewerModel),
      { model: phReviewerModel, label: reviewerLabel, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
    );
    logTokens(reviewerLabel, phReviewerModel, review && review.tokens);
    log(`Phase ${ph.id} review: ${review && review.verdict ? review.verdict : 'no verdict'}`);

    if (approved(review)) {
      phaseApproved = true;
      phFeedback = '';
    } else {
      phFeedback = (review && review.notes) || '';
    }
  }

  if (!phaseApproved) {
    log(`Phase ${ph.id} did not pass review after ${MAX_PHASE_ITER} iterations -- aborting sprint`);
    abortedPhase = ph.id;
    break outer;
  }
}

if (!abortedPhase) {
  allDone = true;
}

// ----------------------------------------------------------------- FINAL REVIEW

const finalReviewLabel = 'final-review';
const finalReview = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  (abortedPhase ? `Note: sprint was aborted at phase ${abortedPhase}. Review what was completed.\n` : '') +
  tokenLogInstr(finalReviewLabel, 'claude-opus-4-8'),
  { model: 'claude-opus-4-8', label: finalReviewLabel, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
);
logTokens(finalReviewLabel, 'claude-opus-4-8', finalReview && finalReview.tokens);
log(`Final review: ${finalReview && finalReview.verdict ? finalReview.verdict : 'no verdict'}`);

if (!approved(finalReview)) {
  const notes = (finalReview && finalReview.notes) || '';
  log(`Final review not approved -- aborting before harvest. Notes: ${notes.slice(0, 200)}`);
  return { phases: phases.length, allDone, harvest: 'skipped', finalReviewNotes: notes };
}

// ----------------------------------------------------------------- HARVEST

phase('Harvest');

const harvestLabel = 'harvest';
const harvestResult = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  `Requirements file: ${requirementsFile}\n\n` +
  `The sprint is complete. Harvest the sprint artefacts.\n` +
  `Remove "${requirementsFile}" (not requirements.md -- use the actual filename above) along with\n` +
  `PLAN.md, progress.json, feedback.md when cleaning up scaffold files.\n` +
  `Final review notes (include any relevant context in docs/CHANGELOG before cleanup):\n` +
  `${(finalReview && finalReview.notes) || '(none)'}\n\n` +
  `Return status "OK" if all steps completed successfully, "FAILED" otherwise.`,
  { model: 'claude-sonnet-4-6', label: harvestLabel, phase: 'Harvest', schema: HARVEST_SCHEMA, agentType: 'harvester' }
);
logTokens(harvestLabel, 'claude-sonnet-4-6', harvestResult && harvestResult.tokens);

const harvestOk = harvestResult && /^ok$/i.test(harvestResult.status);
if (!harvestOk) {
  log(`Harvest did not complete cleanly (${harvestResult ? harvestResult.status : 'null'}: ${harvestResult && harvestResult.notes ? harvestResult.notes : ''}) -- skipping PR`);
  return { phases: phases.length, allDone, harvest: 'failed' };
}

await agent(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Write a clear title and body summarising what was implemented.\n` +
  `Include this context from the final review in the PR body:\n` +
  `${(finalReview && finalReview.notes) || '(none)'}`,
  { model: 'claude-sonnet-4-6', label: 'harvest-pr', phase: 'Harvest' }
);

return { phases: phases.length, allDone, harvest: 'ok' };
