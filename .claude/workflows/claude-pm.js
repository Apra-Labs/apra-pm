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
// Model selection is delegated entirely to the planner: it assigns a model
// to every task and a reviewer_model to every phase in progress.json.
// The orchestrator reads these back and dispatches agents accordingly.
//
// progress.json schema (written by planner, maintained throughout):
// {
//   "tasks":     [ { "id": "...", "title": "...", "phase": "1", "status": "pending", "model": "..." } ],
//   "phases":    [ { "id": "1", "title": "...", "reviewer_model": "..." } ],
//   "token_log": [ { "agent": "...", "model": "...", "tokens": { "input": N, "output": N, "cache_read": N } } ]
// }
//
// token_log is the sprint's cost ledger. Every agent appends one entry when
// it finishes. Schema-based agents also return tokens in their structured
// output so the orchestrator can log them immediately.
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

// Tokens sub-schema shared across all structured returns.
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

// Doer returns its stop reason plus the models the orchestrator needs for
// the next dispatch, and its own token spend.
const DOER_STATUS_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status:          { type: 'string' }, // VERIFY | DONE
    notes:           { type: 'string' },
    reviewer_model:  { type: 'string' }, // model for reviewing the just-completed phase
    next_doer_model: { type: 'string' }, // model for the next pending task/phase
    tokens:          TOKENS_SCHEMA,
  },
};

// Used once to bootstrap the first doer model from progress.json.
const FIRST_TASK_SCHEMA = {
  type: 'object',
  required: ['doer_model'],
  properties: {
    doer_model:     { type: 'string' },
    reviewer_model: { type: 'string' },
    tokens:         TOKENS_SCHEMA,
  },
};

// Instruction appended to every agent prompt so each agent writes one
// token_log entry to progress.json when it finishes.
// Schema-based agents additionally return tokens in structured output.
function tokenLogInstr(label, model) {
  return (
    `\nWhen done, append one entry to the token_log array in progress.json ` +
    `(read the file first; if the array does not exist yet, add it):\n` +
    `{"agent":"${label}","model":"${model}","tokens":{"input":<N>,"output":<N>,"cache_read":<N>}}\n` +
    `Estimate input as the total token count of all context/messages you received; ` +
    `output as the total token count of all your responses. ` +
    `Commit progress.json after updating it.`
  );
}

// Log a token entry from a schema return.
function logTokens(label, model, t) {
  if (!t) return;
  log(`tokens ${label} (${model}): in=${t.input || 0} out=${t.output || 0} cache_read=${t.cache_read || 0}`);
}

function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.toUpperCase().includes('APPROVED');
}

// ---- PLAN phase ----
phase('Plan');

// Write requirements.md so the planner can read it from disk.
await agent(
  `In repo ${repo} on branch ${branch}:\n` +
  `Write this content verbatim to requirements.md, then commit and push:\n\n${requirements}`,
  { model: 'claude-haiku-4-5-20251001', label: 'write-requirements', phase: 'Plan' }
);

let planFeedback = '';
let planApproved = false;

