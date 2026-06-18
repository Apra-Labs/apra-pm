export const meta = {
  name: 'claude-pm',
  description: 'Deterministic sprint: plan -> execute -> harvest',
  phases: [
    { title: 'Plan' },
    { title: 'Execute' },
    { title: 'Harvest' },
  ],
};

// Generic sprint workflow. Orchestrates the 4 installed agents (planner,
// plan-reviewer, doer, reviewer) against any repo and any requirements.
// The orchestrator is pure control flow -- all policy lives in the agents.
//
// After plan approval, progress.json is read ONCE into JS. The workflow
// drives execution phase-by-phase from that state -- it always knows which
// phase it is in. No re-reading of progress.json mid-loop.
//
// progress.json schema (written by planner):
// {
//   "tasks":     [ { "id": "...", "title": "...", "phase": "1", "status": "pending", "model": "..." } ],
//   "phases":    [ { "id": "1", "title": "...", "reviewer_model": "...", "model": "..." } ],
//   "token_log": []
// }
// phases[].model      -- model for the doer dispatches in this phase
// phases[].reviewer_model -- model for the reviewer after this phase's VERIFY
//
// args:
//   repo         - absolute path to the local git clone (branch already checked out)
//   branch       - sprint branch name
//   requirements - string: what needs to be built (user story, bd list output, etc.)
//   base_branch  - PR target branch (default: main)

const repo = args && args.repo ? args.repo : '';
const branch = args && args.branch ? args.branch : '';
const requirements = args && args.requirements ? args.requirements : '';
const base_branch = (args && args.base_branch) || 'main';

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
  required: ['verdict'],
  properties: {
    verdict: { type: 'string' },
    notes:   { type: 'string' },
    tokens:  TOKENS_SCHEMA,
  },
};

// Doer only needs to report VERIFY or DONE -- the workflow knows which phase
// it is executing, so completed_phase_id is not needed.
const DOER_STATUS_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string' }, // VERIFY | DONE
    notes:  { type: 'string' },
    tokens: TOKENS_SCHEMA,
  },
};

const RAW_JSON_SCHEMA = {
  type: 'object',
  required: ['json'],
  properties: { json: { type: 'string' } },
};

// ------------------------------------------------------------------ helpers

// Read progress.json verbatim via haiku and parse in JS.
// Called once after plan approval; result drives the entire execute phase.
async function readProgress(label) {
  const r = await agent(
    `Read progress.json in repo ${repo} and return its entire raw contents verbatim in the json field. Do not summarise or modify it.`,
    { model: 'claude-haiku-4-5-20251001', label: label || 'read-progress', phase: 'Execute', schema: RAW_JSON_SCHEMA }
  );
  try { return r && r.json ? JSON.parse(r.json) : null; } catch { return null; }
}

