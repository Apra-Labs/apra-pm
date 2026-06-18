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
// Model selection is delegated to the planner via progress.json, then
// resolved deterministically in JS -- never by asking an LLM to relay
// a value it read from a file.
//
// progress.json schema (written by planner, maintained throughout):
// {
//   "tasks":     [ { "id": "...", "title": "...", "phase": "1", "status": "pending", "model": "..." } ],
//   "phases":    [ { "id": "1", "title": "...", "reviewer_model": "..." } ],
//   "token_log": [ { "agent": "...", "model": "...", "tokens": { "input": N, "output": N, "cache_read": N } } ]
// }
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

// Doer returns its stop reason and -- at VERIFY -- the phase id it just
// completed so the orchestrator can look up the right reviewer model from
// progress.json. No model strings: those are read deterministically from
// the file, never relayed by the LLM.
const DOER_STATUS_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status:             { type: 'string' }, // VERIFY | DONE
    completed_phase_id: { type: 'string' }, // phase id that just hit VERIFY
    notes:              { type: 'string' },
    tokens:             TOKENS_SCHEMA,
  },
};

// Raw file read schema -- the LLM copies the file verbatim; JS parses it.
const RAW_JSON_SCHEMA = {
  type: 'object',
  required: ['json'],
  properties: { json: { type: 'string' } },
};

// ----------------------------------------------------------- JS helpers

// Read progress.json from disk via a cheap haiku call and parse it in JS.
// Model selection is done here, never by asking the LLM to relay values.
async function readProgress(label) {
  const r = await agent(
    `Read the file progress.json in repo ${repo} and return its entire raw contents verbatim in the json field. Do not summarise or modify it.`,
    { model: 'claude-haiku-4-5-20251001', label: label || 'read-progress', phase: 'Execute', schema: RAW_JSON_SCHEMA }
  );
  try { return r && r.json ? JSON.parse(r.json) : null; } catch { return null; }
}

function nextPendingModel(progress) {
  const t = progress && progress.tasks && progress.tasks.find((t) => t.status === 'pending');
  return (t && t.model) || null;
}

function phaseReviewerModel(progress, phaseId) {
  const p = progress && progress.phases && progress.phases.find((p) => p.id === phaseId);
  return (p && p.reviewer_model) || null;
}

// Instruction appended to every agent prompt so each agent appends one
// token_log entry to progress.json when it finishes. Best-effort logging;
// schema-based agents also return tokens in structured output for immediate
// orchestrator visibility.
function tokenLogInstr(label, model) {
  return (
    `\nWhen done, append one entry to the token_log array in progress.json ` +
    `(read the file first; add the array if it does not exist):\n` +
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

// ----------------------------------------------------------------- PLAN

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

  await agent(
    `Repo: ${repo}\nBranch: ${branch}\n` +
    (planFeedback ? `\nPrevious reviewer feedback to address:\n${planFeedback}\n` : '') +
    `\nRequirements are in requirements.md.\n\n` +
    `After committing PLAN.md, create and commit progress.json with this exact schema:\n` +
    `{\n` +
    `  "tasks":     [ { "id": "...", "title": "...", "phase": "<id>", "status": "pending", "model": "<model-id>" } ],\n` +
    `  "phases":    [ { "id": "<id>", "title": "...", "reviewer_model": "<model-id>" } ],\n` +
    `  "token_log": []\n` +
    `}\n` +
    `Assign each task a model sized to its complexity.\n` +
    `Assign each phase a reviewer_model sized to the phase's complexity and risk.` +
    tokenLogInstr(plannerLabel, 'claude-opus-4-8'),
    { model: 'claude-opus-4-8', label: plannerLabel, phase: 'Plan', agentType: 'planner' }
  );

  const reviewerLabel = `plan-reviewer-r${round}`;
  const review = await agent(
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n\n` +
    `Also verify progress.json matches the required schema: tasks have a "model" field, ` +
    `phases have a "reviewer_model" field, token_log is an empty array.` +
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

// --------------------------------------------------------------- EXECUTE

phase('Execute');

// Read progress.json once after plan approval; derive all models in JS.
let progress    = await readProgress('read-progress-init');
let doerModel    = nextPendingModel(progress)    || 'claude-sonnet-4-6';
let reviewerModel = 'claude-sonnet-4-6'; // updated from progress.json after each VERIFY
log(`First doer model: ${doerModel}`);

const MAX_ITERATIONS = 50;
let iterations = 0;

for (;;) {
  if (iterations >= MAX_ITERATIONS) {
    log(`Max iterations (${MAX_ITERATIONS}) reached -- stopping`);
    break;
  }

  const doerLabel = `doer-${iterations}`;
  const doerResult = await agent(
    `Repo: ${repo}\nBranch: ${branch}\n\n` +
    `Execute the next pending task(s) from PLAN.md.\n` +
    `Stop at VERIFY checkpoints and return status VERIFY with the completed_phase_id.\n` +
    `Return status DONE only when all tasks in PLAN.md are complete.` +
    tokenLogInstr(doerLabel, doerModel),
    { model: doerModel, label: doerLabel, phase: 'Execute', schema: DOER_STATUS_SCHEMA, agentType: 'doer' }
  );

  iterations++;
  if (!doerResult) break;
  logTokens(doerLabel, doerModel, doerResult.tokens);

  if (doerResult.status && doerResult.status.toUpperCase() === 'DONE') {
    log('All tasks complete');
    break;
  }

  // Read progress.json in JS; derive both models deterministically.
  progress = await readProgress(`read-progress-${iterations}`);
  reviewerModel = phaseReviewerModel(progress, doerResult.completed_phase_id) || reviewerModel;
  doerModel     = nextPendingModel(progress) || doerModel;

  const reviewerLabel = `reviewer-${iterations}`;
  const review = await agent(
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}` +
    tokenLogInstr(reviewerLabel, reviewerModel),
    { model: reviewerModel, label: reviewerLabel, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
  );
  logTokens(reviewerLabel, reviewerModel, review && review.tokens);
  log(`Review: ${review && review.verdict ? review.verdict : 'done'}`);
}

const finalReviewLabel = 'final-review';
const finalReview = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}` +
  tokenLogInstr(finalReviewLabel, 'claude-opus-4-8'),
  { model: 'claude-opus-4-8', label: finalReviewLabel, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
);
logTokens(finalReviewLabel, 'claude-opus-4-8', finalReview && finalReview.tokens);
log(`Final review: ${finalReview && finalReview.verdict ? finalReview.verdict : 'done'}`);

// --------------------------------------------------------------- HARVEST

phase('Harvest');

await agent(
  `Repo: ${repo}\nBranch: ${branch}\n\n` +
  `Sprint is complete. Steps:\n` +
  `1. Read progress.json -- note the token_log summary\n` +
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

return { iterations };
