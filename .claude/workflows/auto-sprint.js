export const meta = {
  name: 'auto-sprint',
  description: 'Multi-cycle sprint: plan -> develop -> test -> harvest until goal met',
  phases: [
    { title: 'Plan' },
    { title: 'Develop' },
    { title: 'Test' },
    { title: 'Harvest' },
  ],
};

// Multi-cycle sprint workflow. Drives 8 agents against a beads backlog until a
// priority-based quality goal is met or the cycle ceiling is reached.
//
// Agent roster:
//   planner           -- reads open beads epics/features/bugs, creates feature+task DAG
//   plan-reviewer     -- validates DAG: coverage, task size, acceptance criteria
//   doer              -- works bd-ready tasks (impl and test-dev), VERIFY checkpoint
//   reviewer          -- reviews doer output, can reopen tasks
//   deployer          -- follows deploy.md + integ-test-playbook.md (setup/reset/teardown)
//   integ-test-runner -- executes tests, closes features, files bugs/enhancements
//   ci-watcher        -- polls CI; creates beads task if not configured
//   harvester         -- docs, CHANGELOG, token summary, PR
//
// Beads owns all work items and is the exit signal.
// JS workflow owns all routing. No LLM ever decides whether to continue.
//
// args (JSON object serialised to string by the Workflow runtime):
//   branch           -- sprint branch (required); asserted/created at startup
//   issues           -- beads epic IDs to implement, e.g. ["BD-1","BD-2"] (required)
//   goal             -- exit criterion: "P1" | "P1/P2" | "P1/P2/P3"  (default: "P1/P2")
//   max_cycles       -- hard ceiling on sprint cycles                  (default: 5)
//   requirementsFile -- optional context file for the planner          (default: none)
//   base_branch      -- PR target                                      (default: "main")

let opts = {};
if (args) {
  try {
    const parsed = JSON.parse(args);
    opts = (parsed && typeof parsed === 'object') ? parsed : { branch: String(parsed) };
  } catch (e) {
    opts = { branch: String(args) };
  }
}

const branch           = opts.branch           || '';
const rawIssues        = opts.issues            || [];
const epicIds          = Array.isArray(rawIssues) ? rawIssues : [rawIssues];
const goal             = opts.goal             || 'P1/P2';
const maxCycles        = Number(opts.max_cycles) || 5;
const requirementsFile = opts.requirementsFile  || '';
const base_branch      = opts.base_branch       || 'main';

if (!branch) {
  log('ERROR: branch is required');
  return { error: 'missing branch' };
}
if (epicIds.length === 0) {
  log('ERROR: at least one beads issue ID is required in args.issues');
  return { error: 'missing issues' };
}

// Goal -> numeric priority threshold.
// Exit when open issues in epic subtree at priority <= threshold reaches zero.
const GOAL_THRESHOLD = { 'P1': 1, 'P1/P2': 2, 'P1/P2/P3': 3 };
const threshold = GOAL_THRESHOLD[goal] || 2;

// ------------------------------------------------------------------ models

const MODEL_OPUS   = 'claude-opus-4-8';
const MODEL_SONNET = 'claude-sonnet-4-6';
const MODEL_HAIKU  = 'claude-haiku-4-5-20251001';

// ------------------------------------------------------------------ schemas

