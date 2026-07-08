export async function runTestPhase({
  cycleCount, branch, goal, rootIds, startedAt, repo, rootSummary, threshold, maxCycles, prevOpenIds,
  updateLiveState, writeSprintState, dispatchShellFleet, dispatchFleet, stateFileRel,
  parseBlockers, log, fs, pathJoin, INTEG_RUN_SCHEMA
}) {
  let goalMet = false;
  let abortReason = null;
    updateLiveState({ phase: 'Test', cycle: cycleCount });
    // ---------------------------------------------------------------- TEST (T3.1)

    const _deployMdExists = fs.existsSync(pathJoin(repo, 'deploy.md'));
    const _playbookExists = fs.existsSync(pathJoin(repo, 'integ-test-playbook.md'));

    if (!_deployMdExists && !_playbookExists) {
      log('Test phase: no deploy.md or integ-test-playbook.md found -- skipping');
    } else {
      if (_deployMdExists) {
        const deployerPrompt =
          'Repo: ' + repo + '\nBranch: ' + branch + '\nCycle: ' + cycleCount + '\n\n' +
          'Follow the integration test playbook and deploy.md:\n' +
          (cycleCount === 1
            ? '1. Run the Setup section of integ-test-playbook.md to bring up the test environment.\n'
            : '1. Run the Reset section of integ-test-playbook.md to restore pristine state.\n') +
          '2. Follow all steps in deploy.md to deploy the build.\n' +
          '3. Run the smoke test defined in deploy.md.\n' +
          '4. Return deployed: true if the smoke test passes, false otherwise.\n' +
          '5. If deployed is false, include the error output in notes.';
        const deployResult = await dispatchFleet('pm-doer-std', deployerPrompt, {
          label: 'deployer-c' + cycleCount, phase: 'Test', cycle: cycleCount,
          schema: { type: 'object', required: ['deployed'],
            properties: { deployed: { type: 'boolean' }, notes: { type: 'string' } } },
        });
        if (!deployResult || !deployResult.deployed) {
          const msg = (deployResult && deployResult.notes) || 'no details';
          log('Deploy failed on cycle ' + cycleCount + ': ' + msg.slice(0, 200));
          log('Skipping integration tests this cycle -- teardown and continue');
          await dispatchFleet('pm-doer-std',
            'Run the Teardown section of integ-test-playbook.md to clean up the test environment.',
            { label: 'teardown-c' + cycleCount + '-fail', phase: 'Test', cycle: cycleCount });
        } else if (_playbookExists) {
          const integTestPrompt =
            'Repo: ' + repo + '\nBranch: ' + branch + '\nCycle: ' + cycleCount + '\n' +
            'Sprint goals: ' + rootSummary + '\n\n' +
            'The target features for this sprint are: ' + rootIds.join(', ') + '\n' +
            'For each of these target features, execute its integration tests.\n' +
            'Do NOT query or test features outside of this target list.\n\n' +
            'For each feature:\n' +
            '  PASS: all tests pass -> bd close <feature-id>\n' +
            '  FAIL: tests fail -> bd create --title="[integ] <description>" ' +
            '--description="Feature: <id>\\nExpected: <what>\\nActual: <what>\\nTest: <which>" ' +
            '--type=bug --priority=<1=core requirement unmet, 2=partial, 3=quality>\n' +
            '  Keep feature open on failure or if inconclusive.\n\n' +
            'Priority rules:\n' +
            '  P0: system will not start or core path completely broken\n' +
            '  P1: requirement from sprint goal explicitly not met\n' +
            '  P2: requirement partially met, degraded behaviour\n' +
            '  P3: quality, performance, or UX issue not blocking core function\n\n' +
            'Before creating a new bug, check bd search "[integ]" -- update existing if duplicate.\n\n' +
            'Return featuresClosed (count), issuesCreated (count), summary (one paragraph).';
          const integResult = await dispatchFleet('pm-doer-std', integTestPrompt, {
            label: 'integ-runner-c' + cycleCount, phase: 'Test', cycle: cycleCount,
            schema: INTEG_RUN_SCHEMA,
          });
          if (integResult) {
            log('Integration: ' + integResult.featuresClosed + ' features closed, ' +
                integResult.issuesCreated + ' issues created');
            log('Summary: ' + integResult.summary);
          }
          await dispatchFleet('pm-doer-std',
            'Run the Teardown section of integ-test-playbook.md to fully clean up the test environment.',
            { label: 'teardown-c' + cycleCount, phase: 'Test', cycle: cycleCount });
        }
      }
    }

    writeSprintState(stateFileRel, {
      type: 'checkpoint', cycle: cycleCount, phase: 'Test', branch, goal, rootIds, startedAt,
    }, 'Test', 'state-c' + cycleCount + '-test');

    // ---------------------------------------------------------------- CYCLE EXIT GATE (T3.2)
    const makeBfsExtrExit = (rootsArr) => `const subtree=new Set('${rootsArr.join(' ')}'.split(' ').filter(Boolean));const q=Array.from(subtree);const nodes=g.layout&&g.layout.Nodes;if(nodes){while(q.length>0){const c=q.shift();const n=nodes[c];if(n&&n.DependsOn){for(const d of n.DependsOn)if(!subtree.has(d)){subtree.add(d);q.push(d);}}}}`;

    const _openIdExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(d).map(i=>({id:i.id,p:i.priority}))))}catch{console.log('[]')}"`;
    const _idExtract2    = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(d);${makeBfsExtrExit(rootIds)}console.log(Array.from(subtree).join(' '))}catch{}"`;
    const _exitCmds = [
      ...rootIds.map(id => 'bd graph --json ' + id + ' | ' + _idExtract2),
      'bd list --status=open --json | ' + _openIdExtract,
    ];
    const _exitRaw = await dispatchShellFleet(_exitCmds, 'pm-doer-cheap', {
      label: 'exit-check-c' + cycleCount, phase: 'Test', cycle: cycleCount,
    });
    const _blockers = parseBlockers(
      _exitRaw && _exitRaw.outputs, rootIds.length, rootIds.length, threshold, rootIds);
    const openCount = _blockers.count;
    const currentOpenIds = (_blockers.ids || []).slice().sort();
    updateLiveState({ openCount });

    log('Exit check cycle ' + cycleCount + ': ' + openCount +
        ' blocker(s) at/above ' + goal + ' -- IDs: [' + currentOpenIds.join(', ') + ']');

    if (openCount === 0) {
      goalMet = true;
      log('Goal met -- all P<=' + threshold + ' issues resolved');
      return { goalMet, abortReason, currentOpenIds };
    }

    // No-progress check: if open IDs are identical to last cycle, abort.
    if (cycleCount > 1 && prevOpenIds.length > 0) {
      const prevSorted = prevOpenIds.slice().sort();
      const same = prevSorted.length === currentOpenIds.length &&
        prevSorted.every((id, i) => id === currentOpenIds[i]);
      if (same) {
        log('No progress in cycle ' + cycleCount + ': same ' +
            prevOpenIds.length + ' issues unresolved -- aborting');
        abortReason = 'no-progress';
        prevOpenIds = currentOpenIds;
        return { goalMet, abortReason, currentOpenIds };
      }
    }

    prevOpenIds = currentOpenIds;

    if (cycleCount >= maxCycles) {
      log('Cycle ceiling reached: ' + cycleCount + '/' + maxCycles + ' -- stopping sprint loop');
      return { goalMet, abortReason, currentOpenIds };
    }
  return { goalMet, abortReason, currentOpenIds };
}