function tokenLogInstr(label, model) {
  return (
    `\nWhen done, append one entry to the token_log array in progress.json ` +
    `(read the file first; add the array if missing):\n` +
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

  // Planner decides everything: task count, model per task, model per phase,
  // reviewer_model per phase. The orchestrator enforces no policy here.
  await agent(
    `Repo: ${repo}\nBranch: ${branch}\n` +
    (planFeedback ? `\nPrevious reviewer feedback to address:\n${planFeedback}\n` : '') +
    `\nRequirements are in requirements.md.\n\n` +
    `After committing PLAN.md, create and commit progress.json with this schema:\n` +
    `{\n` +
    `  "tasks":     [ { "id": "...", "title": "...", "phase": "<id>", "status": "pending", "model": "<model-id>" } ],\n` +
    `  "phases":    [ { "id": "<id>", "title": "...", "model": "<model-id>", "reviewer_model": "<model-id>" } ],\n` +
    `  "token_log": []\n` +
    `}\n` +
    `phases[].model is the model for all doer dispatches in that phase.\n` +
    `phases[].reviewer_model is the model for the reviewer after that phase's VERIFY.\n` +
    `Size both to the phase's complexity and risk.` +
    tokenLogInstr(plannerLabel, 'claude-opus-4-8'),
    { model: 'claude-opus-4-8', label: plannerLabel, phase: 'Plan', agentType: 'planner' }
  );

  const reviewerLabel = `plan-reviewer-r${round}`;
  const review = await agent(
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n\n` +
    `Also verify progress.json: each phase has "model" and "reviewer_model" fields sized appropriately; token_log is an empty array.` +
    tokenLogInstr(reviewerLabel, 'claude-sonnet-4-6'),
    { model: 'claude-sonnet-4-6', label: reviewerLabel, phase: 'Plan', schema: REVIEW_SCHEMA, agentType: 'plan-reviewer' }
  );
  logTokens(reviewerLabel, 'claude-sonnet-4-6', review && review.tokens);

  if (approved(review)) {
    planApproved = true;
    log(`Plan APPROVED on round ${round + 1}`);
  } else {
    planFeedback = (review && review.notes) || (review && review.verdict) || '';
    log(`Plan needs changes on round ${round + 1}`);
  }
}

if (!planApproved) {
  log('Plan not approved after 3 rounds -- aborting');
  return { error: 'plan not approved' };
}

// ----------------------------------------------------------------- EXECUTE

phase('Execute');

// Read progress.json ONCE. The workflow drives execution from this JS state.
const progress = await readProgress('read-progress-init');
const phases   = (progress && progress.phases) || [];

if (phases.length === 0) {
  log('No phases found in progress.json -- aborting');
  return { error: 'no phases in plan' };
}

log(`Executing ${phases.length} phase(s): ${phases.map((p) => p.id + ':' + p.title).join(', ')}`);

const MAX_PHASE_ITER = 5; // max doer+reviewer cycles per phase before giving up
let allDone = false;

outer: for (const ph of phases) {
  const phModel         = ph.model          || 'claude-sonnet-4-6';
  const phReviewerModel = ph.reviewer_model || 'claude-sonnet-4-6';
  log(`Phase ${ph.id} "${ph.title}" | doer=${phModel} reviewer=${phReviewerModel}`);

  let phaseApproved = false;
  let iter = 0;

  while (!phaseApproved && iter < MAX_PHASE_ITER) {
    const doerLabel = `doer-p${ph.id}-i${iter}`;
    const doerResult = await agent(
      `Repo: ${repo}\nBranch: ${branch}\n` +
      `Current phase: ${ph.id} - ${ph.title}\n\n` +
      `Execute pending tasks for this phase from PLAN.md.\n` +
      `Stop at the VERIFY checkpoint for this phase and return status VERIFY.\n` +
      `Return status DONE if all tasks across all phases are complete.` +
      tokenLogInstr(doerLabel, phModel),
      { model: phModel, label: doerLabel, phase: 'Execute', schema: DOER_STATUS_SCHEMA, agentType: 'doer' }
    );

    iter++;
    if (!doerResult) break;
    logTokens(doerLabel, phModel, doerResult.tokens);

    if (doerResult.status && doerResult.status.toUpperCase() === 'DONE') {
      log(`All tasks complete (signaled in phase ${ph.id})`);
      allDone = true;
      break outer;
    }

    // At VERIFY: review this phase using the model the planner assigned.
    const reviewerLabel = `reviewer-p${ph.id}-i${iter}`;
    const review = await agent(
      `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
      `Reviewing phase ${ph.id}: ${ph.title}` +
      tokenLogInstr(reviewerLabel, phReviewerModel),
      { model: phReviewerModel, label: reviewerLabel, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
    );
    logTokens(reviewerLabel, phReviewerModel, review && review.tokens);
    log(`Phase ${ph.id} review: ${review && review.verdict ? review.verdict : 'no verdict'}`);

    if (approved(review)) {
      phaseApproved = true;
    }
    // If CHANGES NEEDED, loop: doer picks up fix tasks from progress.json
    // and retries; reviewer re-checks.
  }

  if (!phaseApproved) {
    log(`Phase ${ph.id} did not pass review after ${MAX_PHASE_ITER} iterations -- continuing`);
  }
}

// Final review across all phases before harvest.
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

await agent(
  `Repo: ${repo}\nBranch: ${branch}\n\n` +
  `Sprint is complete. Steps:\n` +
  `1. Read progress.json -- note the token_log for cost summary\n` +
  `2. Update README.md (and CHANGELOG.md if present) to reflect what was implemented\n` +
  `3. Remove scaffold files: git rm -f requirements.md PLAN.md progress.json feedback.md\n` +
  `   (skip any that do not exist)\n` +
  `4. Commit and push: git add -A && git commit -m "docs: harvest - update docs, remove scaffolding" && git push origin ${branch}`,
  { model: 'claude-sonnet-4-6', label: 'harvest-docs', phase: 'Harvest', agentType: 'doer' }
);

await agent(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Write a clear title and body summarising what was implemented.`,
  { model: 'claude-sonnet-4-6', label: 'harvest-pr', phase: 'Harvest' }
);

return { phases: phases.length, allDone };
