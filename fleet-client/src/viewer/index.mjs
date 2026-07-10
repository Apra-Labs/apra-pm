import http from 'http';

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Workflow Dashboard</title>
  <style>
    :root {
      --bg: #09090b; --bg-glass: rgba(24, 24, 27, 0.6); --border: rgba(255, 255, 255, 0.1);
      --text: #e4e4e7; --text-muted: #a1a1aa; --accent: #3b82f6; --accent-glow: rgba(59, 130, 246, 0.2);
      --success: #10b981; --warning: #f59e0b; --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg); color: var(--text); font-family: sans-serif;
      min-height: 100vh; display: flex; flex-direction: column;
    }
    .header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 20px 40px; background: var(--bg-glass); border-bottom: 1px solid var(--border);
    }
    .header h1 { font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 12px; }
    .main-content { display: flex; flex: 1; overflow: hidden; }
    .sidebar { width: 250px; border-right: 1px solid var(--border); padding: 30px; background: var(--bg-glass); overflow-y: auto; }
    .phase-tracker { list-style: none; }
    .phase-item { padding: 8px 12px; font-size: 14px; color: var(--text-muted); border-radius: 6px; margin-bottom: 4px; transition: all 0.2s; }
    .phase-item::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; border: 1px solid currentColor; margin-right: 8px; }
    .phase-item.active { background: rgba(255,255,255,0.05); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
    .phase-item.active::before { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 8px var(--accent); }
    .content-area { flex: 1; padding: 30px 40px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
    
    .panel { background: var(--bg-glass); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
    .panel-header { padding: 12px 16px; font-size: 13px; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02); text-transform: uppercase; }
    
    table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
    th, td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    th { background: #18181b; font-weight: 500; color: var(--text-muted); }
    
    .terminal { background: #000; padding: 16px; font-family: monospace; font-size: 12px; color: #d4d4d8; height: 300px; overflow-y: auto; }
    .log-line { display: flex; gap: 12px; padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
    .log-time { color: #52525b; width: 65px; flex-shrink: 0; }
    .log-msg { white-space: pre-wrap; word-break: break-all; }
    
    .status-badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .status-running { background: var(--accent-glow); color: var(--accent); }
    .status-success { background: rgba(16, 185, 129, 0.1); color: var(--success); }
    .status-error { background: rgba(239, 68, 68, 0.1); color: var(--danger); }
  </style>
</head>
<body>
  <div class="header">
    <h1><span id="workflow-name">Loading...</span></h1>
    <div id="status-indicator" style="font-size: 13px; font-weight: 600;"></div>
  </div>
  <div class="main-content">
    <div class="sidebar">
      <div style="font-size: 13px; font-weight: 600; margin-bottom: 16px; color: var(--text-muted); text-transform: uppercase;">Phases</div>
      <ul class="phase-tracker" id="phase-list"></ul>
    </div>
    <div class="content-area">
      <div class="panel">
        <div class="panel-header">Action Ledger</div>
        <div style="max-height: 400px; overflow-y: auto;">
          <table>
            <thead>
              <tr><th>Phase</th><th>Type</th><th>Label / Member</th><th>Model</th><th>Duration</th><th>Status</th></tr>
            </thead>
            <tbody id="ledger-list"></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">Workflow Logs</div>
        <div class="terminal" id="log-list"></div>
      </div>
    </div>
  </div>
  <script>
    function formatTime(ms) {
      if (ms === undefined) return '-';
      return (ms / 1000).toFixed(1) + 's';
    }
    
    async function poll() {
      try {
        const res = await fetch('/state');
        const state = await res.json();
        
        document.getElementById('workflow-name').textContent = state.workflowName;
        
        const ind = document.getElementById('status-indicator');
        if (state.status === 'running') { ind.innerHTML = '<span style="color:var(--accent)">Live</span>'; }
        else if (state.status === 'success') { ind.innerHTML = '<span style="color:var(--success)">Completed</span>'; }
        else { ind.innerHTML = '<span style="color:var(--danger)">Failed</span>'; }
        
        const phaseHtml = state.phases.map(p => 
          \`<li class="phase-item \${p === state.currentPhase ? 'active' : ''}">\${p}</li>\`
        ).join('');
        document.getElementById('phase-list').innerHTML = phaseHtml;
        
        const ledgerHtml = state.ledger.map(act => {
          let badge = '';
          if (act.isRunning) badge = '<span class="status-badge status-running">Running</span>';
          else if (act.success) badge = '<span class="status-badge status-success">Success</span>';
          else badge = '<span class="status-badge status-error">Failed</span>';
          
          return \`<tr>
            <td>\${act.phase}</td>
            <td style="text-transform: uppercase; font-size: 11px; font-weight:600; color:var(--text-muted);">\${act.type}</td>
            <td><strong>\${act.label}</strong> <span style="color:var(--text-muted); font-size: 11px;">(\${act.member})</span></td>
            <td>\${act.model || '-'}</td>
            <td>\${formatTime(act.duration)}</td>
            <td>\${badge}</td>
          </tr>\`;
        }).reverse().join('');
        document.getElementById('ledger-list').innerHTML = ledgerHtml;
        
        const logHtml = state.logs.map(l => {
          const t = new Date(l.time).toLocaleTimeString([], { hour12: false });
          return \`<div class="log-line"><span class="log-time">\${t}</span><span class="log-msg">[\${l.phase}] \${l.msg}</span></div>\`;
        }).join('');
        const logEl = document.getElementById('log-list');
        const needsScroll = (logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20);
        logEl.innerHTML = logHtml;
        if (needsScroll) logEl.scrollTop = logEl.scrollHeight;
        
      } catch(e) {}
    }
    setInterval(poll, 1000);
    poll();
  </script>
</body>
</html>`;

export function startViewer(workflow, options = {}) {
    const port = options.port || 8080;
    
    const state = {
        workflowName: options.name || 'Apra Fleet Workflow',
        phases: options.phases || ['init'],
        currentPhase: 'init',
        ledger: [],
        logs: [],
        status: 'running'
    };

    workflow.on('phase', (title) => {
        state.currentPhase = title;
        if (!state.phases.includes(title)) {
            state.phases.push(title);
        }
    });

    workflow.on('log', (data) => {
        state.logs.push({ time: new Date().toISOString(), phase: data.phase, msg: data.msg });
    });

    workflow.on('action:start', (meta) => {
        state.ledger.push({ ...meta, isRunning: true });
    });

    workflow.on('action:end', (meta) => {
        const idx = state.ledger.findIndex(a => a.id === meta.id);
        if (idx >= 0) {
            state.ledger[idx] = { ...state.ledger[idx], ...meta, isRunning: false };
        }
    });

    const server = http.createServer((req, res) => {
        if (req.url === '/state') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(state));
        } else if (req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(HTML_TEMPLATE);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    server.listen(port, () => {
        console.log(`[Viewer] Workflow Dashboard live at http://localhost:${port}`);
    });

    return {
        stop: () => server.close(),
        markComplete: (success) => { state.status = success ? 'success' : 'error'; }
    };
}
