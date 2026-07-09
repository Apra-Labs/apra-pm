// CI schema is duplicated here temporarily or we can pass it in. For a layered architecture,
// we should probably have a schemas.js file, but for now we'll define it here.
const CI_SCHEMA = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['green', 'red', 'not_configured', 'pending'] },
    notes:  { type: 'string' },
  },
};

/**
 * Runs the CI Watcher logic for the Harvest phase.
 * @param {Object} deps - Dependencies: dispatchFleet, log, prNumber, branch, cycleCount
 */
async function runCiWatcher({ dispatchFleet, log, prNumber, branch, cycleCount }) {
  if (!prNumber) {
    return; // CI watcher dispatch is conditioned on prNumber
  }

  const ciPrompt =
    'Check CI status for PR #' + prNumber + ' on branch ' + branch + '.\n' +
    'Run: gh run list --pr ' + prNumber + ' --limit 3 --json status,conclusion,databaseId\n' +
    'If runs exist and are in_progress: poll with gh run watch <id> (timeout 10 min).\n' +
    'If runs exist and conclusion is "success": return status "green".\n' +
    'If runs exist and conclusion is "failure": return status "red" with notes (include run URL).\n' +
    'If no runs found: return status "not_configured".\n' +
    'Do not block for more than 10 minutes total.';

  const ciResult = await dispatchFleet('pm-doer-cheap', ciPrompt, {
    label: 'ci-watcher', phase: 'Harvest', cycle: cycleCount,
    schema: CI_SCHEMA,
  });

  if (ciResult) {
    log('CI status: ' + ciResult.status);

    if (ciResult.status === 'not_configured') {
      log('CI not configured -- checking for existing open CI pipeline task');
      const dedupSchema = {
        type: 'object', required: ['exists', 'id'],
        properties: { exists: { type: 'boolean' }, id: { type: 'string' } },
      };
      const dedupResult = await dispatchFleet('pm-doer-cheap',
        'Run: bd search "Add CI pipeline" --status=open --json\n' +
        'Parse the JSON output and look for any issue whose title matches ' +
        '"Add CI pipeline to project" (exact or close variant, case-insensitive).\n' +
        'If a matching OPEN issue is found, return JSON: {"exists": true, "id": "<issue-id>"}\n' +
        'If no matching open issue is found (or the command returns empty/no results), ' +
        'return JSON: {"exists": false, "id": null}',
        { label: 'ci-task-dedup', phase: 'Harvest', cycle: cycleCount, schema: dedupSchema });

      if (dedupResult && dedupResult.exists) {
        log('CI pipeline task already exists: ' + dedupResult.id + ' -- skipping creation');
      } else {
        await dispatchFleet('pm-doer-cheap',
          'Run: bd create --title="Add CI pipeline to project" ' +
          '--description="The auto-sprint workflow found no CI runs for branch ' + branch + '. ' +
          'CI is required for the sprint exit gate. ' +
          'This task covers: choosing a CI provider, writing the workflow config, and verifying it triggers on push." ' +
          '--type=task --priority=2\n' +
          'Then run: bd show <new-id> and confirm it was created.',
          { label: 'ci-task-create', phase: 'Harvest', cycle: cycleCount });
        log('ACTION REQUIRED: Set up CI for this project. Task created in beads.');
      }
    } else if (ciResult.status === 'red') {
      log('CI FAILED: ' + ((ciResult.notes || '').slice(0, 200)));
    }

    if (ciResult.status !== 'green') {
      const ciNotes = ciResult.notes ? '\\n\\n' + ciResult.notes : '';
      await dispatchFleet('pm-doer-cheap',
        'Annotate PR #' + prNumber + ' with the CI status result.\n\n' +
        'Run: gh pr comment ' + prNumber + ' --body "**CI status: ' +
        ciResult.status + '**' + ciNotes + '"',
        { label: 'ci-pr-annotate', phase: 'Harvest', cycle: cycleCount });
    }
  }
}

export { runCiWatcher };
