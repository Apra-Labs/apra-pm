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
// progress.json schema (written by planner, maintained throughout):
// {
//   "tasks":  [ { "id":"...", "title":"...", "phase":"1", "status":"pending", "model":"..." } ],
//   "phases": [ { "id":"1", "title":"...", "model":"...", "reviewer_model":"..." } ],
//   "token_log": []
// }
// phases[].model          -- model for all doer dispatches in this phase
// phases[].reviewer_model -- model for the reviewer after this phase's VERIFY checkpoint
//
// args:
//   repo         - absolute path to the local git clone (branch already checked out)
//   branch       - sprint branch name
//   requirements - string: what needs to be built (user story, bd list output, etc.)
//   base_branch  - PR target branch (default: main)

const repo        = args && args.repo         ? args.repo         : '';
const branch      = args && args.branch       ? args.branch       : '';
const requirements = args && args.requirements ? args.requirements : '';
const base_branch  = (args && args.base_branch) || 'main';

if (!repo || !branch || !requirements) {
  log('ERROR: args.repo, args.branch, and args.requirements are required');
  return { error: 'missing required args' };
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
    verdict: { type: 'string' },
    // notes is required -- CHANGES NEEDED without specific actionable notes is useless
    notes:   { type: 'string' },
    tokens:  TOKENS_SCHEMA,
  },
};

// Doer only reports VERIFY or DONE -- the workflow knows which phase it is in.
const DOER_STATUS_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string' }, // VERIFY | DONE
    notes:  { type: 'string' },
    tokens: TOKENS_SCHEMA,
  },
};

// Raw file read -- LLM copies verbatim; JS parses.
const RAW_JSON_SCHEMA = {
  type: 'object',
  required: ['json'],
  properties: { json: { type: 'string' } },
};

const HARVEST_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string' }, // OK | FAILED
    notes:  { type: 'string' },
    tokens: TOKENS_SCHEMA,
  },
};

// ------------------------------------------------------------------ helpers

// Read progress.json verbatim via haiku and parse in JS.
// Called once after plan approval; drives the entire execute phase.
async function readProgress(label) {
  const r = await agent(
    `Read progress.json in repo ${repo} and return its entire raw contents verbatim in the json field. Do not summarise or modify it.`,
    { model: 'claude-haiku-4-5-20251001', label: label || 'read-progress', phase: 'Execute', schema: RAW_JSON_SCHEMA }
  );
  try { return r && r.json ? JSON.parse(r.json) : null; } catch { return null; }
}

// Instruction appended to every agent prompt: append one token_log entry when done.
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
  return review && typeof review.verdict === 'string' && review.verdict.toUpperCase().includes('APPROVED');
}

// ------------------------------------------------------------------ PLAN

phase('Plan');

await agent(
  `In repo ${repo} on branch ${branch}:\n` +
  `Write this content verbatim to requirements.md, then commit and push:\n\n${requirements}`,
  { model: 'claude-haiku-4-5-20251001', label: 'write-requirements', phase: 'Plan' }
);

let planFeedback = '';
let planApproved = false;

