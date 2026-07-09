const fs = require('fs');

const html = fs.readFileSync('skills/auto-sprint/lib/status-dashboard.html', 'utf8');

const jsCode = `// Generated from status-dashboard.html by sync.js\nexport const STATUS_HTML = ${JSON.stringify(html)};\n`;

fs.writeFileSync('skills/auto-sprint/lib/status-html.js', jsCode);
console.log('Successfully synced status-dashboard.html to lib/status-html.js');
console.log('Synced status-html.js');
