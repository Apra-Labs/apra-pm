export const meta = {
  name: 'claude-pm',
  description: 'Deterministic sprint: plan -> execute -> harvest using beads as DAG store',
  phases: [
    { title: 'Plan' },
    { title: 'Execute' },
    { title: 'Harvest' },
  ],
};

// Sprint workflow: plans tasks in beads, executes them wave by wave, then
// updates docs and raises a PR.
//
// args:
//   repo          - absolute path to the local git clone (branch already checked out)
//   branch        - sprint branch name
//   requirements  - string describing what to implement (e.g. bd list --status=open output)
//   base_branch   - PR target branch (default: main)
//   verify_every  - run a VERIFY review every N waves (default: 2)

const repo = args && args.repo ? args.repo : '';
const branch = args && args.branch ? args.branch : '';
const requirements = args && args.requirements ? args.requirements : '';
const base_branch = (args && args.base_branch) || 'main';
const verify_every = (args && args.verify_every) || 2;

if (!repo || !branch || !requirements) {
  log('ERROR: args.repo, args.branch, and args.requirements are all required');
  return { error: 'missing required args' };
}

const SPRINT_SCHEMA = {
  type: 'object',
  required: ['sprint_label', 'task_count', 'rationale', 'bd_commands'],
  properties: {
    sprint_label: { type: 'string' },
    task_count: { type: 'number' },
    rationale: { type: 'string' },
    bd_commands: { type: 'string' },
  },
};

const TASKS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['id', 'title', 'description'],
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
    },
  },
};

function resolveModel(description) {
  const m = (description || '').match(/\[tier:(cheap|standard|premium)\]/);
  const tier = m ? m[1] : 'standard';
  return {
    cheap: 'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-4-6',
    premium: 'claude-opus-4-8',
  }[tier];
}

// ---- PLAN phase ----
phase('Plan');

let plan = null;
let planApproved = false;
let planFeedback = '';