for (let round = 0; round < 3 && !planApproved; round++) {
  const plannerLabel = `planner-r${round}`;

  // Planner reads requirements.md, explores the repo, writes PLAN.md and
  // progress.json (with the schema above, including token_log: []), commits, pushes.
  // Model assignments: each task gets a model sized to its complexity;
  // each phase gets a reviewer_model sized to the phase's complexity and risk.
  await agent(
    `Repo: ${repo}\nBranch: ${branch}\n` +
    (planFeedback ? `\nPrevious reviewer feedback to address:\n${planFeedback}\n` : '') +
    `\nRequirements are in requirements.md.\n\n` +
    `After committing PLAN.md, create and commit progress.json with this exact schema:\n` +
    `{\n` +
    `  "tasks":  [ { "id": "...", "title": "...", "phase": "<id>", "status": "pending", "model": "<model-id>" } ],\n` +
    `  "phases": [ { "id": "<id>", "title": "...", "reviewer_model": "<model-id>" } ],\n` +
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
    `Verify progress.json has the correct schema: tasks carry a "model" field, ` +
    `phases carry a "reviewer_model" field, and the model choices are appropriately sized. ` +
    `Also verify token_log exists as an empty array.` +
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

// ---- EXECUTE phase ----
phase('Execute');

// Bootstrap: read the first task's model from the approved progress.json.
const bootstrapLabel = 'bootstrap-models';
const firstTask = await agent(
  `Read progress.json in repo ${repo}.\n` +
  `Return:\n` +
  `- doer_model: the model field of the first pending task\n` +
  `- reviewer_model: the reviewer_model of its phase` +
  tokenLogInstr(bootstrapLabel, 'claude-haiku-4-5-20251001'),
  { model: 'claude-haiku-4-5-20251001', label: bootstrapLabel, phase: 'Execute', schema: FIRST_TASK_SCHEMA }
);
logTokens(bootstrapLabel, 'claude-haiku-4-5-20251001', firstTask && firstTask.tokens);

let doerModel     = (firstTask && firstTask.doer_model)     || 'claude-sonnet-4-6';
let reviewerModel = (firstTask && firstTask.reviewer_model) || 'claude-sonnet-4-6';
log(`First doer: ${doerModel} | first reviewer: ${reviewerModel}`);

const MAX_ITERATIONS = 50;
let iterations = 0;

for (;;) {
  if (iterations >= MAX_ITERATIONS) {
    log(`Max iterations (${MAX_ITERATIONS}) reached -- stopping`);
    break;
  }

  const doerLabel = `doer-${iterations}`;

  // Doer picks up the next pending task(s) from progress.json / PLAN.md,
  // implements, commits, and stops at the next VERIFY checkpoint or when done.
  const doerResult = await agent(
    `Repo: ${repo}\nBranch: ${branch}\n\n` +
    `Execute the next pending task(s) from PLAN.md.\n` +
    `Stop at VERIFY checkpoints and return status VERIFY.\n` +
    `Return status DONE only when all tasks in PLAN.md are complete.\n` +
    `Also return:\n` +
    `- reviewer_model: the reviewer_model for the just-completed phase (from progress.json)\n` +
    `- next_doer_model: the model for the next pending task (from progress.json), if any` +
    tokenLogInstr(doerLabel, doerModel),
    { model: doerModel, label: doerLabel, phase: 'Execute', schema: DOER_STATUS_SCHEMA, agentType: 'doer' }
  );

  iterations++;
  if (!doerResult) break;

  logTokens(doerLabel, doerModel, doerResult.tokens);

  // Update models from what the planner chose -- no hardcoding.
  if (doerResult.reviewer_model)  reviewerModel = doerResult.reviewer_model;
  if (doerResult.next_doer_model) doerModel     = doerResult.next_doer_model;

  if (doerResult.status && doerResult.status.toUpperCase() === 'DONE') {
    log('All tasks complete');
    break;
  }

  // At a VERIFY checkpoint: reviewer checks the completed phase.
  const reviewerLabel = `reviewer-${iterations}`;
  const review = await agent(
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}` +
    tokenLogInstr(reviewerLabel, reviewerModel),
    { model: reviewerModel, label: reviewerLabel, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
  );
  logTokens(reviewerLabel, reviewerModel, review && review.tokens);
  log(`Review: ${review && review.verdict ? review.verdict : 'done'}`);
}

// Final review before harvest.
const finalReviewLabel = 'final-review';
const finalReview = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}` +
  tokenLogInstr(finalReviewLabel, 'claude-opus-4-8'),
  { model: 'claude-opus-4-8', label: finalReviewLabel, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
);
logTokens(finalReviewLabel, 'claude-opus-4-8', finalReview && finalReview.tokens);
log(`Final review: ${finalReview && finalReview.verdict ? finalReview.verdict : 'done'}`);

// ---- HARVEST phase ----
phase('Harvest');

// Update project docs to reflect what was implemented. Read token_log from
// progress.json and include a cost summary in the PR body before removing it.
// git rm cancels out scaffold files in the net base..head diff.
const harvestLabel = 'harvest-docs';
await agent(
  `Repo: ${repo}\nBranch: ${branch}\n\n` +
  `Sprint is complete. Steps:\n` +
  `1. Read progress.json -- note the token_log for the cost summary\n` +
  `2. Update README.md (and CHANGELOG.md if present) to reflect what was implemented\n` +
  `3. Remove scaffold files: git rm -f requirements.md PLAN.md progress.json feedback.md\n` +
  `   (skip any that do not exist)\n` +
  `4. Commit and push: git add -A && git commit -m "docs: harvest - update docs, remove scaffolding" && git push origin ${branch}`,
  { model: 'claude-sonnet-4-6', label: harvestLabel, phase: 'Harvest', agentType: 'doer' }
);

await agent(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Write a clear title and body summarising what was implemented.`,
  { model: 'claude-sonnet-4-6', label: 'harvest-pr', phase: 'Harvest' }
);

return { iterations };
