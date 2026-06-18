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
// phases[].model          -- highest-tier task model in that phase (doer dispatch model)
// phases[].reviewer_model -- one tier above phases[].model (deterministic)
//                            haiku -> sonnet, sonnet -> opus, opus -> opus
//
// args:
//   repo         - absolute path to the local git clone (branch already checked out)
//   branch       - sprint branch name
//   requirements - string: what needs to be built (user story, bd list output, etc.)
//   base_branch  - PR target branch (default: main)

const repo         = args && args.repo         ? args.repo         : '';
const branch       = args && args.branch       ? args.branch       : '';
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

// notes is required -- CHANGES NEEDED without actionable notes is useless.
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'notes'],
  properties: {
    verdict: { type: 'string' },
    notes:   { type: 'string' },
    tokens:  TOKENS_SCHEMA,
  },
};

// Doer only reports VERIFY or DONE; workflow knows the phase via loop variable.
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

// Case 2 fix: enum forces exactly "OK" or "FAILED", preventing "success"/"done"/etc.
const HARVEST_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['OK', 'FAILED'] },
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

// Appended to most agent prompts: write one token_log entry to progress.json.
// NOT appended to the harvest agent (harvester git rm's progress.json -- see Case 3).
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

  // Case 4 fix: planner only writes PLAN.md (per planner.md design -- it does NOT
  // create progress.json). A separate scaffold step derives progress.json from PLAN.md.
  // Case 5 fix: do NOT ask planner to assign reviewer_model; planner.md forbids it
  // ("code review always runs on the strongest model -- you do not assign those").
  //             Scaffold derives reviewer_model deterministically (one tier up).
  // Case 1 fix: per-task models live in PLAN.md only; scaffold derives phase-level
  //             phases[].model (highest task model in phase) without LLM relay.
  await agent(
    `Repo: ${repo}\nBranch: ${branch}\n` +
    (planFeedback ? `\nPrevious reviewer feedback to address:\n${planFeedback}\n` : '') +
    `\nRequirements are in requirements.md.\n\n` +
    `Produce PLAN.md with phases and tasks. Assign each task a concrete model sized to its complexity.\n` +
    `Each phase MUST end with a task of type "verify" -- the doer stops there and the orchestrator\n` +
    `runs a reviewer before the next phase. Without it there is no mid-sprint review.\n` +
    `Commit and push PLAN.md. A separate scaffold step will create progress.json from it.` +
    tokenLogInstr(plannerLabel, 'claude-opus-4-8'),
    { model: 'claude-opus-4-8', label: plannerLabel, phase: 'Plan', agentType: 'planner' }
  );

  // Case 4 fix: scaffold agent reads PLAN.md and creates progress.json.
  // Case 5 fix: scaffold derives phases[].reviewer_model (one tier up), not planner.
  // Case 1 fix: scaffold derives phases[].model (highest task model in phase).
  // Re-round: preserve existing token_log entries.
  const scaffoldLabel = `scaffold-r${round}`;
  await agent(
    `Read PLAN.md in repo ${repo}.\n` +
    (round > 0
      ? `Also read the existing progress.json (if present) to extract its token_log array.\n`
      : '') +
    `Create (or overwrite) progress.json with this exact schema and commit + push:\n` +
    `{\n` +
    `  "tasks":  [ { "id":"<task-id>", "title":"<title>", "phase":"<phase-id>",\n` +
    `                "status":"pending", "model":"<model-from-PLAN.md>" } ],\n` +
    `  "phases": [ { "id":"<phase-id>", "title":"<phase-title>",\n` +
    `                "model":"<highest-tier-task-model-in-phase>",\n` +
    `                "reviewer_model":"<one-tier-up>" } ],\n` +
    (round > 0
      ? `  "token_log": [<copy token_log entries from existing progress.json>]\n`
      : `  "token_log": []\n`) +
    `}\n` +
    `Tier ladder for reviewer_model: haiku->sonnet, sonnet->opus, opus->opus.\n` +
    `phases[].model = the highest-tier model assigned to any task in that phase.`,
    { model: 'claude-haiku-4-5-20251001', label: scaffoldLabel, phase: 'Plan' }
  );

  const reviewerLabel = `plan-reviewer-r${round}`;
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

// Read progress.json ONCE after plan approval. Workflow drives execution from
// this JS state -- no re-reading mid-loop; orchestrator always knows current phase.
const progress = await readProgress('read-progress-init');

if (!progress || !Array.isArray(progress.phases) || progress.phases.length === 0) {
  log('ERROR: progress.json missing or has no phases after plan approval -- aborting');
  return { error: 'empty plan' };
}

const phases = progress.phases;
log(`Executing ${phases.length} phase(s): ${phases.map((p) => `${p.id}:${p.title}`).join(', ')}`);

const MAX_PHASE_ITER = 5;
let allDone = false;

outer: for (const ph of phases) {
  // Case 1 fix: use phases[].model written by scaffold (derived from PLAN.md task
  // models, not relayed through LLM). Same for phases[].reviewer_model.
  const phModel         = ph.model          || 'claude-sonnet-4-6';
  const phReviewerModel = ph.reviewer_model || 'claude-sonnet-4-6';
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

    if (statusUp !== 'VERIFY') {
      log(`Unexpected doer status "${doerResult.status}" in phase ${ph.id} -- stopping phase`);
      break;
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
    log(`Phase ${ph.id} did not pass review after ${MAX_PHASE_ITER} iterations -- continuing to next phase`);
  }
}

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

// Case 3 fix: no tokenLogInstr on the harvest call.
// The harvester git rm's progress.json as part of cleanup -- appending to it
// before removal would either fail or leave stale data in the commit.
// Case 2 fix: HARVEST_SCHEMA already has enum: ['OK', 'FAILED']; belt-and-suspenders
// case-insensitive check below catches any schema bypass.
const harvestLabel = 'harvest';
const harvestResult = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n\n` +
  `The sprint is complete. Harvest the sprint artefacts.\n` +
  `Return status "OK" if all steps completed successfully, "FAILED" otherwise.`,
  { model: 'claude-sonnet-4-6', label: harvestLabel, phase: 'Harvest', schema: HARVEST_SCHEMA, agentType: 'harvester' }
);
logTokens(harvestLabel, 'claude-sonnet-4-6', harvestResult && harvestResult.tokens);

// Case 2 fix: case-insensitive check as belt-and-suspenders alongside enum.
const harvestOk = harvestResult && /^ok$/i.test(harvestResult.status);
if (!harvestOk) {
  log(`Harvest did not complete cleanly (${harvestResult ? harvestResult.status : 'null'}: ${harvestResult && harvestResult.notes ? harvestResult.notes : ''}) -- skipping PR`);
  return { phases: phases.length, allDone, harvest: 'failed' };
}

await agent(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Write a clear title and body summarising what was implemented.`,
  { model: 'claude-sonnet-4-6', label: 'harvest-pr', phase: 'Harvest' }
);

return { phases: phases.length, allDone, harvest: 'ok' };
