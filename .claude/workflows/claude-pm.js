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

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict'],
  properties: {
    verdict: { type: 'string' },
    notes:   { type: 'string' },
  },
};

const DOER_STATUS_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string' },
    notes:  { type: 'string' },
  },
};

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
  // Planner reads requirements.md, explores the repo, writes PLAN.md +
  // initializes progress.json, commits and pushes.
  await agent(
    `Repo: ${repo}\nBranch: ${branch}\n` +
    (planFeedback ? `\nPrevious reviewer feedback to address:\n${planFeedback}\n` : '') +
    `\nRequirements are in requirements.md.\n` +
    `After committing PLAN.md, also create and commit progress.json with all tasks set to status "pending".`,
    { model: 'claude-opus-4-8', label: `planner-r${round}`, phase: 'Plan', agentType: 'planner' }
  );

  const review = await agent(
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}`,
    { model: 'claude-sonnet-4-6', label: `plan-reviewer-r${round}`, phase: 'Plan', schema: REVIEW_SCHEMA, agentType: 'plan-reviewer' }
  );

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

const MAX_ITERATIONS = 50;
let iterations = 0;

for (;;) {
  if (iterations >= MAX_ITERATIONS) {
    log(`Max iterations (${MAX_ITERATIONS}) reached -- stopping`);
    break;
  }

  // Doer picks up the next pending task(s) from progress.json / PLAN.md,
  // implements, commits, and stops at the next VERIFY checkpoint or when done.
  const doerResult = await agent(
    `Repo: ${repo}\nBranch: ${branch}\n\n` +
    `Execute the next pending task(s) from PLAN.md.\n` +
    `Stop at VERIFY checkpoints and return status VERIFY.\n` +
    `Return status DONE only when all tasks in PLAN.md are complete.`,
    { model: 'claude-sonnet-4-6', label: `doer-${iterations}`, phase: 'Execute', schema: DOER_STATUS_SCHEMA, agentType: 'doer' }
  );

  iterations++;
  if (!doerResult) break;

  if (doerResult.status && doerResult.status.toUpperCase() === 'DONE') {
    log('All tasks complete');
    break;
  }

  // At a VERIFY checkpoint: reviewer checks the completed phase.
  const review = await agent(
    `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}`,
    { model: 'claude-sonnet-4-6', label: `reviewer-${iterations}`, phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
  );
  log(`Review: ${review && review.verdict ? review.verdict : 'done'}`);
  // Doer continues from where it left off (progress.json tracks state).
}

// Final review before harvest.
const finalReview = await agent(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}`,
  { model: 'claude-opus-4-8', label: 'final-review', phase: 'Execute', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
);
log(`Final review: ${finalReview && finalReview.verdict ? finalReview.verdict : 'done'}`);

// ---- HARVEST phase ----
phase('Harvest');

// Update project docs to reflect what was implemented, then remove the
// scaffold files. Since they were created on this branch, git rm cancels
// them out in the net base..head diff so they never land in main.
await agent(
  `Repo: ${repo}\nBranch: ${branch}\n\n` +
  `Sprint is complete. Steps:\n` +
  `1. Update README.md (and CHANGELOG.md if present) to reflect what was implemented\n` +
  `2. Remove scaffold files: git rm -f requirements.md PLAN.md progress.json feedback.md\n` +
  `   (skip any that do not exist)\n` +
  `3. Commit and push: git add -A && git commit -m "docs: harvest - update docs, remove scaffolding" && git push origin ${branch}`,
  { model: 'claude-sonnet-4-6', label: 'harvest-docs', phase: 'Harvest', agentType: 'doer' }
);

await agent(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Write a clear title and body summarising what was implemented.`,
  { model: 'claude-sonnet-4-6', label: 'harvest-pr', phase: 'Harvest' }
);

return { iterations };
