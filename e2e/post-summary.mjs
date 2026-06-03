// Render an e2e results table to the console and, in GitHub Actions, to the job
// summary ($GITHUB_STEP_SUMMARY).
import fs from 'node:fs';

export function postSummary(results) {
  const rows = results
    .map((r) => `| ${r.id} | ${r.provider} | ${r.os} | ${r.status} | ${r.notes || ''} |`)
    .join('\n');
  const table =
    `| Suite | Provider | OS | Result | Notes |\n` +
    `|-------|----------|----|--------|-------|\n` +
    rows;

  const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  const tally = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');

  console.log('\n' + table + '\n');
  console.log(`pm-lite e2e: ${tally}`);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try { fs.appendFileSync(summaryFile, `## pm-lite e2e\n\n${table}\n\n_${tally}_\n`); } catch { /* non-fatal */ }
  }
}