for (let planRound = 0; planRound < 3; planRound++) {
  if (planApproved) break;

  plan = await agent(
    `You are a sprint planner. Create a beads task graph for the following requirements.\n\n` +
    `Requirements:\n${requirements}\n\n` +
    (planFeedback ? `Reviewer feedback from the previous round:\n${planFeedback}\n\n` : '') +
    `Working repo: ${repo}\n\n` +
    `Rules:\n` +
    `- Create 4-8 sprint tasks with --priority=2 (NOT --priority=1; priority-1 is reserved for source issues)\n` +
    `- Each task description must include a model tier tag: [tier:cheap], [tier:standard], or [tier:premium]\n` +
    `- Wire task dependencies with: bd dep add <task-id> <depends-on-id>\n` +
    `- The bd_commands field must be a complete shell script of bd create and bd dep add calls\n` +
    `- Each bd create call must include --priority=2 and a description with a [tier:...] tag\n` +
    `- sprint_label must be a short kebab-case slug (e.g. p1-features-impl)`,
    { model: 'claude-opus-4-8', label: `planner-r${planRound}`, phase: 'Plan', schema: SPRINT_SCHEMA }
  );

  if (!plan) {
    log(`Planner returned null on round ${planRound} -- retrying`);
    continue;
  }

  // Run the bd_commands to populate beads with sprint tasks
  await agent(
    `In repo ${repo}, run each of these shell commands in order. Report success or failure for each.\n\n${plan.bd_commands}`,
    { model: 'claude-haiku-4-5-20251001', label: `bd-create-r${planRound}`, phase: 'Plan' }
  );

  // Write scaffold files and commit (required by the process-discipline validation gate)
  const reqContent = `# Sprint Requirements\n\n${requirements}`;
  const planContent = `# Sprint Plan: ${plan.sprint_label}\n\n${plan.rationale}\n\nTask count: ${plan.task_count}`;
  const progressContent = `{"sprint":"${plan.sprint_label}","wave":0,"tasks_closed":0}`;

  await agent(
    `In repo ${repo} on branch ${branch}, perform these exact steps:\n` +
    `1. Create file requirements.md with this content (write it verbatim):\n${reqContent}\n\n` +
    `2. Create file plan.md with this content (write it verbatim):\n${planContent}\n\n` +
    `3. Create file progress.json with this content (write it verbatim): ${progressContent}\n\n` +
    `4. Stage and commit: git add requirements.md plan.md progress.json && git commit -m "chore: scaffold sprint ${plan.sprint_label}"\n` +
    `5. Push: git push origin ${branch}`,
    { model: 'claude-haiku-4-5-20251001', label: `scaffold-r${planRound}`, phase: 'Plan' }
  );

  // Plan review
  const reviewResult = await agent(
    `You are a plan reviewer in repo ${repo}.\n\n` +
    `Requirements to verify against:\n${requirements}\n\n` +
    `Review the sprint plan:\n` +
    `1. Run: bd list --status=open\n` +
    `2. Run bd show <id> on each task to inspect descriptions and dependencies\n` +
    `3. Check: do the tasks collectively cover all requirements? Are dependencies sensible?\n` +
    `   Does every task description include a [tier:cheap/standard/premium] tag?\n\n` +
    `Output APPROVED if the plan looks solid, or CHANGES NEEDED followed by specific feedback.`,
    { model: 'claude-sonnet-4-6', label: `plan-reviewer-r${planRound}`, phase: 'Plan' }
  );

  const feedbackContent = `# Plan Review Round ${planRound + 1}\n\n${reviewResult || 'No output'}`;

  // Commit feedback.md (required by the process-discipline validation gate)
  await agent(
    `In repo ${repo} on branch ${branch}:\n` +
    `1. Create file feedback.md with this content (write it verbatim):\n${feedbackContent}\n\n` +
    `2. git add feedback.md && git commit -m "docs: plan review round ${planRound + 1}"\n` +
    `3. git push origin ${branch}`,
    { model: 'claude-haiku-4-5-20251001', label: `feedback-commit-r${planRound}`, phase: 'Plan' }
  );

  if (reviewResult && reviewResult.includes('APPROVED')) {
    planApproved = true;
    log(`Plan APPROVED on round ${planRound + 1}`);
  } else {
    planFeedback = reviewResult || '';
    log(`Plan rejected on round ${planRound + 1} -- wiping tasks and replanning`);
    await agent(
      `In repo ${repo}: run bd list --status=open to see all open tasks, then close every one of them with bd close <id> --reason="plan rejected - replanning"`,
      { model: 'claude-haiku-4-5-20251001', label: `plan-wipe-r${planRound}`, phase: 'Plan' }
    );
  }
}

if (!plan) {
  log('FATAL: plan phase produced no plan');
  return { error: 'plan phase failed' };
}

// ---- EXECUTE phase ----
phase('Execute');

const MAX_WAVES = 20;
let waveNum = 0;

for (;;) {
  if (waveNum >= MAX_WAVES) {
    log(`Max waves (${MAX_WAVES}) reached -- stopping execute phase`);
    break;
  }

  const readyTasks = await agent(
    `In repo ${repo}:\n` +
    `1. Run: bd ready\n` +
    `2. For each task listed, run: bd show <id> to get the full description\n` +
    `3. Return ALL ready (unblocked, open) tasks as structured data.\n` +
    `If no tasks are ready, return an empty array.`,
    { model: 'claude-haiku-4-5-20251001', label: `bd-ready-w${waveNum}`, phase: 'Execute', schema: TASKS_SCHEMA }
  );

  if (!readyTasks || readyTasks.length === 0) break;
  log(`Wave ${waveNum}: ${readyTasks.length} ready task(s)`);

  // Run doers sequentially to avoid git conflicts on the shared branch
  for (const task of readyTasks) {
    const model = resolveModel(task.description);
    await agent(
      `You are a sprint doer working in repo ${repo} on branch ${branch}.\n\n` +
      `Task ID: ${task.id}\n` +
      `Task title: ${task.title}\n\n` +
      `Full description:\n${task.description}\n\n` +
      `Steps:\n` +
      `1. Claim the task: bd update ${task.id} --claim\n` +
      `2. Implement the task. Write or edit real source files.\n` +
      `3. Commit your changes: git add -A && git commit -m "feat: ${task.title} [${task.id}]"\n` +
      `4. Close the task: bd close ${task.id}\n\n` +
      `Stay focused. Do only this one task.`,
      { model, label: `doer:${task.id}`, phase: 'Execute' }
    );
  }

  waveNum++;

  if (waveNum % verify_every === 0) {
    const verify = await agent(
      `VERIFY checkpoint after wave ${waveNum} in repo ${repo}.\n\n` +
      `Original requirements:\n${requirements}\n\n` +
      `1. Run: bd list --status=closed\n` +
      `2. Run: bd list --status=open\n` +
      `3. Review what has been implemented so far. If you find issues, create fix tasks:\n` +
      `   bd create --title="Fix: <description>" --description="[tier:standard] <detail>" --priority=2\n\n` +
      `Output APPROVED if the sprint is on track, or CHANGES NEEDED if fix tasks were added.`,
      { model: 'claude-sonnet-4-6', label: `verify-w${waveNum}`, phase: 'Execute' }
    );
    log(`VERIFY w${waveNum}: ${(verify || '').includes('APPROVED') ? 'APPROVED' : 'review done'}`);
  }
}