const REVIEW_SCHEMA = {
  type: 'object', required: ['verdict', 'notes'],
  properties: {
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES NEEDED'] },
    notes:   { type: 'string' },
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

const SETUP_SCHEMA = {
  type: 'object', required: ['repo', 'branch', 'deployMdExists', 'playbookExists'],
  properties: {
    repo:           { type: 'string' },
    branch:         { type: 'string' },
    deployMdExists: { type: 'boolean' },
    playbookExists: { type: 'boolean' },
  },
};

const BEADS_BLOCKERS_SCHEMA = {
  type: 'object', required: ['count', 'ids'],
  properties: {
    count: { type: 'number' },
    ids:   { type: 'array', items: { type: 'string' } },
  },
};

// One entry per model streak: tasks sharing the same model that can be worked
// in a single doer dispatch. Ordered by priority (P0 first).
const READY_STREAKS_SCHEMA = {
  type: 'object', required: ['streaks', 'totalCount'],
  properties: {
    totalCount: { type: 'number' },
    streaks: {
      type: 'array',
      items: {
        type: 'object', required: ['model', 'ids'],
        properties: {
          model: { type: 'string' },
          ids:   { type: 'array', items: { type: 'string' } },
        },
      },
    },
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

// Returned by the resume-check agent at the top of every cycle.
// planDone   -- true if the epic already has features AND every feature has at
//               least one task with non-empty acceptance criteria; skip plan loop.
// inProgressIds -- tasks currently in_progress; reset to open before the develop
//                  loop so a crashed doer never orphans work forever.
const CYCLE_STATE_SCHEMA = {
  type: 'object', required: ['planDone', 'inProgressIds'],
  properties: {
    planDone:       { type: 'boolean' },
    inProgressIds:  { type: 'array', items: { type: 'string' } },
  },
};

// ------------------------------------------------------------------ helpers

function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.trim() === 'APPROVED';
}

// Real output-token tracking via differential budget.spent() snapshots.
// budget.spent() is the only actual usage the workflow harness exposes;
// it counts output tokens across the whole workflow run.
let cycleOutputTokens = 0;

async function dispatch(prompt, opts) {
  const before = budget.spent();
  const result = await dispatch(prompt, opts);
  const out = budget.spent() - before;
  cycleOutputTokens += out;
  if (out > 0) log(`tokens ${opts.label || '?'} (${opts.model || '?'}): output=${out}`);
  return result;
}


async function countBeadsBlockers(thr, epics) {
  const epicList = epics.join(' ');
  const r = await dispatch(
    `Run: bd list --status=open\n` +
    `From that output, identify all issues that are either:\n` +
    `  (a) one of these epics: ${epicList}, or a descendant of them (run bd show <id> to check), or\n` +
    `  (b) have a title containing "[integ]" (created by integration testing this sprint).\n` +
    `Count only those with priority 0 through ${thr} (P0 to P${thr}).\n` +
    `Return count (integer) and their beads IDs as an array.`,
    { model: MODEL_HAIKU, label: 'check-blockers', schema: BEADS_BLOCKERS_SCHEMA }
  );
  return r || { count: 999, ids: [] };
}

async function getReadyStreaks() {
  const r = await dispatch(
    `Run these three commands to fetch ready tasks grouped by assigned model:\n` +
    `  bd list --ready --type=task --metadata-field model=${MODEL_HAIKU} --json\n` +
    `  bd list --ready --type=task --metadata-field model=${MODEL_SONNET} --json\n` +
    `  bd list --ready --type=task --metadata-field model=${MODEL_OPUS} --json\n` +
    `Also run: bd list --ready --type=task --json\n` +
    `  Any task ID in that last list but absent from the three model lists has no model\n` +
    `  assigned; default those to "${MODEL_SONNET}".\n\n` +
    `Build the streaks array: one entry per non-empty model group.\n` +
    `Within each streak order IDs by priority (P0 first).\n` +
    `Order streaks by the highest priority task they contain (P0 first).\n` +
    `totalCount = total number of ready tasks across all streaks.`,
    { model: MODEL_HAIKU, label: 'ready-streaks', schema: READY_STREAKS_SCHEMA }
  );
  return r || { totalCount: 0, streaks: [] };
}

async function commitFeedback(repo, branch, notes, role, label, phase) {
  await dispatch(
    `Repo: ${repo}\nBranch: ${branch}\n\n` +
    `Write the following reviewer feedback to feedback.md (overwrite if it exists):\n\n` +
    `${notes}\n\n` +
    `Then commit and push:\n` +
    `  git -C ${repo} add feedback.md\n` +
    `  git -C ${repo} -c user.name='${role}' -c user.email='${role}@pm.local' commit -m "feedback: ${label}"\n` +
    `  git -C ${repo} push origin ${branch}`,
    { model: MODEL_HAIKU, label: `feedback-commit-${label}`, phase }
  );
}

async function checkCycleState(epicIds) {
  const showCmds = epicIds.map(id => `bd show ${id}`).join('\n');
  const graphCmds = epicIds.map(id => `bd graph --compact ${id}`).join('\n');
  const r = await dispatch(
    `Run each of these to inspect the sprint epics and their full dependency subtrees:\n` +
    `${showCmds}\n` +
    `${graphCmds}\n` +
    `Run: bd list --status=in_progress\n\n` +
    `From those outputs answer:\n\n` +
    `planDone: true if ALL of the following hold --\n` +
    `  - At least one type=feature issue appears in the dependency graph of each epic\n` +
    `  - Every open feature has at least one type=task in its dependency graph\n` +
    `  - Every task has a non-empty description (acceptance criteria present)\n` +
    `  Set false if any of these conditions are not met.\n\n` +
    `inProgressIds: list the IDs of ALL issues currently in_progress status.\n` +
    `  These are orphaned from a previous crashed run and must be reset before work resumes.`,
    { model: MODEL_HAIKU, label: 'cycle-state', schema: CYCLE_STATE_SCHEMA }
  );
  return r || { planDone: false, inProgressIds: [] };
}

// ------------------------------------------------------------------ SETUP

phase('Plan');

const setup = await dispatch(
  `Sprint workspace setup.\n\n` +
  `Step 1: Get repo root.\n` +
  `  Run: git rev-parse --show-toplevel\n\n` +
  `Step 2: Assert sprint branch "${branch}".\n` +
  `  - Already on "${branch}": do nothing.\n` +
  `  - Exists locally: git checkout "${branch}"\n` +
  `  - Exists on origin: git checkout --track origin/"${branch}"\n` +
  `  - Otherwise: git checkout -b "${branch}"\n\n` +
  `Step 3: Check for required project files.\n` +
  `  Run: test -f deploy.md && echo YES || echo NO   -> deployMdExists\n` +
  `  Run: test -f integ-test-playbook.md && echo YES || echo NO  -> playbookExists\n\n` +
  `Step 4: Merge deploy permissions into .claude/settings.json.\n` +
  `  For each of deploy.md and integ-test-playbook.md that exists:\n` +
  `    a. Read the file and extract lines under the "## Permissions" section\n` +
  `       (stop at the next ## heading). Each non-empty line is a permission entry\n` +
  `       such as "Bash(docker *)" or "Bash(npm run *)".\n` +
  `    b. Read .claude/settings.json (create it as {} if absent).\n` +
  `    c. For each extracted permission not already in permissions.allow, add it.\n` +
  `    d. Write the updated .claude/settings.json back.\n` +
  `  If neither file has a ## Permissions section, skip this step.\n\n` +
  `Return repo (absolute path), branch (confirmed), deployMdExists, playbookExists.`,
  { model: MODEL_HAIKU, label: 'setup', phase: 'Plan', schema: SETUP_SCHEMA }
);

if (!setup || !setup.repo || !setup.branch) {
  log('ERROR: setup failed -- could not assert branch or locate repo');
  return { error: 'setup failed' };
}

const repo = setup.repo;
const integTestEnabled = setup.deployMdExists && setup.playbookExists;

log(`Repo: ${repo} | Branch: ${setup.branch}`);
log(`deploy.md: ${setup.deployMdExists} | integ-test-playbook.md: ${setup.playbookExists}`);
if (!setup.deployMdExists) log('WARNING: deploy.md not found -- integration test phase will be skipped');
if (!setup.playbookExists) log('WARNING: integ-test-playbook.md not found -- integration test phase will be skipped');
if (!integTestEnabled) log('Integration testing disabled for this sprint. Harvest will run after Develop.');

const epicSummary = epicIds.join(', ');
log(`Epics: ${epicSummary} | Goal: ${goal} (P<=${threshold}) | Max cycles: ${maxCycles}`);

// ------------------------------------------------------------------ EPIC LOOP

let cycleCount   = 0;
let epicDone     = false;
let prevOpenIds  = [];
let headSha      = '';
let abortReason  = '';



while (cycleCount < maxCycles) {
  cycleCount++;
  cycleOutputTokens = 0;
  log(`\n=== Cycle ${cycleCount}/${maxCycles} | goal: ${goal} ===`);

  // ---------------------------------------------------------------- RESUME CHECK

  phase('Plan');

  const cycleState = await checkCycleState(epicIds);
  log(`Cycle state: planDone=${cycleState.planDone} inProgress=[${cycleState.inProgressIds.join(', ')}]`);

  // Reset any tasks orphaned in_progress from a previous crashed run.
  if (cycleState.inProgressIds.length > 0) {
    log(`Resetting ${cycleState.inProgressIds.length} orphaned in_progress task(s) to open`);
    for (const id of cycleState.inProgressIds) {
      await dispatch(
        `Run: bd update ${id} --status=open`,
        { model: MODEL_HAIKU, label: `reset-${id}`, phase: 'Plan' }
      );
    }
  }

  // ---------------------------------------------------------------- PLAN

  let planApproved = cycleState.planDone;
  let planFeedback = '';
  const MAX_PLAN_ITER = 3;

  if (planApproved) {
    log(`Plan already complete -- skipping plan loop for cycle ${cycleCount}`);
  }

  for (let pi = 0; pi < MAX_PLAN_ITER && !planApproved; pi++) {
    const plannerLabel = `planner-c${cycleCount}-r${pi}`;

    const plannerResult = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
      `Sprint epics: ${epicSummary}\n` +
      (requirementsFile ? `Additional context: ${requirementsFile}\n` : '') +
      `\n` +
      (planFeedback
        ? `Plan-reviewer feedback from the previous round (read feedback.md in ${repo} for full details):\n${planFeedback}\nAddress every item before proceeding.\n\n`
        : '') +
      `Inspect existing state first:\n` +
      `  ${epicIds.map(id => `bd show ${id} && bd graph --compact ${id}`).join('\n  ')}\n` +
      `Run: bd show <id> on any existing features/tasks to read their current descriptions.\n` +
      `Then build or complete the feature+task DAG -- create only what is missing:\n` +
      `  - BEFORE creating any feature or task, run: bd search "<title>" --status all\n` +
      `    If a matching issue already exists, update it instead of creating a duplicate.\n` +
      `\n` +
      `DEPENDENCY WIRING -- read this carefully. "bd dep add A B" means A CANNOT CLOSE until B is done.\n` +
      `The correct wiring direction is: parents depend on children (children unblock first).\n` +
      `\n` +
      `  Step 1 -- wire epic -> feature (epic waits for features):\n` +
      `    bd dep add <epic-id> <feature-id>\n` +
      `    After this: "bd ready" will NOT show the epic (it's waiting). Features show as ready.\n` +
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
      `  VERIFY after wiring: run "bd ready" -- it must return impl tasks, NOT features or epics.\n` +
      `  If features appear in "bd ready" the deps are backwards -- fix them before continuing.\n` +
      `\n` +
      `  IMPORTANT: Each task belongs to exactly ONE feature. Never share a task across features.\n` +
      `\n` +
      `  Create type=feature issues as children of each epic (use bd dep add epic feature per above).\n` +
      `  Create type=task issues for each feature: implementation tasks AND integration\n` +
      `    test development tasks (prefix test tasks with "[test]" in the title)\n` +
      `  Features P1/P2; tasks one level below their parent feature (P1 feature -> P2 tasks, P2 feature -> P3 tasks)\n` +
      `  Each task must be completable in one agent session (1-3 file changes max)\n` +
      `  Every task needs clear acceptance criteria in its description\n` +
      `  - Assign each task a model based on complexity -- after creating or updating each\n` +
      `    task, run: bd update <id> --set-metadata model=<model-id>\n` +
      `    Available models and when to use them:\n` +
      `      ${MODEL_HAIKU}  -- mechanical work: rename, config tweak, move file, simple wiring\n` +
      `      ${MODEL_SONNET} -- standard work: new function, test suite, API endpoint, refactor\n` +
      `      ${MODEL_OPUS}   -- hard work: architecture, multi-file design, ambiguous requirements\n` +
      `  - Group tasks so consecutive tasks in dependency order share a model where\n` +
      `    possible -- this minimises model-switching overhead during execution\n` +
      (cycleCount > 1
        ? `This is cycle ${cycleCount}. Focus on open issues only.\n` +
          `Do NOT add new scope beyond the original epics and open bugs/enhancements.\n` +
          `Do NOT re-create tasks that are already closed.\n`
        : '') +
      `Confirm with any text when done.`,
      { model: MODEL_OPUS, label: plannerLabel, phase: 'Plan', agentType: 'planner' }
    );

    if (!plannerResult) {
      log(`Planner returned null on cycle ${cycleCount} round ${pi} -- retrying`);
      continue;
    }

    const planReviewerLabel = `plan-reviewer-c${cycleCount}-r${pi}`;
    const planReview = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nSprint epics: ${epicSummary}\n\n` +
      `Review the beads DAG for these epics ONLY: ${epicSummary}\n` +
      `Run: ${epicIds.map(id => `bd show ${id}`).join(' && ')} to inspect each epic.\n` +
      `Run: ${epicIds.map(id => `bd graph --compact ${id}`).join(' && ')} for the full dependency subtree.\n` +
      `Run: bd show <id> to inspect individual issues in depth.\n` +
      `Run: bd ready -- this is your FIRST correctness check.\n` +
      `Do NOT review or comment on issues outside these epics.\n\n` +
      `APPROVE only if ALL of the following pass:\n` +
      `  1. "bd ready" returns only type=task issues. If any feature or epic appears in "bd ready",\n` +
      `     the dependencies are wired backwards (tasks should block features, not the reverse).\n` +
      `     This is a hard CHANGES NEEDED -- list every misplaced issue by ID.\n` +
      `  2. Every open feature has at least one implementation task and one [test] task\n` +
      `  3. Every task description has clear acceptance criteria\n` +
      `  4. No task is so large it requires more than ~3 file changes\n` +
      `  5. No task appears in more than one feature's dependency graph (check bd graph output)\n` +
      `  6. Every task has model metadata set (check bd show output for METADATA section)\n` +
      `  7. No new scope has been added beyond epics and open bugs/enhancements\n\n` +
      `CHANGES NEEDED if any of the above fail. Notes must be specific: include issue IDs and\n` +
      `exact "bd dep add" commands to fix each dep direction problem.`,
      { model: MODEL_SONNET, label: planReviewerLabel, phase: 'Plan', schema: REVIEW_SCHEMA, agentType: 'plan-reviewer' }
    );

    if (approved(planReview)) {
      planApproved = true;
      log(`Plan APPROVED on cycle ${cycleCount} round ${pi + 1}`);
    } else {
      planFeedback = (planReview && planReview.notes) || '';
      log(`Plan needs changes: ${planFeedback.slice(0, 120)}`);
      await commitFeedback(repo, branch, planFeedback, 'pm-plan-reviewer', planReviewerLabel, 'Plan');
    }
  }

  if (!planApproved) {
    log(`Plan not approved after ${MAX_PLAN_ITER} rounds -- aborting sprint`);
    abortReason = 'plan not approved';
    break;
  }

  // ---------------------------------------------------------------- DEVELOP

  phase('Develop');

  const MAX_DEV_ITER = 20;
  let devIter = 0;
  let devFeedback = '';

  while (devIter < MAX_DEV_ITER) {
    const streakResult = await getReadyStreaks();
    if (streakResult.totalCount === 0) {
      log(`No ready tasks -- develop phase complete (${devIter} iterations)`);
      break;
    }
    log(`Ready: ${streakResult.totalCount} task(s) across ${streakResult.streaks.length} model streak(s)`);

    // Dispatch one doer per model streak; collect all worked task IDs for the reviewer.
    const workedIds = [];
    let streakAbort = false;

    for (const streak of streakResult.streaks) {
      const doerLabel = `doer-c${cycleCount}-i${devIter}-${streak.model.split('-').slice(-2, -1)[0] || streak.model}`;
      log(`Streak: model=${streak.model} tasks=${streak.ids.join(', ')}`);

      const doerResult = await dispatch(
        `Repo: ${repo}\nBranch: ${branch}\n\n` +
        (devFeedback
          ? `Reviewer feedback from the previous iteration (read feedback.md in ${repo} for full details):\n${devFeedback}\nAddress every finding before closing tasks.\n\n`
          : '') +
        `Work ONLY these tasks (in order): ${streak.ids.join(', ')}\n` +
        `Confirm each is still unblocked with: bd show <id>\n` +
        `For each task:\n` +
        `  - Run: bd update <id> --claim\n` +
        `  - Implement the work described (code, tests, config -- whatever the task requires)\n` +
        `  - Run: bd close <id> when the task is complete\n` +
        `  - NEVER close a type=feature or type=bug issue -- only close type=task\n` +
        `Work all listed tasks then stop and return status "VERIFY".\n` +
        `Always return VERIFY -- never return anything else.`,
        { model: streak.model, label: doerLabel, phase: 'Develop', schema: DOER_STATUS_SCHEMA, agentType: 'doer' }
      );

      if (!doerResult) {
        log(`Doer returned null (streak ${streak.model}) -- aborting`);
        abortReason = 'doer null';
        streakAbort = true;
        break;
      }

      if (doerResult.status !== 'VERIFY') {
        log(`Unexpected doer status "${doerResult.status}" -- aborting`);
        abortReason = 'unexpected doer status';
        streakAbort = true;
        break;
      }
      workedIds.push(...streak.ids);
    }

    devIter++;
    if (streakAbort) break;

    // Reviewer model matches the highest-tier model used across all streaks:
    // any opus streak -> opus; otherwise sonnet (haiku work reviewed by sonnet minimum).
    const usedModels = streakResult.streaks.map(s => s.model);
    const reviewerModel = usedModels.includes(MODEL_OPUS) ? MODEL_OPUS : MODEL_SONNET;

    // One reviewer pass covering all streaks worked this iteration.
    const reviewerLabel = `reviewer-c${cycleCount}-i${devIter}`;
    const review = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
      `Sprint epics: ${epicSummary}\nTasks worked this iteration: ${workedIds.join(', ')}\n\n` +
      `Review ONLY the work done for the tasks listed above.\n` +
      `Run: bd show <id> for each task to read its acceptance criteria.\n` +
      `Run: git -C ${repo} diff ${base_branch}...${branch} to see the changes.\n` +
      `Do NOT comment on code or issues outside the listed tasks.\n` +
      `Check: code correctness, test coverage, adherence to each task's acceptance criteria.\n` +
      `If a task needs rework, reopen it: bd update <id> --status=open\n` +
      `CHANGES NEEDED verdict must include specific actionable feedback tied to a task ID.\n` +
      `APPROVED means all committed work meets acceptance criteria.`,
      { model: reviewerModel, label: reviewerLabel, phase: 'Develop', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
    );
    log(`Reviewer verdict: ${review && review.verdict || 'null'}`);

    if (!approved(review)) {
      devFeedback = (review && review.notes) || '';
      log(`Reviewer feedback: ${devFeedback.slice(0, 120)}`);
      await commitFeedback(repo, branch, devFeedback, 'pm-reviewer', reviewerLabel, 'Develop');
      // Reopened tasks will show in bd ready next iteration
    } else {
      devFeedback = '';
    }
  }

  if (abortReason) break;

  // Push branch so CI can trigger, then record HEAD SHA.
  await dispatch(
    `Run: git push origin ${branch}\nIf the branch does not yet exist on origin, use: git push -u origin ${branch}`,
    { model: MODEL_HAIKU, label: `push-c${cycleCount}`, phase: 'Develop' }
  );

  const shaAgent = await dispatch(
    `Run: git rev-parse HEAD\nReturn the full SHA string.`,
    { model: MODEL_HAIKU, label: `head-sha-c${cycleCount}`, phase: 'Develop',
      schema: { type: 'object', required: ['sha'], properties: { sha: { type: 'string' } } } }
  );
  if (shaAgent && shaAgent.sha) headSha = shaAgent.sha;
  log(`HEAD SHA: ${headSha}`);

  // ---------------------------------------------------------------- INTEGRATION TEST (skip if files missing)

  if (integTestEnabled) {
    phase('Test');

    // -- Deploy --
    const deployLabel = `deployer-c${cycleCount}`;
    const deployResult = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nCycle: ${cycleCount}\n\n` +
      `Follow the integration test playbook and deploy.md:\n` +
      (cycleCount === 1
        ? `1. Run the Setup section of integ-test-playbook.md to bring up the test environment.\n`
        : `1. Run the Reset section of integ-test-playbook.md to restore pristine state.\n`) +
      `2. Follow all steps in deploy.md to deploy the build.\n` +
      `3. Run the smoke test defined in deploy.md.\n` +
      `4. Return deployed: true if the smoke test passes, false otherwise.\n` +
      `5. If deployed is false, include the error output in notes.`,
      { model: MODEL_SONNET, label: deployLabel, phase: 'Test', agentType: 'deployer',
        schema: { type: 'object', required: ['deployed'], properties: {
          deployed: { type: 'boolean' }, notes: { type: 'string' } } } }
    );

    if (!deployResult || !deployResult.deployed) {
      const msg = (deployResult && deployResult.notes) || 'no details';
      log(`Deploy failed on cycle ${cycleCount}: ${msg.slice(0, 200)}`);
      log('Skipping integration tests this cycle -- teardown and continue');
      // Teardown before next cycle
      await dispatch(
        `Run the Teardown section of integ-test-playbook.md to clean up the test environment.`,
        { model: MODEL_SONNET, label: `teardown-c${cycleCount}-fail`, phase: 'Test', agentType: 'deployer' }
      );
    } else {
      // -- Integration test run --
      const integLabel = `integ-runner-c${cycleCount}`;

      const integResult = await dispatch(
        `Repo: ${repo}\nBranch: ${branch}\nCycle: ${cycleCount}\n` +
        `Sprint epics: ${epicSummary}\n\n` +
        `Run: bd list --type=feature --status=open\n` +
        `For each open feature, execute its integration tests.\n\n` +
        `For each feature:\n` +
        `  PASS: all tests pass -> bd close <feature-id>\n` +
        `  FAIL: tests fail -> bd create --title="[integ] <description>" ` +
        `--description="Feature: <id>\\nExpected: <what>\\nActual: <what>\\nTest: <which>" ` +
        `--type=bug --priority=<1=core requirement unmet, 2=partial, 3=quality>\n` +
        `  Keep feature open on failure or if inconclusive.\n\n` +
        `Priority rules:\n` +
        `  P0: system won't start or core path completely broken\n` +
        `  P1: requirement from epic explicitly not met\n` +
        `  P2: requirement partially met, degraded behaviour\n` +
        `  P3: quality, performance, or UX issue not blocking core function\n\n` +
        `Before creating a new bug, check bd search "[integ]" -- update existing if duplicate.\n\n` +
        `Return featuresClosed (count), issuesCreated (count), summary (one paragraph).`,
        { model: MODEL_SONNET, label: integLabel, phase: 'Test', schema: INTEG_RUN_SCHEMA, agentType: 'integ-test-runner' }
      );
      if (integResult) {
        log(`Integration: ${integResult.featuresClosed} features closed, ${integResult.issuesCreated} issues created`);
        log(`Summary: ${integResult.summary}`);
      }

      // -- Teardown --
      await dispatch(
        `Run the Teardown section of integ-test-playbook.md to fully clean up the test environment.`,
        { model: MODEL_SONNET, label: `teardown-c${cycleCount}`, phase: 'Test', agentType: 'deployer' }
      );
    }
  }

  // ---------------------------------------------------------------- EXIT CHECK

  const blockers = await countBeadsBlockers(threshold, epicIds);
  const currentOpenIds = (blockers.ids || []).slice().sort();
  log(`Exit check: ${blockers.count} open issues at P<=${threshold} -- IDs: [${currentOpenIds.join(', ')}]`);

  // No-progress check: if no issue from the previous cycle was resolved, abort.
  if (cycleCount > 1 && prevOpenIds.length > 0) {
    const closedFromPrev = prevOpenIds.filter(id => !currentOpenIds.includes(id));
    if (closedFromPrev.length === 0) {
      log(`No progress in cycle ${cycleCount}: same ${prevOpenIds.length} issues unresolved -- aborting`);
      abortReason = 'no progress';
      break;
    }
    log(`Progress: ${closedFromPrev.length} issue(s) resolved this cycle`);
  }

  // Record cycle summary in beads memory.
  await dispatch(
    `Run: bd remember "auto-sprint cycle ${cycleCount}: ` +
    `${blockers.count} open P<=${threshold} issues, ` +
    `output_tokens=${cycleOutputTokens}, ` +
    `open: ${currentOpenIds.join(' ') || 'none'}"`,
    { model: MODEL_HAIKU, label: `memo-c${cycleCount}`, phase: integTestEnabled ? 'Test' : 'Develop' }
  );

  if (blockers.count === 0) {
    epicDone = true;
    log(`Goal met after ${cycleCount} cycle(s)`);
    break;
  }

  prevOpenIds = currentOpenIds;
}

