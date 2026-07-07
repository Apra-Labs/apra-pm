APPROVED

All four fault-tolerance issues have been successfully addressed:

1. ISSUE 2 (HIGH): The while loop body is wrapped in a try/catch, and the Harvest phase is outside and after the while loop, ensuring it always runs.
2. ISSUE 3 (HIGH): The top-level IIFE catch block uses safeWriteFile to output crash-report.json before calling statusServer.close() and exiting.
3. ISSUE 4 (MEDIUM): fs.writeFileSync was replaced with safeWriteFile for both analysis.md and calibration.json.
4. ISSUE 5 (LOW): process.on('unhandledRejection') and process.on('uncaughtException') have been successfully moved to the module top-level.

All verifications passed (node --check, non-ASCII check).