export async function runPlanPhase({
  cycleCount, branch, goal, rootIds, startedAt,
  repo, base_branch, rootSummary, mission, requirementsFile,
  TIER_CHEAP, TIER_STANDARD, TIER_PREMIUM,
  PLAN_REVIEW_SCHEMA,
  updateLiveState, writeSprintState, dispatchShellFleet, dispatchFleet, stateFileRel,
  parseCycleState, log, approved, computeSprintQuote, fs, execSync,
  dispatchLedger, sprintQuote, calibration, taskAssignments, pathJoin
}) {
    updateLiveState({ phase: 'Plan', cycle: cycleCount });

    writeSprintState(stateFileRel, {
      type: 'cycle-start', cycle: cycleCount, branch, goal, rootIds, startedAt,
    }, 'Plan', 'state-c' + cycleCount + '-plan');

    // Check cycle state: planDone + in_progress orphans.
    const makeBfsExtr = (rootsArr) => `const subtree=new Set('${rootsArr.join(' ')}'.split(' ').filter(Boolean));const q=Array.from(subtree);const nodes=g.layout&&g.layout.Nodes;if(nodes){while(q.length>0){const c=q.shift();const n=nodes[c];if(n&&n.DependsOn){for(const d of n.DependsOn)if(!subtree.has(d)){subtree.add(d);q.push(d);}}}}`;
    
    const idExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtr(rootIds)}console.log(Array.from(subtree).join(' '))}catch{}"`;
    const graphExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtr(rootIds)}const issues=(g.issues||[]).filter(i=>subtree.has(i.id));console.log(JSON.stringify(issues.map(i=>({id:i.id,title:i.title,t:i.issue_type,s:i.status,d:!!(i.description||'').trim(),children:(g.layout&&g.layout.Nodes[i.id]&&g.layout.Nodes[i.id].DependsOn)||[]}))))}catch{console.log('[]')}"`;
    const ipExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).map(i=>i.id).join(' '))}catch{}"`;
    const cycleStateCmds = [
      ...rootIds.map(id => `bd graph --json ${id} | ${graphExtract}`),
      `bd list --status=in_progress --type=task --json | ${ipExtract}`,
    ];
    const cycleStateRaw = await dispatchShellFleet(cycleStateCmds, 'pm-doer-cheap', {
      label: 'cycle-state', phase: 'Plan', cycle: cycleCount,
    });
    const cycleState = parseCycleState(cycleStateRaw && cycleStateRaw.outputs,
      rootIds.length);
    updateLiveState({ sprintBeads: cycleState.allIssues || [] });
    log('Cycle state: planDone=' + cycleState.planDone +
        ' inProgress=[' + cycleState.inProgressIds.join(', ') + ']');

    // Reset orphaned in_progress tasks.
    if (cycleState.inProgressIds.length > 0) {
      log('Resetting ' + cycleState.inProgressIds.length + ' orphaned in_progress task(s) to open');
      const resetCmds = cycleState.inProgressIds.map(id => `bd update ${id} --status=open`);
      await dispatchShellFleet(resetCmds, 'pm-doer-cheap', {
        label: 'reset-orphans', phase: 'Plan', cycle: cycleCount,
      });
    }
    // ---------------------------------------------------------------- PLAN

    let planApproved = cycleState.planDone;
    let planFeedback = '';
    const MAX_PLAN_ITER = 3;

    if (planApproved) {
      log('Plan already complete -- skipping plan loop for cycle ' + cycleCount);
    }

    for (let pi = 0; pi < MAX_PLAN_ITER && !planApproved; pi++) {
      const plannerLabel = `planner-c${cycleCount}-r${pi}`;

      const plannerPrompt =
        `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
        `Sprint goals: ${rootSummary}\n` +
        (mission ? `SPRINT MISSION / OBJECTIVE:\n${mission}\n(Prioritize addressing this overarching objective when planning tasks).\n\n` : '') +
        (requirementsFile ? `Additional context: ${requirementsFile}\n` : '') +
        `\n` +
        (planFeedback
          ? `Plan-reviewer feedback from the previous round (read feedback.md in ${repo} for full details):\n${planFeedback}\nAddress every item before proceeding.\n\n`
          : '') +
        `Inspect existing state first (DO NOT USE RUN_COMMAND FOR THIS):\n` +
        `  Use the 'view_file' or 'grep_search' tool on ".beads/issues.jsonl" to read issue descriptions.\n` +
        `  NEVER try to run "bd show <id>" in the shell. The Native agent cannot use interactive tools!\n` +
        `  IMPORTANT: When using the 'call_mcp_tool' tool, the 'Arguments' field MUST be a JSON object, NOT a stringified JSON string! For example: {"command": "bd ready", "run_from": "C:/akhil/git/fleet-e2e-toy-agy", "member_name": "pm-planner"} (Do NOT use 'cwd', use 'run_from', and ALWAYS include 'member_name').\n` +
        `Then build or complete the feature+task DAG -- create only what is missing:\n` +
        `  - BEFORE creating any feature or task, read the existing issues in .beads/issues.jsonl.\n` +
        `    If a matching issue already exists, update it instead of creating a duplicate.\n` +
        `\n` +
        `DEPENDENCY WIRING -- read this carefully. "bd dep add A B" means A CANNOT CLOSE until B is done.\n` +
        `The correct wiring direction is: parents depend on children (children unblock first).\n` +
        `\n` +
        `  Step 1 -- wire sprint goal -> child (goal waits for children):\n` +
        `    bd dep add <goal-id> <child-id>\n` +
        `    After this: "bd ready" will NOT show the sprint goal (it's waiting). Children show as ready.\n` +
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
        `  VERIFY after wiring: run "bd ready" -- it must return impl tasks, NOT sprint goals or blocked parents.\n` +
        `  If sprint goals appear in "bd ready" the deps are backwards -- fix them before continuing.\n` +
        `\n` +
        `  IMPORTANT: Each task belongs to exactly ONE feature. Never share a task across features.\n` +
        `\n` +
        `  Break each sprint goal into child issues: bd create --parent <goal-id> (use type=feature for sub-goals, type=task for leaf work).\n` +
        `  Create type=task issues for each feature: implementation tasks AND integration\n` +
        `    test development tasks (prefix test tasks with "[test]" in the title)\n` +
        `  Features P1/P2; tasks one level below their parent feature (P1 feature -> P2 tasks, P2 feature -> P3 tasks)\n` +
        `  Each task must be completable in one agent session (1-3 file changes max)\n` +
        `  Every task needs clear acceptance criteria in its description\n` +
        `  - Assign each task a tier AND complexity bucket based on complexity -- after creating or updating each\n` +
        `    task, run: bd update <id> --set-metadata model=<tier>\n` +
        `    Available tiers and when to use them:\n` +
        `      ${TIER_CHEAP}    -- mechanical work: rename, config tweak, move file, simple wiring\n` +
        `      ${TIER_STANDARD} -- standard work: new function, test suite, API endpoint, refactor\n` +
        `      ${TIER_PREMIUM}  -- hard work: architecture, multi-file design, ambiguous requirements\n` +
        `    Complexity buckets (S/M/L) are assigned by the plan-reviewer based on task scope.\n` +
        `    Every task MUST receive a bucket assignment -- tasks without a bucket cannot be cost-estimated.\n` +
        `  - Group tasks so consecutive tasks in dependency order share a tier where\n` +
        `    possible -- this minimises tier-switching overhead during execution\n` +
        (cycleCount > 1
          ? `This is cycle ${cycleCount}. Focus on open issues only.\n` +
            `Do NOT add new scope beyond the original sprint goals and open bugs/enhancements.\n` +
            `Do NOT re-create tasks that are already closed.\n`
          : '') +
        `Confirm with any text when done.`;

      const plannerResult = await dispatchFleet('pm-planner', plannerPrompt, {
        label: plannerLabel, phase: 'Plan', cycle: cycleCount,
      });

      if (!plannerResult) {
        log('Planner returned null on cycle ' + cycleCount + ' round ' + pi + ' -- retrying');
        continue;
      }

      const planReviewerLabel = `plan-reviewer-c${cycleCount}-r${pi}`;
      const planReviewPrompt =
        `Repo: ${repo}\nBranch: ${branch}\nSprint goals: ${rootSummary}\n` +
        `Calibration file: ${repo}/sprint-logs/calibration.json (read this first if it exists)\n\n` +
        `Review the beads DAG for these sprint goals ONLY: ${rootSummary}\n` +
        `Run: ${rootIds.map(id => `bd show ${id}`).join(' && ')} to inspect each sprint goal.\n` +
        `Run: ${rootIds.map(id => `bd graph --compact ${id}`).join(' && ')} for the full dependency subtree.\n` +
        `Run: bd show <id> to inspect individual issues in depth.\n` +
        `Run: bd ready -- this is your FIRST correctness check.\n` +
        `Do NOT review or comment on issues outside these sprint goals.\n\n` +
        `Follow your runbook (plan-reviewer.md) step by step:\n` +
        `  Steps 1-2: inspect the DAG and check all quality criteria.\n` +
        `  Step 3: classify each task -- assign complexity bucket (S/M/L) and read its model\n` +
        `    from beads metadata. If a task has no model metadata, note it in your verdict\n` +
        `    notes as a warning but do NOT return CHANGES NEEDED for it -- the workflow has a fallback.\n` +
        `  Step 4: return verdict, notes, and taskAssignments (id + bucket + model per task).\n\n` +
        `Notes must be specific: include issue IDs and exact "bd dep add" commands to fix\n` +
        `any dependency direction problems.`;

      const planReview = await dispatchFleet('pm-reviewer', planReviewPrompt, {
        label: planReviewerLabel, phase: 'Plan', cycle: cycleCount,
        schema: PLAN_REVIEW_SCHEMA,
      });

      if (approved(planReview)) {
        planApproved = true;
        log('Plan APPROVED on cycle ' + cycleCount + ' round ' + (pi + 1));
        taskAssignments = (planReview && planReview.taskAssignments) || [];

        // Compute sprint cost quote in pure JS.
        sprintQuote = computeSprintQuote(taskAssignments, calibration);
        const sc = sprintQuote.scenarios;
        log('Sprint quote (' + sprintQuote.calibrationSource + ', ' + taskAssignments.length + ' tasks): ' +
            'exp=$' + sc.expected.outputOnly.toFixed(3));

        // Commit plan snapshot via shell dispatch.
        const planCommitCmds = [
          ...((sprintQuote && sprintQuote.tasks) ? sprintQuote.tasks.map(t =>
            `bd update ${t.id} --notes="cost-estimate: bucket=${t.bucket} model=${t.model} ` +
            `doer_tokens=${t.doerTokens || 0} output_usd=${t.outputUsd ? t.outputUsd.toFixed(4) : '0.0000'}"`
          ) : []),
          `bd export -o "${repo}/.beads/issues.jsonl"`,
          `git -C "${repo}" add .beads/issues.jsonl`,
          `git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit --allow-empty -m "plan: approve task DAG"`,
        ];
        await dispatchShellFleet(planCommitCmds, 'pm-doer-cheap', {
          label: 'plan-commit-c' + cycleCount, phase: 'Plan', cycle: cycleCount,
        });

      } else if (planReview && planReview.verdict === 'CHANGES NEEDED') {
        planFeedback = (planReview && planReview.notes) || '';
        log('Plan CHANGES NEEDED (round ' + (pi + 1) + '): ' + planFeedback.slice(0, 120));

        // Write feedback.md and commit natively so planner can read it.
        const fbLabel = 'feedback-commit-plan-c' + cycleCount + '-r' + pi;
        const fbStart = Date.now();
        updateLiveState({ currentAgent: fbLabel, currentModel: 'native', currentPhase: 'Plan', currentCycle: cycleCount, currentStartTime: fbStart });
        fs.writeFileSync(pathJoin(repo, 'feedback.md'), planFeedback);
        try {
          execSync('git add feedback.md', { cwd: repo, stdio: 'ignore' });
          execSync('git -c user.name="pm-reviewer" -c user.email="pm-reviewer@pm.local" commit -m "feedback: plan-reviewer-c' + cycleCount + '-r' + pi + '"', { cwd: repo, stdio: 'ignore' });
        } catch (e) {
          log('Warning: Feedback commit failed (possibly empty diff): ' + e.message);
        }
        dispatchLedger.push({ cycle: cycleCount, phase: 'Plan', label: fbLabel, model: 'native', outTokens: 0, costUsd: 0, durationMs: Date.now() - fbStart });
      } else {
        log('Plan reviewer returned null or unexpected verdict on round ' + (pi + 1));
      }
    }

    if (!planApproved) {
      log('Plan not approved after ' + MAX_PLAN_ITER + ' rounds -- proceeding anyway');
      planApproved = true;
    }

    writeSprintState(stateFileRel, {
      type: 'checkpoint', cycle: cycleCount, phase: 'Plan', planApproved: true, branch, goal, rootIds, startedAt,
    }, 'Plan', 'state-c' + cycleCount + '-plan-done');
  return { planApproved, planFeedback, sprintQuote, taskAssignments };
}
