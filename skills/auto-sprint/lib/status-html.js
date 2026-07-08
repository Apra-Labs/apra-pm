export const STATUS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Auto-Sprint Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --bg-glass: rgba(24, 24, 27, 0.6);
      --border: rgba(255, 255, 255, 0.1);
      --text: #e4e4e7;
      --text-muted: #a1a1aa;
      --accent: #3b82f6;
      --accent-glow: rgba(59, 130, 246, 0.2);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background-image: radial-gradient(circle at 50% 0%, var(--accent-glow) 0%, transparent 50%);
    }
    .header {
      padding: 20px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      background: var(--bg-glass);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header h1 span {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      background: rgba(255,255,255,0.05);
      padding: 4px 10px;
      border-radius: 20px;
    }
    .main-content {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .sidebar {
      width: 250px;
      border-right: 1px solid var(--border);
      padding: 30px;
      background: var(--bg-glass);
      backdrop-filter: blur(12px);
      overflow-y: auto;
    }
    .phase-list { list-style: none; }
    .phase-item {
      padding: 12px 16px;
      margin-bottom: 8px;
      border-radius: 8px;
      color: var(--text-muted);
      font-weight: 500;
      font-size: 14px;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .phase-item::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
      opacity: 0.5;
    }
    .phase-item.active {
      background: rgba(255,255,255,0.05);
      color: var(--text);
      box-shadow: inset 2px 0 0 var(--accent);
    }
    .phase-item.active::before {
      background: var(--accent);
      opacity: 1;
      box-shadow: 0 0 10px var(--accent);
    }
    .content-area {
      flex: 1;
      padding: 30px 40px;
      overflow-y: auto;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    .stat-card {
      background: var(--bg-glass);
      border: 1px solid var(--border);
      padding: 24px;
      border-radius: 16px;
      backdrop-filter: blur(10px);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .stat-card:hover {
      transform: translateY(-2px);
      border-color: rgba(255,255,255,0.2);
    }
    .stat-label {
      font-size: 13px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 700;
    }
    .tasks-section {
      margin-bottom: 40px;
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      color: var(--text-muted);
    }
    .task-item {
      background: var(--bg-glass);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      padding: 12px 16px;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      
    }
    .task-item .task-name { font-weight: 600; font-size: 14px; }
    .task-item .task-agent { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .task-item .task-status { 
      font-size: 11px; 
      padding: 4px 10px; 
      border-radius: 12px; 
      background: rgba(255,255,255,0.1); 
    }
    .task-item.running .task-status { background: var(--accent-glow); color: var(--accent); }
    .task-item.done .task-status { background: rgba(16, 185, 129, 0.1); color: var(--success); border-left-color: var(--success); }
    
    .terminal {
      background: #000;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      line-height: 1.6;
      color: #a1a1aa;
      height: 300px;
      overflow-y: auto;
      margin: 0; font-size: 16px; font-weight: 500; color: var(--text-muted);
      display: flex; align-items: center; gap: 8px;
    }
    .compact-stats {
      display: flex; align-items: center; gap: 16px; font-size: 12px; color: var(--text-muted);
      background: rgba(255,255,255,0.03); padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border);
    }
    .compact-stats strong { color: var(--text); font-weight: 600; margin-left: 4px; }
    
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.9); }
      100% { opacity: 1; transform: scale(1); }
    }
    
    .btn-stop {
      background: rgba(239, 68, 68, 0.1); color: var(--danger); border: 1px solid var(--danger);
      padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600;
      transition: all 0.2s ease; display: flex; align-items: center; gap: 6px;
    }
    .btn-stop:hover { background: rgba(239, 68, 68, 0.2); transform: translateY(-1px); }
    .btn-stop:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    
    .banner {
      padding: 8px 16px; text-align: center; font-weight: 500; font-size: 13px;
      display: none; border-bottom: 1px solid var(--border);
    }
    .banner.success { background: rgba(16, 185, 129, 0.1); color: var(--success); }
    .banner.error { background: rgba(239, 68, 68, 0.1); color: var(--danger); }
    .banner.mission { background: rgba(59, 130, 246, 0.1); color: var(--accent); }

    .main-content {
      flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 16px 24px; gap: 16px;
    }
    
    .top-panels {
      display: flex; gap: 16px; height: 35vh; min-height: 200px;
    }
    
    .panel {
      background: var(--bg-glass); border: 1px solid var(--border); border-radius: 8px;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .panel-header {
      padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--text-muted);
      border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02);
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .panel-body {
      flex: 1; overflow-y: auto;
    }
    
    .activity-panel { flex: 1; }
    .tree-panel {
      flex: 0 0 350px; resize: horizontal; overflow: hidden; min-width: 250px; max-width: 50vw;
    }
    .tree-panel::-webkit-resizer { background-color: var(--border); }
    
    table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
    th, td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    th { position: sticky; top: 0; background: #18181b; font-weight: 500; color: var(--text-muted); z-index: 10; }
    td { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px; }
    
    .task-row {
      padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); transition: background 0.2s;
    }
    .task-row:hover { background: rgba(255,255,255,0.02); }
    
    .terminal-panel {
      flex: 1; display: flex; flex-direction: column; min-height: 200px;
    }
    .terminal {
      flex: 1; background: #000; padding: 12px; overflow-y: auto;
      font-family: var(--font-mono); font-size: 12px; line-height: 1.5; color: #d4d4d8;
      border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;
    }
    .log-line { display: flex; gap: 12px; padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.03); }
    .log-line:hover { background: rgba(255,255,255,0.02); }
    .log-time { color: #52525b; user-select: none; flex-shrink: 0; width: 65px; }
    .log-msg { word-break: break-all; white-space: pre-wrap; flex: 1; }
    .log-msg.highlight { color: #60a5fa; font-weight: 500; }
    .log-msg.error { color: #f87171; }
    .log-msg.success { color: #34d399; font-weight: 500; }
    .log-msg.warning { color: #fbbf24; font-weight: 500; }
    
    .capability-pill {
      display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase;
    }
    .capability-pill.yes { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
    .capability-pill.no { background: rgba(255, 255, 255, 0.05); color: var(--text-muted); border: 1px solid rgba(255, 255, 255, 0.1); }
  </style>
</head>
<body>
  <div class="header">
    <h1>Auto-Sprint <span id="root-badge" style="color:var(--text);font-weight:700"></span> <span style="font-size:14px;color:var(--text-muted);font-weight:400;margin:0 4px">on</span> <span id="branch-badge" style="color:var(--text)">loading...</span></h1>
    
    <div class="compact-stats">
      <div>Phase: <strong id="stat-phase" style="text-transform: capitalize;">-</strong></div>
      <div>Cycle: <strong id="stat-cycle">-</strong></div>
      <div>Open Tasks: <strong id="stat-open">-</strong></div>
      <div>Cost: <strong id="stat-cost">-</strong></div>
      <div>Calls/Tokens: <strong id="stat-calls-tokens">-</strong></div>
      <div id="cap-deploy" class="capability-pill">Deploy</div>
      <div id="cap-integ" class="capability-pill">Integ Tests</div>
    </div>
    
    <div id="connection-status" style="font-size: 12px; color: var(--success); display: flex; align-items: center; gap: 16px;">
      <button id="btn-stop" class="btn-stop" onclick="fetch('/stop',{method:'POST'}).then(()=>{this.disabled=true;this.innerHTML='<span style=\\'display:inline-block;animation:pulse 1.5s infinite;\\'>◼</span> Stopping...';})">◼ Stop</button>
      <div style="display:flex;align-items:center;gap:6px;font-weight:600;"><div style="width:8px;height:8px;background:var(--success);border-radius:50%;box-shadow:0 0 8px var(--success);"></div> Live</div>
    </div>
  </div>
  
  <div class="banner mission" id="mission-banner">Mission: <span id="mission-text"></span></div>
  <div class="banner" id="banner"></div>

  <div class="main-content">
        <li class="phase-item" data-phase="Develop">Develop</li>
        <li class="phase-item" data-phase="Test">Test</li>
        <li class="phase-item" data-phase="Harvest">Harvest</li>
      </ul>
      
      <div class="section-title" style="margin-top: 40px; margin-bottom: 20px;">Active Sprint Tasks</div>
      <div id="sprint-beads" style="max-height: 60vh; overflow-y: auto; font-size: 13px; line-height: 1.4; padding-right: 8px;">
        <div style="color:var(--text-muted);">Loading tasks...</div>
      </div>
    </div>
    
    <div class="content-area">
      <div id="mission-banner" class="banner" style="background: rgba(59, 130, 246, 0.1); border: 1px solid var(--accent); color: #93c5fd; display: none; margin-bottom: 20px;">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--accent); margin-bottom: 4px;">Sprint Mission</div>
        <div id="mission-text" style="color: #fff; font-size: 15px; font-weight: 500;"></div>
      </div>
      <div id="banner" class="banner"></div>
      
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Cycle</div>
          <div class="stat-value" id="stat-cycle">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Open Issues</div>
          <div class="stat-value" id="stat-open">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Cost (USD)</div>
          <div class="stat-value" id="stat-cost" style="color: var(--success);">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Calls / Tokens</div>
          <div class="stat-value" id="stat-calls-tokens" style="font-size: 20px;">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Agent</div>
          <div class="stat-value" id="stat-agent" style="font-size: 18px;">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Workspace Capabilities</div>
          <div style="margin-top: 8px;">
            <div id="cap-deploy" class="capability-pill">Deploy</div>
            <div id="cap-integ" class="capability-pill">Integ Tests</div>
          </div>
        </div>
      </div>
      
      <div class="section-title" style="margin-top: 20px; margin-bottom: 16px;">Task Activity</div>
      <div style="max-height: 35vh; overflow-y: auto; background: var(--bg-glass); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 30px;">
        <table id="task-list" style="width: 100%; border-collapse: collapse; font-size: 13px; text-align: left;">
          <!-- Table rows injected here -->
        </table>
      </div>
      
      <div class="section-title">Terminal Log</div>
      <div class="terminal" id="terminal"></div>
    </div>
  </div>

  <script>
    const phases = ['setup', 'Plan', 'Develop', 'Test', 'Harvest', '?'];
    let lastLogCount = 0;

    function formatDuration(ms) {
      if (!ms || ms < 0) return '-';
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) return h + 'h ' + (m%60) + 'm ' + (s%60) + 's';
      if (m > 0) return m + 'm ' + (s%60) + 's';
      return s + 's';
    }
    
    function parseCycleRound(label, fallbackCycle) {
      const match = label.match(/-c(\\d+)-r(\\d+)/);
      if (match) return 'C' + match[1] + ' R' + match[2];
      const matchC = label.match(/-c(\\d+)/);
      if (matchC) return 'C' + matchC[1];
      if (fallbackCycle === 'setup') return 'C0';
      return 'C' + (fallbackCycle || '?');
    }

    async function poll() {
      try {
        const res = await fetch('/state');
        const s = await res.json();
        
        document.getElementById('branch-badge').textContent = s.branch || '?';
        document.getElementById('root-badge').textContent = Array.isArray(s.rootIds) ? s.rootIds.join(', ') : '?';
        
        const missionBanner = document.getElementById('mission-banner');
        if (s.mission) {
          missionBanner.style.display = 'block';
          document.getElementById('mission-text').textContent = s.mission;
        } else {
          missionBanner.style.display = 'none';
        }
        
        const currentPhase = s.currentPhase || s.phase || 'setup';
        const phaseEl = document.getElementById('stat-phase');
        if (phaseEl) phaseEl.textContent = currentPhase;
        
        const sprintBeads = s.sprintBeads || [];
        const openTasks = sprintBeads.filter(b => b.t === 'task' && b.s === 'open').length;
        
        document.getElementById('stat-cycle').textContent = (s.cycle || 0) + '/' + (s.maxCycles || '?');
        document.getElementById('stat-open').textContent = openTasks > 0 ? openTasks : (s.openCount != null ? s.openCount : '-');
        const actualCost = s.costUsd || 0;
        const budget = 10.00;
        document.getElementById('stat-cost').textContent = '$' + actualCost.toFixed(2) + ' / $' + budget.toFixed(2);
        
        const agentEl = document.getElementById('stat-agent');
        if (agentEl) agentEl.textContent = s.currentAgent || 'Idle';
        
        const ledger = s.ledger || [];
        const callsTokensEl = document.getElementById('stat-calls-tokens');
        if (callsTokensEl) {
          const totalTokens = ledger.reduce((sum, item) => sum + (item.outTokens || 0), 0);
          callsTokensEl.textContent = ledger.length + ' / ' + totalTokens;
        }
        const totalCalls = ledger.length + (s.currentAgent && !s.goalMet && !s.abortReason ? 1 : 0);
        const totalTokens = ledger.reduce((acc, l) => acc + (l.outTokens || 0), 0);
        document.getElementById('stat-calls-tokens').textContent = totalCalls + ' / ' + totalTokens.toLocaleString();
        
        const capDeploy = document.getElementById('cap-deploy');
        capDeploy.className = 'capability-pill ' + (s.deployMdExists ? 'yes' : 'no');
        capDeploy.innerHTML = s.deployMdExists ? 'Deploy &#10003;' : 'Deploy &#10007;';
        
        const capInteg = document.getElementById('cap-integ');
        capInteg.className = 'capability-pill ' + (s.playbookExists ? 'yes' : 'no');
        capInteg.innerHTML = s.playbookExists ? 'Integ Tests &#10003;' : 'Integ Tests &#10007;';
        
        let overallDurationStr = '';
        if (s.startedAt) {
          const startMs = new Date(s.startedAt).getTime();
          const endMs = (s.goalMet || s.abortReason) ? (s.endedAt ? new Date(s.endedAt).getTime() : Date.now()) : Date.now();
          overallDurationStr = ' (Duration: ' + formatDuration(endMs - startMs) + ')';
        }
        document.getElementById('branch-badge').textContent = (s.branch || '?') + overallDurationStr;
        
        const banner = document.getElementById('banner');
        if (s.goalMet) {
          if (banner.className !== 'banner success') {
            banner.className = 'banner success';
            banner.textContent = 'Sprint complete -- Goal MET!';
            banner.style.display = 'block';
          }
        } else if (s.abortReason) {
          if (banner.className !== 'banner error') {
            banner.className = 'banner error';
            banner.textContent = 'Sprint ended: ' + s.abortReason;
            banner.style.display = 'block';
          }
        }
        
        const sprintBeads = s.sprintBeads || [];
        const beadsContainer = document.getElementById('sprint-beads');
        if (sprintBeads.length > 0) {
          let bHtml = '';
          const rendered = new Set();
          const typeLevel = { 'epic': 3, 'feature': 2, 'task': 1 };
          
          function renderNode(b, depth) {
             if (rendered.has(b.id)) return;
             rendered.add(b.id);
             const isClosed = b.s === 'closed';
             const isIp = b.s === 'in_progress';
             const icon = b.t === 'epic' ? '🌟' : (b.t === 'feature' ? '📦' : '📄');
             const color = isClosed ? 'var(--text-muted)' : (isIp ? 'var(--accent)' : 'var(--text)');
             const style = isClosed ? 'text-decoration:line-through; opacity:0.5; filter: grayscale(100%);' : '';
             const titleSafe = (b.title || '').replace(/"/g, '&quot;');
             bHtml += '<div class="task-row" style="color:' + color + '; ' + style + '; padding-left:' + (depth*16) + 'px;" title="' + titleSafe + '">' +
                        '<div style="display:flex; align-items:center; gap:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' +
                          '<span style="font-size:14px; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));">' + icon + '</span>' +
                          '<strong style="letter-spacing: 0.5px; flex-shrink: 0;">' + b.id + '</strong>' +
                          '<span style="opacity:0.85; font-size:11px; margin-top:2px; text-overflow:ellipsis; overflow:hidden;">' + (b.title || '').replace(/</g, '&lt;') + '</span>' +
                        '</div>' +
                      '</div>';
             if (b.children && b.children.length > 0) {
                 b.children.forEach(cId => {
                     const child = sprintBeads.find(x => x.id === cId);
                     // Only render as a visual child if it's strictly a lower hierarchical level
                     // This prevents external blockers (e.g. task -> feature) from rendering as children
                     if (child && (typeLevel[b.t] || 0) > (typeLevel[child.t] || 0)) {
                         renderNode(child, depth + 1);
                     }
                 });
             }
          }
          
          // 1. Render all primary sprint issues first
          const sprintIssueIds = s.issues || [];
          const sprintRoots = sprintBeads.filter(b => sprintIssueIds.includes(b.id));
          sprintRoots.forEach(r => renderNode(r, 0));
          
          // 2. Anything remaining is an external blocker or unrelated task
          const leftovers = sprintBeads.filter(b => !rendered.has(b.id));
          if (leftovers.length > 0) {
              bHtml += '<div style="color:var(--text-muted); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; margin-top:16px; margin-bottom:8px; padding-left:12px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:4px;">Other Dependencies</div>';
              leftovers.forEach(b => renderNode(b, 0));
          }
          if (beadsContainer.innerHTML !== bHtml) beadsContainer.innerHTML = bHtml;
        } else {
          beadsContainer.innerHTML = '<div style="color:var(--text-muted);">No issues tracked yet...</div>';
        }
        
        const taskList = document.getElementById('task-list');
        
        // Merge ledger with currently running task
        const mergedActs = [...ledger];
        if (s.currentAgent && !s.goalMet && !s.abortReason) {
           const isAlreadyInLedger = ledger.length > 0 && ledger[ledger.length - 1].label === s.currentAgent && !ledger[ledger.length - 1].durationMs;
           if (!isAlreadyInLedger) {
             mergedActs.push({
               phase: s.currentPhase || s.phase || '?',
               label: s.currentAgent,
               model: s.currentModel || '...',
               cycle: s.currentCycle || s.cycle || '?',
               durationMs: Date.now() - (s.currentStartTime || Date.now()),
               isRunning: true
             });
           }
        }
        
        if (!mergedActs.length) {
          if (taskList.innerHTML !== '<div style="color:var(--text-muted);font-size:13px;padding:20px;">Waiting for tasks...</div>') 
            taskList.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:20px;">Waiting for tasks...</div>';
        } else {
          const byPhase = {};
          mergedActs.forEach((act, idx) => {
             const phase = act.phase || '?';
             if (!byPhase[phase]) byPhase[phase] = [];
             byPhase[phase].push(act);
          });
          
          let html = '<thead style="color:var(--text-muted); border-bottom:1px solid var(--border); position:sticky; top:0; background:#18181b; z-index:10;"><tr style="background:rgba(255,255,255,0.02);">' +
                     '<th style="padding:10px 12px; font-weight:500;">Phase</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Task</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Agent</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Duration</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Tokens</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Cycle/Round</th></tr></thead><tbody>';
          
          for (const phase of phases) {
            const acts = byPhase[phase];
            if (acts && acts.length > 0) {
               acts.forEach(act => {
                 let isWarning = false;
                 if (act.verdict) {
                    const v = String(act.verdict).toUpperCase();
                    if (v === 'CHANGES NEEDED' || v === 'FAILED' || v === 'RED' || v.includes('BUGS')) isWarning = true;
                 }
                 const statusStyle = act.isRunning ? 'color:var(--accent); font-weight:bold;' : (isWarning ? 'color:var(--warning); font-weight:500;' : 'color:var(--success);');
                 const bgStyle = act.isRunning ? 'background: rgba(59, 130, 246, 0.05);' : (isWarning ? 'background: rgba(245, 158, 11, 0.05);' : '');
                 const icon = act.isRunning ? '<span style="display:inline-block; animation: pulse 1.5s infinite;">⚡</span> ' : (isWarning ? '⚠️ ' : '✓ ');
                 
                 // Insight subtext
                 let insight = '';
                 if (act.label.includes('planner')) insight = 'Breaking down features into actionable tasks';
                 else if (act.label.includes('reviewer')) insight = 'Evaluating code/plan quality and correctness';
                 else if (act.label.includes('doer')) insight = 'Writing code and implementing requirements';
                 else if (act.label.includes('integ')) insight = 'Running integration test playbook';
                 else if (act.label.includes('harvester')) insight = 'Committing changes, closing tasks, syncing DB';
                 
                 html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05); ' + bgStyle + '">' +
                         '<td style="padding:10px 12px; width:130px; ' + statusStyle + '">' + icon + phase + (act.isRunning ? ' (Running)' : ' (Done)') + '</td>' +
                         '<td style="padding:10px 12px; font-weight:600; color:var(--text);">' + act.label + 
                           '<div style="font-weight:400; font-size:11px; color:var(--text-muted); margin-top:2px;">' + insight + '</div></td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + 
                           (act.model === "pm-doer-std" ? "Standard" : 
                           (act.model === "pm-doer-cheap" ? "Cheap" : 
                           (act.model === "pm-doer-prem" ? "Premium" : 
                           (act.model === "native" ? "Orchestrator" : act.model)))) + 
                         '</td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + formatDuration(act.durationMs) + '</td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + (act.outTokens || (act.isRunning ? '-' : '0')) + ' <a href="/log?label=' + act.label + '" target="_blank" title="View LLM details" style="text-decoration:none; margin-left:4px;">🔍</a></td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + parseCycleRound(act.label, act.cycle) + '</td>' +
                         '</tr>';
               });
            }
          }
          html += '</tbody>';
          if (taskList.innerHTML !== html) taskList.innerHTML = html;
        }
        
        if (s.log && s.log.length !== lastLogCount) {
          lastLogCount = s.log.length;
          const term = document.getElementById('terminal');
          term.innerHTML = s.log.map(line => {
            function escapeHTML(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
            // Extract the GMT timestamp
            const timeMatch = line.match(/202\\d-[\\d\\-T:.]+Z/);
            let localTime = '';
            if (timeMatch) {
               const dateObj = new Date(timeMatch[0]);
               localTime = dateObj.toLocaleTimeString([], { hour12: false });
            }
            let msg = line.replace(/^.*?Z /, '');
            msg = escapeHTML(msg.trim());
            const isHighlight = msg.includes('dispatch:') || msg.includes('===');
            const isError = msg.includes('ERROR') || msg.includes('FATAL') || msg.includes('failed');
            const isWarning = msg.includes('CHANGES NEEDED') || msg.includes('BUGS');
            const isSuccess = msg.includes('APPROVED');
            let cls = '';
            if (isError) cls = 'error';
            else if (isWarning) cls = 'warning';
            else if (isSuccess) cls = 'success';
            else if (isHighlight) cls = 'highlight';
            return '<div class="log-line"><span class="log-time">' + localTime + '</span><span class="log-msg ' + cls + '">' + msg + '</span></div>';
          }).join('');
          term.scrollTop = term.scrollHeight;
        }
        
      } catch(e) {
        document.getElementById('connection-status').innerHTML = '<div style="width:8px;height:8px;background:var(--danger);border-radius:50%;"></div> Offline';
        document.getElementById('connection-status').style.color = 'var(--danger)';
      }
    }
    
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;


export function writeStaticHtmlReport({ _globalRepo, _globalStartedAt, _liveState, safeWriteFile, log, pathJoin }) {
  try {
    const ts = new Date(_globalStartedAt).toISOString().replace(/[:.]/g, '-');
    const htmlPath = (pathJoin || require('path').join)(_globalRepo, 'sprint-logs', 'sprint-status-' + ts + '.html');
    const finalStateJson = JSON.stringify(_liveState);
    let finalHtml = STATUS_HTML.replace(
      "const res = await fetch('/state');",
      "const res = { json: async () => (" + finalStateJson + ") };"
    ).replace(
      "setInterval(poll, 2000);",
      "poll(); // static report"
    );
    safeWriteFile(htmlPath, finalHtml, 'Static HTML sprint report');
    log('Static HTML report saved: ' + htmlPath);
  } catch (e) {
    log('Failed to write HTML report: ' + e.message);
  }
}