// ------------------------------------------------------------------ CI CHECK

phase('Harvest');

let ciResult = null;
if (headSha) {
  ciResult = await dispatch(
    `Check CI status for commit ${headSha} on branch ${branch}.\n` +
    `Run: gh run list --branch ${branch} --limit 3 --json status,conclusion,databaseId\n` +
    `If runs exist and are in_progress: poll with gh run watch <id> (timeout 10 min).\n` +
    `If runs exist and conclusion is "success": return status "green".\n` +
    `If runs exist and conclusion is "failure": return status "red" with notes (include run URL).\n` +
    `If no runs found: return status "not_configured".\n` +
    `Do not block for more than 10 minutes total.`,
    { model: MODEL_HAIKU, label: 'ci-watcher', phase: 'Harvest', schema: CI_SCHEMA, agentType: 'ci-watcher' }
  );

  if (ciResult) {
    log(`CI status: ${ciResult.status}`);
    if (ciResult.status === 'not_configured') {
      log('CI not configured -- creating beads task');
      await dispatch(
        `Run: bd create --title="Add CI pipeline to project" ` +
        `--description="The auto-sprint workflow found no CI runs for branch ${branch}. ` +
        `CI is required for the sprint exit gate. ` +
        `This task covers: choosing a CI provider, writing the workflow config, and verifying it triggers on push." ` +
        `--type=task --priority=2\n` +
        `Then run: bd show <new-id> and confirm it was created.`,
        { model: MODEL_HAIKU, label: 'ci-task-create', phase: 'Harvest' }
      );
      log('ACTION REQUIRED: Set up CI for this project. Task created in beads.');
    } else if (ciResult.status === 'red') {
      log(`CI FAILED: ${(ciResult.notes || '').slice(0, 200)}`);
      log('Proceeding to harvest with CI failure noted in PR.');
    }
  }
}