// Final review before harvest
const finalReview = await agent(
  `Final sprint review in repo ${repo}.\n\n` +
  `Requirements:\n${requirements}\n\n` +
  `1. Run: bd list --status=closed to see all completed tasks\n` +
  `2. Review the overall implementation quality\n` +
  `3. If there are serious gaps, create fix tasks with bd create --priority=2\n\n` +
  `Output APPROVED or CHANGES NEEDED with rationale.`,
  { model: 'claude-opus-4-8', label: 'final-review', phase: 'Execute' }
);
log(`Final review: ${(finalReview || '').includes('APPROVED') ? 'APPROVED' : 'done'}`);

// ---- HARVEST phase ----
phase('Harvest');

// Update project docs to reflect new features/changes, then clean up scaffold files.
// git rm removes scaffold files from the tree; since they were created within the
// sprint branch they cancel out in the net base..head diff (final-changeset-clean gate).
await agent(
  `In repo ${repo} on branch ${branch}:\n\n` +
  `1. Run: bd list --status=closed to see everything implemented in this sprint\n` +
  `2. Update README.md to reflect any new features, CLI flags, or changes added\n` +
  `3. If CHANGELOG.md exists, prepend a new entry for sprint "${plan.sprint_label}"\n` +
  `4. Remove all sprint scaffold files (use git rm so they are tracked as deletions):\n` +
  `   git rm -f requirements.md plan.md feedback.md progress.json\n` +
  `   (If any file does not exist, that is fine -- skip it)\n` +
  `5. Stage all changes and commit:\n` +
  `   git add -A && git commit -m "docs: harvest ${plan.sprint_label} - update docs, remove scaffolding"\n` +
  `6. Push all commits to origin:\n` +
  `   git push origin ${branch}`,
  { model: 'claude-sonnet-4-6', label: 'harvest-docs', phase: 'Harvest' }
);

// Close the original P1 source issues (the sprint tasks are P2; these are the
// source requirements the sprint was asked to implement).
await agent(
  `In repo ${repo}:\n` +
  `1. Run: bd list --status=open\n` +
  `2. For every issue shown that has priority P1 (look for "P1" in the output line), close it:\n` +
  `   bd close <id> --reason="implemented in sprint ${plan.sprint_label}"\n` +
  `Report which issues were closed.`,
  { model: 'claude-haiku-4-5-20251001', label: 'harvest-close-p1', phase: 'Harvest' }
);

// Create the PR
await agent(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request:\n\n` +
  `gh pr create --title "sprint: ${plan.sprint_label}" ` +
  `--body "Implements P1 requirements via sprint ${plan.sprint_label}." ` +
  `--base ${base_branch} --head ${branch}\n\n` +
  `Run that exact command and report the resulting PR URL.`,
  { model: 'claude-sonnet-4-6', label: 'harvest-pr', phase: 'Harvest' }
);

return { sprint_label: plan.sprint_label, waves: waveNum };
