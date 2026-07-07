CHANGES NEEDED

======================================================================
PHASE 3 REVIEW - skills/auto-sprint/runner.js
Reviewer: pm-lite-reviewer
======================================================================

----------------------------------------------------------------------
ISSUE 1 (CRITICAL): Line count far exceeds spec
----------------------------------------------------------------------
File:     skills/auto-sprint/runner.js
Line:     N/A (whole file)
Spec:     PLAN.md T3.5 + PHASE 3 VERIFY: "Total line count ~450
          (acceptable range 400-550)"
Actual:   1581 lines (2.87x the maximum of 550)

Required fix:
  The runner.js file must be refactored to fit within 400-550 lines.
  The file grew across all Phase 2+3 tasks without hitting the line
  budget. Options:
  a) Collapse large inline prompt strings into shorter template refs or
     helper functions
  b) Move repeated shell-extract node one-liners into named constants
     defined once at top
  c) Collapse the STATUS_HTML array (lines 266-346, 81 lines) into a
     single string assigned inline
  d) Collapse large prompt strings (plannerPrompt, planReviewPrompt,
     doerPrompt, reviewerPrompt, harvesterPrompt, prPrompt, ciPrompt)
     into helper functions or shorter inline form

----------------------------------------------------------------------
ISSUE 2 (HIGH): Each phase NOT wrapped in individual try/catch
----------------------------------------------------------------------
File:     skills/auto-sprint/runner.js
Lines:    836-1329 (while loop body)
Spec:     T3.7: "Each phase (Plan/Develop/Test/Harvest) wrapped in
          try/catch that logs and continues"
          T3.7: "Cycle loop has try/catch per iteration"
          T3.7: "Harvest phase runs EVEN IF Test or Develop phase threw"

Actual:   The while loop body (line 836) has NO outer try/catch per
          iteration. Plan, Develop, and Test phases are not individually
          wrapped in try/catch. If any phase throws synchronously the
          entire sprint crashes without reaching Harvest.

Required fix:
  Wrap the while loop body in a per-iteration try/catch:

    while (cycleCount < maxCycles) {
      try {
        cycleCount++;
        // ... Plan, Develop, Test phases ...
      } catch (iterErr) {
        log('[ERROR] Cycle ' + cycleCount + ' threw: ' + String(iterErr).slice(0, 200));
        abortReason = 'cycle-error';
        break;
      }
    }

  Additionally wrap each phase block (Plan/Develop/Test) in its own
  try/catch so that e.g. a Test phase error does not prevent the next
  iteration or the Harvest phase from running.

----------------------------------------------------------------------
ISSUE 3 (HIGH): IIFE catch block does not write a minimal report
----------------------------------------------------------------------
File:     skills/auto-sprint/runner.js
Lines:    1574-1579
Spec:     T3.7: "Top-level IIFE has catch block that writes minimal
          report + calls statusServer.close()"

Actual (lines 1574-1579):
  })().catch(function(err) {
    log('[FATAL] Unhandled: ' + String(err));
    updateLiveState({ phase: 'CRASHED', abortReason: String(err) });
    try { if (typeof _statusServer !== 'undefined' && _statusServer) _statusServer.close(); } catch {}
    process.exit(1);
  });

The catch block logs to stdout and closes the server but does NOT write
any minimal report to disk.

Required fix:
  Add a safeWriteFile call inside the catch block before process.exit:

    })().catch(function(err) {
      log('[FATAL] Unhandled: ' + String(err));
      updateLiveState({ phase: 'CRASHED', abortReason: String(err) });
      try {
        var _crashPath = path.join(
          typeof repo !== 'undefined' && repo ? repo : process.cwd(),
          'sprint-logs', 'crash-report.json');
        safeWriteFile(_crashPath,
          JSON.stringify({ crashed: true, error: String(err),
            ts: new Date().toISOString() }, null, 2),
          'crash-report');
      } catch {}
      try { if (typeof _statusServer !== 'undefined' && _statusServer) _statusServer.close(); } catch {}
      process.exit(1);
    });

----------------------------------------------------------------------
ISSUE 4 (MEDIUM): safeWriteFile not used for analysis.md and calibration.json
----------------------------------------------------------------------
File:     skills/auto-sprint/runner.js
Lines:    1378-1383 (analysis.md) and 1420-1425 (calibration.json)
Spec:     T3.7: "safeWriteFile() helper used for all disk writes"

Actual:   Both writes use fs.writeFileSync directly inside try/catch
          instead of calling safeWriteFile(), which already encapsulates
          the try/catch + mkdirSync pattern.

Required fix:
  Line 1378-1383 - replace with:
    safeWriteFile(analysisFile, sprintSummary.summaryText || '', 'sprint analysis');
    log('Sprint analysis written to: ' + analysisFile);

  Line 1420-1425 - replace with:
    safeWriteFile(calibPath, JSON.stringify(updatedCalibration, null, 2), 'calibration');
    log('Calibration updated: ' + calibPath);

----------------------------------------------------------------------
ISSUE 5 (LOW): process.on guards inside IIFE, not at top level
----------------------------------------------------------------------
File:     skills/auto-sprint/runner.js
Lines:    704, 708
Spec:     T3.7: "process.on('unhandledRejection') guard at top level"
          T3.7: "process.on('uncaughtException') guard at top level"

Actual:   Both handlers are registered inside the async IIFE (inside
          the async function main() body). Functionally they still work,
          but the spec says "at top level" - i.e., outside the IIFE,
          before the (async function main() { ... })() invocation.