// ------------------------------------------------------------------ FINAL REVIEW

const finalReviewLabel = 'final-reviewer';
const finalReview = await dispatch(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  `Sprint epics: ${epicSummary}\nGoal: ${goal}\n` +
  (abortReason ? `Sprint ended early: ${abortReason}. Review what was completed.\n` : '') +
  (epicDone ? `Goal was met: all P<=${threshold} issues resolved.\n` : `Goal not yet met.\n`) +
  `\nReview the overall output of this sprint:\n` +
  `  - Does the work address the original epics?\n` +
  `  - Are there obvious gaps or regressions?\n` +
  `  - Is the codebase in a releasable state for what was completed?\n` +
  `APPROVED means the work is ready to harvest and raise as a PR.\n` +
  `CHANGES NEEDED means critical issues were found; include specific findings in notes.`,
  { model: MODEL_OPUS, label: finalReviewLabel, phase: 'Harvest', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
);
log(`Final review: ${finalReview && finalReview.verdict || 'null'}`);

if (!approved(finalReview)) {
  const notes = (finalReview && finalReview.notes) || '';
  log(`Final review not approved -- aborting before harvest. Notes: ${notes.slice(0, 300)}`);
  return { cycles: cycleCount, epicDone, goal, abortReason: abortReason || 'final review rejected', finalReviewNotes: notes };
}

// ------------------------------------------------------------------ HARVEST

const harvestLabel = 'harvester';
const harvestResult = await dispatch(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  `Sprint epics: ${epicSummary}\nCycles completed: ${cycleCount}\nGoal met: ${epicDone}\n\n` +
  `The sprint is complete. Harvest the sprint artefacts:\n` +
  `  - Update docs/ with architecture decisions, feature design, API contracts\n` +
  `  - Update README.md and prepend a CHANGELOG.md entry\n` +
  `  - Remove any sprint scaffold files (do not remove project files that predate the sprint)\n` +
  `  - Close any remaining P3/P4 beads issues with: bd close <id> --reason="deferred"\n` +
  `  - Include a token cost summary from bd memories: bd memories auto-sprint\n\n` +
  `Final review notes to include in CHANGELOG:\n` +
  `${(finalReview && finalReview.notes) || '(none)'}\n\n` +
  `Return status "OK" if successful, "FAILED" with notes otherwise.`,
  { model: MODEL_SONNET, label: harvestLabel, phase: 'Harvest', schema: HARVEST_SCHEMA, agentType: 'harvester' }
);

if (!harvestResult || harvestResult.status !== 'OK') {
  log(`Harvest failed: ${(harvestResult && harvestResult.notes) || 'null'} -- skipping PR`);
  return { cycles: cycleCount, epicDone, goal, harvest: 'failed' };
}

// ------------------------------------------------------------------ PR

await dispatch(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Title: summarise what was implemented across ${cycleCount} cycle(s).\n` +
  `Body:\n` +
  `  - What was built (per epic)\n` +
  `  - Sprint goal: ${goal} -- ${epicDone ? 'MET' : 'NOT MET (partial delivery)'}\n` +
  `  - Cycles run: ${cycleCount}\n` +
  `  - Open items carried forward (if any): bd list --status=open and summarise\n` +
  `  - Final review notes: ${(finalReview && finalReview.notes) || '(none)'}\n` +
  (headSha && ciResult && ciResult.status !== 'green'
    ? `  - CI: ${ciResult.status} -- see notes\n` : '') +
  `  - Token cost summary from: bd memories auto-sprint`,
  { model: MODEL_SONNET, label: 'harvest-pr', phase: 'Harvest' }
);

return { cycles: cycleCount, epicDone, goal, harvest: 'ok' };
