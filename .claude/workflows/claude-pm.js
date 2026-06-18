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
// Full model IDs used throughout (canonical, never hallucinated):
//   haiku  -> claude-haiku-4-5-20251001
//   sonnet -> claude-sonnet-4-6
//   opus   -> claude-opus-4-8
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

// Case 21 fix: enum on verdict + exact match in approved() below.
// notes is required -- CHANGES NEEDED without actionable notes is useless.
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES NEEDED'] },
    notes:   { type: 'string' },
    tokens:  TOKENS_SCHEMA,
  },
};

// Case 17 fix: doer always returns VERIFY (per phase). DONE removed from
// the schema -- the orchestrator detects sprint completion when the outer
// loop finishes normally (no phase aborted). This eliminates the impossible
// choice the doer faced on the last phase (return VERIFY or DONE?).
const DOER_STATUS_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['VERIFY'] },
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

// Case 2 (prior): enum forces exactly "OK" or "FAILED".
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

// Case 25 fix: distinguish parse failure from missing file; log raw prefix on error.
// Called once after plan approval; drives the entire execute phase.
async function readProgress(label) {
  const r = await agent(
    `Read progress.json in repo ${repo} and return its entire raw contents verbatim in the json field. Do not summarise or modify it.`,
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

// Appended to reviewer/plan-reviewer/scaffold prompts to log token usage.
// NOT appended to planner (progress.json written by scaffold AFTER planner --
// appending before scaffold would be overwritten; Case 19).
// NOT appended to doer (doer writes progress.json in its own VERIFY commit;
// a post-STOP second write is contradictory; Case 18).
// NOT appended to harvester (harvester git rm's progress.json; Case 3).
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

// Case 21 fix: exact match, not substring. Enum already constrains the value;
// this guards against any schema bypass.
function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.trim() === 'APPROVED';
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

  // Case 4 (prior): planner only writes PLAN.md (per planner.md design).
  // Case 5 (prior): do NOT ask planner to assign reviewer_model.
  // Case 19 fix: no tokenLogInstr on planner -- scaffold overwrites progress.json
  //              after the planner runs, destroying any token_log the planner wrote.
  // Case 20 fix: capture planner result; abort round if null.
  const plannerResult = await agent(
    `Repo: ${repo}\nBranch: ${branch}\n` +
    (planFeedback ? `\nPrevious reviewer feedback to address:\n${planFeedback}\n` : '') +
    `\nRequirements are in requirements.md.\n\n` +
    `Produce PLAN.md with phases and tasks. Assign each task a concrete model sized to its complexity.\n` +
    `Use only these exact full model IDs: claude-haiku-4-5-20251001 (simple), claude-sonnet-4-6 (moderate), claude-opus-4-8 (complex).\n` +
    `Each phase MUST end with a task of type "verify" -- the doer stops there and the orchestrator\n` +
    `runs a reviewer before the next phase. Without a verify task the phase has no review gate.\n` +
    `Commit and push PLAN.md. A separate scaffold step will create progress.json from it.\n` +
    `Respond with any text to confirm completion.`,
    { model: 'claude-opus-4-8', label: plannerLabel, phase: 'Plan', agentType: 'planner' }
  );

  // Case 20 fix: planner null means PLAN.md was not written; skip to next round.
  if (!plannerResult) {
    log(`Planner returned null on round ${round} -- skipping to next round`);
    continue;
  }

  // Case 4 (prior) + Case 19 fix: scaffold reads PLAN.md, creates progress.json.
  // Case 27 fix: provide explicit full model ID table and tier ordering so scaffold
  //              never emits short names or hallucinated IDs.
  // Case 19 fix: on re-rounds, scaffold preserves existing token_log entries.
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

  // Case 20 fix: scaffold null means progress.json was not written.
  if (!scaffoldResult) {
    log(`Scaffold returned null on round ${round} -- skipping to next round`);
    continue;
  }

  const reviewerLabel = `plan-reviewer-r${round}`;
  const review = await agent(
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n\n` +
    `Verify PLAN.md and progress.json.\n` +
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

// Read progress.json ONCE after plan approval. Workflow drives execution from
// this JS state -- no re-reading mid-loop; orchestrator always knows current phase.
const progress = await readProgress('read-progress-init');

if (!progress || !Array.isArray(progress.phases) || progress.phases.length === 0) {
  log('ERROR: progress.json missing, unreadable, or has no phases -- aborting');
  return { error: 'empty plan' };
}

const phases = progress.phases;
log(`Executing ${phases.length} phase(s): ${phases.map((p) => `${p.id}:${p.title}`).join(', ')}`);

const MAX_PHASE_ITER = 5;
// Case 17 fix: allDone set true when outer loop finishes normally (all phases approved).
// Never set by doer -- doer always returns VERIFY.
let allDone = false;
let abortedPhase = null;

outer: for (const ph of phases) {
  // Case 27 fix: validate model IDs from scaffold; fall back with a warning.
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
    // Case 17 fix: doer always returns VERIFY; completion detected by outer loop.
    // Case 18 fix: no tokenLogInstr -- doer writes progress.json in its VERIFY commit.
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

    // Case 24 fix: null doer is an infrastructure failure; abort sprint (break outer).
    if (!doerResult) {
      log(`Doer returned null in phase ${ph.id} iteration ${iter} -- aborting sprint`);
      abortedPhase = ph.id;
      break outer;
    }
    logTokens(doerLabel, phModel, doerResult.tokens);

    const statusUp = doerResult.status ? doerResult.status.toUpperCase() : '';

    // Case 24 fix: unexpected status is also an infrastructure failure.
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

  // Case 23 fix: a phase that exhausts MAX_PHASE_ITER is a broken foundation;
  // building later phases on top of it produces a confidently-wrong PR. Abort.
  if (!phaseApproved) {
    log(`Phase ${ph.id} did not pass review after ${MAX_PHASE_ITER} iterations -- aborting sprint`);
    abortedPhase = ph.id;
    break outer;
  }
}

// Case 17 fix: allDone true iff all phases passed (outer loop finished without break).
if (!abortedPhase) {
  allDone = true;
}

// Case 22 fix: gate harvest on final review; CHANGES-NEEDED = do not proceed.
const finalReviewLabel = 'final-review';
const finalReview = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  (abortedPhase ? `Note: sprint was aborted at phase ${abortedPhase}. Review what was completed.\n` : '') +
  tokenLogInstr(finalReviewLabel, 'claude-opus-4-8'),
  { model: 'claude-opus-4-8', label: finalReviewLabel, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
);
logTokens(finalReviewLabel, 'claude-opus-4-8', finalReview && finalReview.tokens);
log(`Final review: ${finalReview && finalReview.verdict ? finalReview.verdict : 'no verdict'}`);

// Case 22 fix: do not harvest or open a PR if final review not approved.
if (!approved(finalReview)) {
  const notes = (finalReview && finalReview.notes) || '';
  log(`Final review not approved -- aborting before harvest. Notes: ${notes.slice(0, 200)}`);
  return { phases: phases.length, allDone, harvest: 'skipped', finalReviewNotes: notes };
}

// ----------------------------------------------------------------- HARVEST

phase('Harvest');

// Case 3 (prior): no tokenLogInstr -- harvester git rm's progress.json.
// Case 26 fix: pass final review notes to harvester so it can include them in
//              docs/CHANGELOG before deleting feedback.md; they are not persisted
//              anywhere else and would otherwise be lost.
const harvestLabel = 'harvest';
const harvestResult = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n\n` +
  `The sprint is complete. Harvest the sprint artefacts.\n` +
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

// Case 26 fix: pass final review notes into the PR prompt; feedback.md is already
// deleted by the harvester so the PR agent cannot read it.
await agent(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Write a clear title and body summarising what was implemented.\n` +
  `Include this context from the final review in the PR body:\n` +
  `${(finalReview && finalReview.notes) || '(none)'}`,
  { model: 'claude-sonnet-4-6', label: 'harvest-pr', phase: 'Harvest' }
);

return { phases: phases.length, allDone, harvest: 'ok' };