for (let round = 0; round < 3 && !planApproved; round++) {
  const plannerLabel = `planner-r${round}`;

  // Planner decides everything: task count, phases, models per phase.
  // CASE 4 fix: planner is explicitly told each phase must end with a VERIFY task.
  // CASE 6 fix: planner is told to preserve existing token_log on re-rounds.
  await agent(
    `Repo: ${repo}\nBranch: ${branch}\n` +
    (planFeedback ? `\nPrevious reviewer feedback to address:\n${planFeedback}\n` : '') +
    `\nRequirements are in requirements.md.\n\n` +
    `After committing PLAN.md, create and commit progress.json with this schema:\n` +
    `{\n` +
    `  "tasks":  [ { "id":"...", "title":"...", "phase":"<id>", "status":"pending", "model":"<model-id>" } ],\n` +
    `  "phases": [ { "id":"<id>", "title":"...", "model":"<model-id>", "reviewer_model":"<model-id>" } ],\n` +
    `  "token_log": []\n` +
    `}\n` +
    `phases[].model is the model for all doer dispatches in that phase.\n` +
    `phases[].reviewer_model is the model for the reviewer after that phase's VERIFY checkpoint.\n` +
    `Each phase MUST end with a task of type "verify" -- the doer stops there and returns VERIFY,\n` +
    `triggering a mid-sprint review before the next phase begins. Without it there is no review.\n` +
    (round > 0
      ? `If progress.json already exists from a prior round, read it first and preserve its token_log entries in the new file.\n`
      : '') +
    `Size all models to the phase's complexity and risk.` +
    tokenLogInstr(plannerLabel, 'claude-opus-4-8'),
    { model: 'claude-opus-4-8', label: plannerLabel, phase: 'Plan', agentType: 'planner' }
  );

  const reviewerLabel = `plan-reviewer-r${round}`;
  // CASE 7 fix: reviewer is told notes must be specific and actionable.
  const review = await agent(
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n\n` +
    `Verify progress.json: each phase has "model" and "reviewer_model" fields appropriately sized; ` +
    `each phase has at least one task of type "verify"; token_log is an array.\n\n` +
    `IMPORTANT: if verdict is CHANGES NEEDED, notes MUST contain specific actionable feedback. ` +
    `"CHANGES NEEDED" with vague or empty notes is not acceptable -- the planner cannot act on it.` +
    tokenLogInstr(reviewerLabel, 'claude-sonnet-4-6'),
    { model: 'claude-sonnet-4-6', label: reviewerLabel, phase: 'Plan', schema: REVIEW_SCHEMA, agentType: 'plan-reviewer' }
  );
  logTokens(reviewerLabel, 'claude-sonnet-4-6', review && review.tokens);

  if (approved(review)) {
    planApproved = true;
    log(`Plan APPROVED on round ${round + 1}`);
  } else {
    // CASE 7 fix: use notes (required field) for actionable feedback.
    planFeedback = (review && review.notes) || '';
    log(`Plan needs changes on round ${round + 1}: ${planFeedback.slice(0, 120)}`);
  }
}

// CASE 1 fix: abort rather than falling into Execute with an unapproved plan.
if (!planApproved) {
  log('Plan not approved after 3 rounds -- aborting');
  return { error: 'plan not approved' };
}

// ----------------------------------------------------------------- EXECUTE

phase('Execute');

// Read progress.json ONCE. Workflow drives execution from this JS state --
// no re-reading mid-loop; the orchestrator always knows which phase it is in.
const progress = await readProgress('read-progress-init');

// CASE 10 fix: guard against missing or empty progress.json.
if (!progress || !Array.isArray(progress.phases) || progress.phases.length === 0) {
  log('ERROR: progress.json missing or has no phases after plan approval -- aborting');
  return { error: 'empty plan' };
}

const phases = progress.phases;
log(`Executing ${phases.length} phase(s): ${phases.map((p) => `${p.id}:${p.title}`).join(', ')}`);

const MAX_PHASE_ITER = 5;
let allDone = false;

outer: for (const ph of phases) {
  const phModel         = ph.model          || 'claude-sonnet-4-6';
  const phReviewerModel = ph.reviewer_model || 'claude-sonnet-4-6';
  log(`Phase ${ph.id} "${ph.title}" | doer=${phModel} reviewer=${phReviewerModel}`);

  let phaseApproved = false;
  let phFeedback    = ''; // CASE 3: carry reviewer feedback into next doer dispatch
  let iter          = 0;

  while (!phaseApproved && iter < MAX_PHASE_ITER) {
    const doerLabel = `doer-p${ph.id}-i${iter}`;
    const doerResult = await agent(
      `Repo: ${repo}\nBranch: ${branch}\n` +
      `Current phase: ${ph.id} - ${ph.title}\n\n` +
      // CASE 3 fix: pass reviewer feedback so the doer addresses it.
      (phFeedback ? `Reviewer found these issues to address before continuing:\n${phFeedback}\n\n` : '') +
      `Execute pending tasks for this phase from PLAN.md.\n` +
      `Stop at the VERIFY checkpoint for this phase and return status VERIFY.\n` +
      `Return status DONE if all tasks across all phases are complete.` +
      tokenLogInstr(doerLabel, phModel),
      { model: phModel, label: doerLabel, phase: 'Execute', schema: DOER_STATUS_SCHEMA, agentType: 'doer' }
    );

    iter++;
    if (!doerResult) {
      log(`Doer returned null in phase ${ph.id} iteration ${iter} -- stopping phase`);
      break;
    }
    logTokens(doerLabel, phModel, doerResult.tokens);

    const statusUp = doerResult.status ? doerResult.status.toUpperCase() : '';

    if (statusUp === 'DONE') {
      log(`All tasks complete (signaled in phase ${ph.id})`);
      allDone = true;
      break outer;
    }

    // CASE 2 fix: unknown status is logged and treated as a phase stop.
    if (statusUp !== 'VERIFY') {
      log(`Unexpected doer status "${doerResult.status}" in phase ${ph.id} -- stopping phase`);
      break;
    }

    // At VERIFY: review this phase using the model the planner assigned.
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
      // CASE 3 fix: capture notes for the next doer dispatch.
      phFeedback = (review && review.notes) || '';
    }
  }

  if (!phaseApproved) {
    log(`Phase ${ph.id} did not pass review after ${MAX_PHASE_ITER} iterations -- continuing to next phase`);
  }
}

// Final review across all phases.
const finalReviewLabel = 'final-review';
const finalReview = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}` +
  tokenLogInstr(finalReviewLabel, 'claude-opus-4-8'),
  { model: 'claude-opus-4-8', label: finalReviewLabel, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
);
logTokens(finalReviewLabel, 'claude-opus-4-8', finalReview && finalReview.tokens);
log(`Final review: ${finalReview && finalReview.verdict ? finalReview.verdict : 'done'}`);

// ----------------------------------------------------------------- HARVEST

phase('Harvest');

// CASE 8 fix: use dedicated harvester agent, not doer.
// Harvester extracts durable knowledge into docs/, updates README/CHANGELOG,
// removes scaffold files, restores provider context files from base branch.
const harvestLabel = 'harvest';
const harvestResult = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n\n` +
  `The sprint is complete. Harvest the sprint artefacts.` +
  tokenLogInstr(harvestLabel, 'claude-sonnet-4-6'),
  { model: 'claude-sonnet-4-6', label: harvestLabel, phase: 'Harvest', schema: HARVEST_SCHEMA, agentType: 'harvester' }
);
logTokens(harvestLabel, 'claude-sonnet-4-6', harvestResult && harvestResult.tokens);

// CASE 9 fix: only create the PR if harvest succeeded.
if (!harvestResult || harvestResult.status !== 'OK') {
  log(`Harvest did not complete cleanly (${harvestResult ? harvestResult.status : 'null'}) -- skipping PR creation`);
  return { phases: phases.length, allDone, harvest: 'failed' };
}

await agent(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Write a clear title and body summarising what was implemented.`,
  { model: 'claude-sonnet-4-6', label: 'harvest-pr', phase: 'Harvest' }
);

return { phases: phases.length, allDone, harvest: 'ok' };