Required fix:
  Move both process.on registrations to module top level, before the
  IIFE. Since log() is defined at top level, they can call it:

    process.on('unhandledRejection', function(reason) {
      log('[FATAL] unhandledRejection: ' + String(reason));
      updateLiveState({ phase: 'ERROR', abortReason: String(reason) });
    });
    process.on('uncaughtException', function(err) {
      log('[FATAL] uncaughtException: ' + err.message);
      updateLiveState({ phase: 'ERROR', abortReason: err.message });
    });

    (async function main() { ... })().catch(...);

----------------------------------------------------------------------
PASSING CHECKS
----------------------------------------------------------------------
[OK] node --check exits 0 (syntax valid)
[OK] Non-ASCII character count: 0
[OK] All 4 phases present: Plan, Develop, Test, Harvest
[OK] T3.1 deploy.md fs.existsSync check (local, no LLM) - line 1212
[OK] T3.1 integ-test-playbook.md fs.existsSync check - line 1213
[OK] T3.1 deploy.md -> dispatchFleet('pm-doer-std', deployerPrompt) - line 1229
[OK] T3.1 integ-test-playbook.md -> dispatchFleet('pm-doer-std', integTestPrompt, {schema: INTEG_RUN_SCHEMA}) - line 1260
[OK] T3.1 neither exists -> logs correct skip message - line 1216
[OK] T3.1 writeSprintState checkpoint after Test phase - line 1276
[OK] T3.2 openCount===0 -> goalMet=true; break - line 1300-1303
[OK] T3.2 no-progress: sorted prevOpenIds vs currentOpenIds -> abortReason='no-progress'; break - lines 1307-1317
[OK] T3.2 cycleCount >= maxCycles -> log + break - lines 1322-1325
[OK] T3.2 prevOpenIds saved after each cycle - line 1320
[OK] T3.3 dispatchFleet('pm-reviewer', finalReviewPrompt, {schema: REVIEW_SCHEMA}) - line 1351
[OK] T3.3 dispatchFleet('pm-harvester', harvesterPrompt, {schema: HARVEST_SCHEMA}) - line 1409
[OK] T3.3 dolt push wrapped in try/catch (non-fatal) - lines 1437-1443
[OK] T3.3 buildSprintSummary called - line 1369
[OK] T3.3 computeUpdatedCalibration called - line 1419
[OK] T3.3 writes sprint-logs/*.analysis.md - line 1377
[OK] T3.3 writes sprint-logs/calibration.json - line 1421
[OK] T3.4 PR via pm-harvester with schema requiring prNumber - lines 1461-1467
[OK] T3.4 CI via pm-doer-cheap with CI_SCHEMA - line 1481
[OK] T3.4 not_configured -> dedup check first -> create CI task - lines 1489-1516
[OK] T3.4 red -> log failure - line 1518
[OK] T3.4 non-green -> annotate PR - lines 1521-1527
[OK] T3.5 roleOf() strips -c\d+ suffix (exact port) - line 1534
[OK] T3.5 groups dispatchLedger by role - lines 1535-1542
[OK] T3.5 prints table: role, tokens, calls, cost - lines 1545-1552
[OK] T3.5 TOTAL line - line 1551
[OK] T3.5 clearSprintState called - line 1564
[OK] T3.5 returns {cycles, goalMet, goal, harvest, sprintCostUsd} - lines 1566-1572
[OK] T3.6 http.createServer using 'node:http' - line 717
[OK] T3.6 port 3000-3999 via Math.random() - line 714
[OK] T3.6 statusServer.listen before cycle loop - line 726 (loop starts at 836)
[OK] T3.6 URL logged: http://127.0.0.1:<port> - line 727
[OK] T3.6 platform-specific open command (win32/darwin/linux) - lines 729-733
[OK] T3.6 browser open wrapped in try/catch - lines 728-735
[OK] T3.6 /state endpoint returns _liveState as JSON - lines 718-721
[OK] T3.6 STATUS_HTML constant: self-contained, dark theme (#0d1117) - lines 266-346
[OK] T3.6 auto-polls /state every 3s (setInterval(poll,3000)) - line 344
[OK] T3.6 dashboard shows: phase (color-coded), cycle N/M, current agent, cost, open, log tail - lines 308-342
[OK] T3.6 updateLiveState() called at every phase transition - lines 839, 1027, 1209, 1336
[OK] T3.6 _liveState.log ring buffer max 200 entries - line 68
[OK] T3.6 HTML sprint report written to sprint-logs/ - lines 1556-1558
[OK] T3.6 statusServer.close() called at sprint end - line 1562
[OK] T3.6 zero npm dependencies (require uses node: prefix only)
[OK] T3.7 dispatchFleet returns null on all-retries failure - line 546
[OK] T3.7 bdExec wrapped in try/catch returning fallback - lines 131-138
[OK] T3.7 new Date().toISOString() used freely - lines 45, 65, 794
[OK] T3.7 Math.random() used for port selection - line 714
[OK] T3.7 No JSVM restriction workarounds found
[OK] T3.7 All file I/O uses fs module directly
[OK] T3.7 IIFE .catch() closes statusServer - line 1577
[OK] T3.7 safeWriteFile() defined and used for HTML report - lines 51-59, 1558

======================================================================
VERDICT SUMMARY
======================================================================
5 issues found:
  - ISSUE 1 (CRITICAL): Line count 1581 vs spec max 550
  - ISSUE 2 (HIGH):     No per-iteration try/catch in cycle loop;
                        phases not individually fault-isolated
  - ISSUE 3 (HIGH):     IIFE catch does not write minimal report to disk
  - ISSUE 4 (MEDIUM):   safeWriteFile not used for analysis.md and calibration.json
  - ISSUE 5 (LOW):      process.on guards inside IIFE rather than top-level

All Phase 3 functional requirements (T3.1-T3.6 behavior logic) are
correctly implemented. The issues are: one structural spec deviation
(line count), two T3.7 fault-tolerance gaps, and two minor style gaps.