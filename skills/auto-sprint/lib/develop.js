export async function runDevelopPhase({
  cycleCount, branch, goal, rootIds, startedAt, repo, base_branch, rootSummary,
  TIER_CHEAP, TIER_STANDARD, TIER_PREMIUM, DOER_STATUS_SCHEMA, REVIEW_SCHEMA,
  taskAssignments, calibration, threshold,
  updateLiveState, writeSprintState, dispatchShellFleet, dispatchFleet, stateFileRel,
  parseReadyStreaks, truncateStreakToCeiling, labelTaskIds, parseBlockers, approved,
  log, fs, pathJoin, dispatchLedger
}) {
  let abortReason = null;
  const makeBfsExtr = (rootsArr) => `const subtree=new Set('${rootsArr.join(' ')}'.split(' ').filter(Boolean));const q=Array.from(subtree);const nodes=g.layout&&g.layout.Nodes;if(nodes){while(q.length>0){const c=q.shift();const n=nodes[c];if(n&&n.DependsOn){for(const d of n.DependsOn)if(!subtree.has(d)){subtree.add(d);q.push(d);}}}}`;
    updateLiveState({ phase: 'Develop', cycle: cycleCount });
    // ---------------------------------------------------------------- DEVELOP

    // ---- phase_label for Develop phase
    let phase_label = 'Develop';
    writeSprintState(stateFileRel, {
      type: 'checkpoint', cycle: cycleCount, phase: 'Develop', planApproved: true, branch, goal, rootIds, startedAt,
    }, 'Develop', 'state-c' + cycleCount + '-dev');

    const MAX_DEV_ITER = 20;
    let devIter  = 0;
    let devFeedback = '';

    // id->bucket map derived from last approved taskAssignments.
    const bucketById = Object.fromEntries((taskAssignments || []).map(t => [t.id, t.bucket]));

    while (devIter < MAX_DEV_ITER) {
      // Get ready streaks via fleet shell dispatch.
      // Use the graph to accurately determine which tasks have 0 open blockers, bypassing bd list --ready filtering.
      const graphReadyExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtr(rootIds)}const readyIds=[];if(nodes){for(const id of Array.from(subtree)){const n=nodes[id];if(!n||n.Issue.status!=='open')continue;let blocked=false;if(n.DependsOn){for(const depId of n.DependsOn){const dep=nodes[depId];if(dep&&dep.Issue.status!=='closed'&&dep.Issue.status!=='deferred'){blocked=true;break;}}}if(!blocked)readyIds.push(id);}}console.log(readyIds.join(' '));}catch(e){}"`;
      const taskExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority,m:(i.metadata||{}).model}))))}catch{console.log('[]')}"`;
      const readyCmds = [
        ...rootIds.map(id => `bd graph --json ${id} | ${graphReadyExtract}`),
        `bd list --status=open --type=task --json | ${taskExtract}`,
      ];
      const streakRaw = await dispatchShellFleet(readyCmds, 'pm-doer-cheap', {
        label: 'ready-streaks', phase: 'Develop', cycle: cycleCount,
      });
      const streakResult = parseReadyStreaks(
        streakRaw && streakRaw.outputs, rootIds.length, rootIds.length, TIER_STANDARD);

      if (streakResult.totalCount === 0) {
        // Deadlock check: if first iteration and open issues exist but none ready.
        if (devIter === 0) {
          const idExtractR = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtr(rootIds)}console.log(Array.from(subtree).join(' '))}catch{}"`;
          const openIdExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority}))))}catch{console.log('[]')}"`;
          const blockerCmds = [
            ...rootIds.map(id => `bd graph --json ${id} | ${idExtractR}`),
            `bd list --status=open --json | ${openIdExtract}`,
          ];
          const blockerRaw = await dispatchShellFleet(blockerCmds, 'pm-doer-cheap', {
            label: 'check-blockers', phase: 'Develop', cycle: cycleCount,
          });
          const blockers = parseBlockers(
            blockerRaw && blockerRaw.outputs, rootIds.length, rootIds.length, threshold, rootIds);
          if (blockers.count > 0) {
            log('ERROR: DEADLOCK -- ' + blockers.count + ' open issue(s) at/above ' + goal +
                ' in the sprint subtree but NONE are ready on the first develop iteration. ' +
                'The dependency DAG is blocked (commonly backwards or parent-child edges).');
            abortReason = 'deadlock: open issues but none ready';
            break;
          }
        }
        log('No ready tasks -- develop phase complete (' + devIter + ' iterations)');
        break;
      }
      log('Dev iter ' + devIter + ' c' + cycleCount + ': ' + streakResult.totalCount +
          ' ready task(s) across ' + streakResult.streaks.length + ' model streak(s)');

      // Dispatch one doer per model streak.
      const workedIds = [];
      let streakAbort   = false;
      let doerNullReset = false;

      for (const streak of streakResult.streaks) {
        // Truncate streak to token ceiling for this tier.
        const fittedIds = truncateStreakToCeiling(streak.ids, bucketById, calibration, streak.model);
        if (fittedIds.length < streak.ids.length) {
          log('Streak ' + streak.model + ' truncated to token ceiling: working ' +
              fittedIds.length + '/' + streak.ids.length + ' task(s) (' +
              labelTaskIds(fittedIds) + '); ' + (streak.ids.length - fittedIds.length) + ' deferred');
        }

        // Resolve tier -> fleet member name.
        let doerMember;
        if (streak.model === TIER_CHEAP)    doerMember = 'pm-doer-cheap';
        else if (streak.model === TIER_PREMIUM) doerMember = 'pm-doer-premium';
        else                                    doerMember = 'pm-doer-std';

        const doerLabel = `doer-c${cycleCount}-r${devIter}: ${labelTaskIds(fittedIds)}`;
        log('Doer c' + cycleCount + '-r' + devIter + ': ' + labelTaskIds(fittedIds) +
            ' [model=' + streak.model + ']');

        const doerPrompt =
          `Repo: ${repo}\nBranch: ${branch}\n\n` +
          (devFeedback
            ? `Reviewer feedback from the previous iteration (read feedback.md in ${repo} for full details):\n${devFeedback}\nAddress every finding before closing tasks.\n\n`
            : '') +
          `Work ONLY these tasks (in order): ${fittedIds.join(', ')}\n` +
          `Confirm each is still unblocked with: bd show <id>\n` +
          `For each task:\n` +
          `  - Run: bd update <id> --claim\n` +
          `  - Implement the work described (code, tests, config -- whatever the task requires)\n` +
          `  - Run: bd close <id> immediately after verify and commit, BEFORE claiming the next task\n` +
          `  - Closed tasks are durable even if the doer crashes mid-streak\n` +
          `  - NEVER close a type=feature or type=bug issue -- only close type=task\n` +
          `Work all listed tasks then stop and return status "VERIFY".\n` +
          `Always return VERIFY -- never return anything else.`;

        const doerResult = await dispatchFleet(doerMember, doerPrompt, {
          label: doerLabel, phase: 'Develop', cycle: cycleCount,
          schema: DOER_STATUS_SCHEMA,
        });

        if (!doerResult) {
          log('Doer returned null (streak ' + streak.model + ') -- resetting orphaned in_progress tasks and retrying');
          const ipExtractD = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(d).map(i=>i.id).join(' '))}catch{}"`;
          const ipResult = await dispatchShellFleet(
            [`bd list --status=in_progress --type=task --json | ${ipExtractD}`],
            'pm-doer-cheap',
            { label: 'reset-orphans-c' + cycleCount + '-r' + devIter, phase: 'Develop', cycle: cycleCount }
          );
          const ipIds = ((ipResult && ipResult.outputs && ipResult.outputs[0]) || '')
            .trim().split(/\s+/).filter(Boolean);
          if (ipIds.length > 0) {
            const resetCmds = ipIds.map(id => `bd update ${id} --status=open`);
            await dispatchShellFleet(resetCmds, 'pm-doer-cheap', {
              label: 'reset-open-c' + cycleCount + '-r' + devIter, phase: 'Develop', cycle: cycleCount,
            });
            log('Reset ' + ipIds.length + ' in_progress task(s) to open: ' + ipIds.join(', '));
          }
          doerNullReset = true;
          break;
        }

        if (doerResult.status !== 'VERIFY') {
          log('Unexpected doer status "' + doerResult.status + '" -- aborting');
          abortReason = 'unexpected doer status';
          streakAbort = true;
          break;
        }
        workedIds.push(...fittedIds);
      }

      devIter++;
      if (doerNullReset) continue;
      if (streakAbort) break;

      // Reviewer tier: any premium -> premium; otherwise standard.
      const usedModels = streakResult.streaks.map(s => s.model);
      const reviewerModel = usedModels.includes(TIER_PREMIUM) ? TIER_PREMIUM : TIER_STANDARD;
      const reviewerLabel = `reviewer-c${cycleCount}-r${devIter}: ${labelTaskIds(workedIds)}`;

      const reviewerPrompt =
        `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
        `Sprint goals: ${rootSummary}\nTasks worked this iteration: ${workedIds.join(', ')}\n\n` +
        `Review ONLY the work done for the tasks listed above.\n` +
        `Run: bd show <id> for each task to read its acceptance criteria.\n` +
        `Run: git -C "${repo}" diff ${base_branch}...${branch} to see the changes.\n` +
        `Do NOT comment on code or issues outside the listed tasks.\n` +
        `Check: code correctness, test coverage, adherence to each task's acceptance criteria.\n` +
        `If a task needs rework, reopen it: bd update <id> --status=open\n` +
        `CHANGES NEEDED verdict must include specific actionable feedback tied to a task ID.\n` +
        `APPROVED means all committed work meets acceptance criteria.`;

      const review = await dispatchFleet('pm-reviewer', reviewerPrompt, {
        label: reviewerLabel, phase: 'Develop', cycle: cycleCount,
        schema: REVIEW_SCHEMA,
      });
      log('Reviewer c' + cycleCount + '-r' + devIter + ': ' +
          ((review && review.verdict) || 'null') + ' -- ' + labelTaskIds(workedIds));

      if (!approved(review)) {
        devFeedback = (review && review.notes) || '';
        log('Reviewer feedback: ' + devFeedback.slice(0, 120));
        // Write feedback.md to disk synchronously to avoid race conditions.
        const devFbLabel = 'feedback-write-' + reviewerLabel;
        const devFbStart = Date.now();
        updateLiveState({ currentAgent: devFbLabel, currentModel: 'native', currentPhase: 'Develop', currentCycle: cycleCount, currentStartTime: devFbStart });
        fs.writeFileSync(pathJoin(repo, 'feedback.md'), devFeedback);
        dispatchLedger.push({ cycle: cycleCount, phase: 'Develop', label: devFbLabel, model: 'native', outTokens: 0, costUsd: 0, durationMs: Date.now() - devFbStart });
      } else {
        devFeedback = '';
      }

      writeSprintState(stateFileRel, {
        type: 'checkpoint', cycle: cycleCount, phase: 'Develop', devIter, branch, goal, rootIds, startedAt,
      }, 'Develop', 'state-c' + cycleCount + '-dev-r' + devIter);
    }

    if (abortReason) {
      // Returning so outer orchestrator can break
    }

  return { abortReason, devFeedback };
}
