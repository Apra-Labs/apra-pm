export async function runHarvestPhase({
  cycleCount, branch, goal, rootIds, startedAt, repo, base_branch, rootSummary, threshold,
  abortReason, goalMet, prevOpenIds, sprintQuote, calibration, taskAssignments, opts, safeBranch, calibPath,
  updateLiveState, dispatchFleet, clearSprintState, buildSprintSummary, safeWriteFile,
  computeUpdatedCalibration, log, runCiWatcher, pathJoin, REVIEW_SCHEMA, HARVEST_SCHEMA, approved, stateFileRel
}) {
  const finalReviewPrompt =
    'Repo: ' + repo + '\nBranch: ' + branch + '\nBase branch: ' + base_branch + '\n' +
    'Sprint goals: ' + rootSummary + '\nGoal: ' + goal + '\n' +
    (abortReason ? 'Sprint ended early: ' + abortReason + '. Review what was completed.\n' : '') +
    (goalMet ? 'Goal was met: all P<=' + threshold + ' issues resolved.\n' : 'Goal not yet met.\n') +
    '\nReview the overall output of this sprint:\n' +
    '  - Does the work address the original sprint goals?\n' +
    '  - Are there obvious gaps or regressions?\n' +
    '  - Is the codebase in a releasable state for what was completed?\n' +
    'APPROVED means the work is ready to harvest and raise as a PR.\n' +
    'CHANGES NEEDED means critical issues were found; include specific findings in notes.';

  const finalReview = await dispatchFleet('pm-reviewer', finalReviewPrompt, {
    label: 'final-reviewer', phase: 'Harvest', cycle: cycleCount,
    schema: REVIEW_SCHEMA,
  });
  log('Final review: ' + ((finalReview && finalReview.verdict) || 'null'));

  if (!approved(finalReview)) {
    const notes = (finalReview && finalReview.notes) || '';
    log('Final review not approved -- aborting before harvest. Notes: ' + notes.slice(0, 300));
    clearSprintState(stateFileRel, 'state-clear-finalrejected');
    return { harvestSuccess: false, finalReviewRejected: true, finalReviewNotes: notes };
  }

  // Build sprint summary via cost.js (pure JS).
  const sprintSummary = buildSprintSummary(null, sprintQuote, calibration, {
    branch, goal, goalMet, cycleCount,
    tasksCompleted: goalMet ? (sprintQuote ? sprintQuote.tasks.length : 0) : 0,
    tasksOpen: prevOpenIds.length,
    startedAt,
  });

  // Write analysis artifact (sprint-logs/<branch>.analysis.md).
  const analysisFile = pathJoin(repo, 'sprint-logs', safeBranch + '.analysis.md');
  safeWriteFile(analysisFile, sprintSummary.summaryText || '', 'analysis.md');
  log('Sprint analysis written to: ' + analysisFile);

  const harvesterPrompt =
    'Repo: ' + repo + '\nBranch: ' + branch + '\nBase branch: ' + base_branch + '\n' +
    'Sprint goals: ' + rootSummary + '\nCycles completed: ' + cycleCount +
    '\nGoal met: ' + goalMet + '\n\n' +
    'The sprint is complete. Harvest the sprint artefacts.\n' +
    'Follow your runbook (agents/harvester.md).\n\n' +
    'IMPORTANT: Your FIRST action is to commit the analysis artifact below before doing anything else.\n\n' +
    'analysisText (write verbatim to sprint-logs/' + safeBranch + '.analysis.md):\n' +
    (sprintSummary.summaryText || '(no summary)') + '\n\n' +
    'Final review notes to include in CHANGELOG:\n' +
    ((finalReview && finalReview.notes) || '(none)') + '\n\n' +
    'Steps:\n' +
    '  1. Update docs/ and README if API or usage changed.\n' +
    '  2. Append sprint summary to CHANGELOG.md under [Unreleased].\n' +
    '  3. Export beads state: git -C "' + repo + '" add .beads/issues.jsonl\n' +
    '     git -C "' + repo + '" diff --cached --quiet || ' +
    '     git -C "' + repo + '" -c user.name=\'pm\' -c user.email=\'pm@pm.local\' commit -m "chore: export beads state"\n' +
    '  4. Remove sprint scaffold files from PR diff (requirements.md, feedback.md).\n' +
    '  5. Stage sprint-logs/ and push: git -C "' + repo + '" add sprint-logs/ && ' +
    '     git -C "' + repo + '" push origin ' + branch + '\n' +
    '  6. Close delivered sprint goals in beads:\n' +
    rootIds.map(id => '     bd close ' + id + ' --reason="implemented in sprint ' + branch + '"').join('\n') + '\n\n' +
    'Return status "OK" if successful, "FAILED" with notes otherwise.';

  const harvestResult = await dispatchFleet('pm-harvester', harvesterPrompt, {
    label: 'harvester', phase: 'Harvest', cycle: cycleCount,
    schema: HARVEST_SCHEMA,
  });

  if (!harvestResult || harvestResult.status !== 'OK') {
    log('Harvest failed: ' + ((harvestResult && harvestResult.notes) || 'null'));
  }

  // Calibration update (pure JS then write file).
  const updatedCalibration = computeUpdatedCalibration(calibration, null, startedAt, taskAssignments, []);
  safeWriteFile(calibPath, JSON.stringify(updatedCalibration, null, 2) + '\n', 'calibration.json');
  log('Calibration updated: ' + calibPath);

  // Dolt push (non-fatal, can be skipped for tests).
  if (!opts.skip_dolt_push) {
    const doltPushPrompt =
      'Sync beads state to the Dolt remote.\n\n' +
      'Run:\n' +
      '  bd dolt push\n\n' +
      'Capture stdout and stderr. If the command exits 0, log "bd dolt push: OK".\n' +
      'If the command exits non-zero (e.g. no dolt remote configured, network error), log a warning:\n' +
      '  "bd dolt push failed (non-fatal): <reason>"\n' +
      'and continue -- do NOT throw, return an error, or abort.\n\n' +
      'Return "OK" when done (regardless of whether the push succeeded or failed).';
    try {
      await dispatchFleet('pm-harvester', doltPushPrompt, {
        label: 'dolt-push', phase: 'Harvest', cycle: cycleCount,
      });
    } catch (err) {
      log('WARN: dolt push dispatch failed (non-fatal): ' + String(err).slice(0, 120));
    }
  } else {
    log('Skipping dolt push as requested by opts.skip_dolt_push.');
  }

  // ---------------------------------------------------------------- PR + CI (T3.4)

  const prPrompt =
    'In repo ' + repo + ' on branch ' + branch +
    ', create a GitHub pull request targeting ' + base_branch + '.\n' +
    'Command: gh pr create --base ' + base_branch + ' --head ' + branch + '\n' +
    'Title: summarise what was implemented across ' + cycleCount + ' cycle(s).\n' +
    'Body:\n' +
    '  - What was built (per sprint goal)\n' +
    '  - Sprint goal: ' + goal + ' -- ' + (goalMet ? 'MET' : 'NOT MET (partial delivery)') + '\n' +
    '  - Cycles run: ' + cycleCount + '\n' +
    '  - Open items carried forward (if any): bd list --status=open and summarise\n' +
    '  - Final review notes: ' + ((finalReview && finalReview.notes) || '(none)') + '\n' +
    '  - Token cost summary from: bd memories auto-sprint\n\n' +
    'After creating the PR, return its number as prNumber (integer).';

  const harvestPr = await dispatchFleet('pm-harvester', prPrompt, {
    label: 'harvest-pr', phase: 'Harvest', cycle: cycleCount,
    schema: {
      type: 'object', required: ['prNumber'],
      properties: { prNumber: { type: 'number' }, prUrl: { type: 'string' } },
    },
  });
  const prNumber = harvestPr && harvestPr.prNumber;
  log('PR number: ' + (prNumber || 'none'));

  if (runCiWatcher) {
    await runCiWatcher({ dispatchFleet, log, prNumber, branch, cycleCount });
  }

  return { harvestSuccess: true, prNumber };
}
