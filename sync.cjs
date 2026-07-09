const fs = require('fs');

const html = fs.readFileSync('skills/auto-sprint/lib/status-dashboard.html', 'utf8');

const jsCode = `// Generated from status-dashboard.html by sync.js
export const STATUS_HTML = ${JSON.stringify(html)};

export function writeStaticHtmlReport({ _globalRepo, _liveState, safeWriteFile, log, pathJoin }) {
  if (!_liveState || !_globalRepo) return;
  const outPath = pathJoin(_globalRepo, 'sprint-logs', 'auto-sprint-report.html');
  try {
    safeWriteFile(outPath, STATUS_HTML, 'html-report');
    if (log) log('[STATUS] Saved static HTML report to ' + outPath);
    return outPath;
  } catch(e) {
    if (log) log('[STATUS] Failed to save HTML report: ' + e);
    return null;
  }
}
`;

fs.writeFileSync('skills/auto-sprint/lib/status-html.js', jsCode);
console.log('Successfully synced status-dashboard.html to lib/status-html.js');
console.log('Synced status-html.js');
