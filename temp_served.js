
    const phases = ['setup', 'Plan', 'Develop', 'Test', 'Harvest', '?'];
    window.expandedActs = new Set();
    window.allActsForToggle = new Set();
    window.toggleAct = function(label) {
      if (window.expandedActs.has(label)) window.expandedActs.delete(label);
      else window.expandedActs.add(label);
      poll();
    };
    window.expandAll = function() {
      window.allActsForToggle.forEach(l => window.expandedActs.add(l));
      poll();
    };
    window.collapseAll = function() {
      window.expandedActs.clear();
      poll();
    };

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
      const match = label.match(/-c(\d+)-r(\d+)/);
      if (match) return 'C' + match[1] + ' R' + match[2];
      const matchC = label.match(/-c(\d+)/);
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
        
        document.querySelectorAll('.phase-item').forEach(el => {
          if (el.dataset.phase.toLowerCase() === currentPhase.toLowerCase()) el.classList.add('active');
          else el.classList.remove('active');
        });
        
        const sprintBeads = s.sprintBeads || [];
        const openTasks = sprintBeads.filter(b => b.t === 'task' && b.s === 'open').length;
        
        document.getElementById('stat-cycle').textContent = (s.cycle || 0) + '/' + (s.maxCycles || '?');
        document.getElementById('stat-open').textContent = openTasks > 0 ? openTasks : (s.openCount != null ? s.openCount : '-');
        const actualCost = s.costUsd || 0;
        const budget = 10.00;
        document.getElementById('stat-cost').textContent = '$' + actualCost.toFixed(2) + ' / $' + budget.toFixed(2);
        
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
             const kids = b.dependencies ? b.dependencies.map(d => d.depends_on_id) : [];
             if (kids && kids.length > 0) {
                 kids.forEach(cId => {
                     const child = sprintBeads.find(x => x.id === cId);
                     if (child) {
                         renderNode(child, depth + 1);
                     }
                 });
             }
          }
          
          const sprintIssueIds = s.rootIds || s.issues || [];
          const sprintRoots = sprintBeads.filter(b => sprintIssueIds.includes(b.id));
          sprintRoots.forEach(r => renderNode(r, 0));
          
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
        
        let currentLogLabel = 'System';
        const logsByLabel = { 'System': [] };
        if (s.log) {
          s.log.forEach(line => {
             const msg = line.replace(/^.*?Z /, '').trim();
             const match = msg.match(/^dispatch:s+([w-]+)/);
             if (match) currentLogLabel = match[1];
             if (!logsByLabel[currentLogLabel]) logsByLabel[currentLogLabel] = [];
             logsByLabel[currentLogLabel].push(line);
          });
        }
        
        const _ledger = s.ledger || [];
        const mergedActs = [..._ledger];
        if (s.currentAgent && !s.goalMet && !s.abortReason) {
           const isAlreadyInLedger = _ledger.length > 0 && _ledger[_ledger.length - 1].label === s.currentAgent && !_ledger[_ledger.length - 1].durationMs;
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
        
        if (logsByLabel['System'] && logsByLabel['System'].length > 0 && !mergedActs.some(a => a.label === 'System')) {
           mergedActs.unshift({
              phase: 'setup',
              label: 'System',
              model: '-',
              durationMs: 0,
              isRunning: false,
              outTokens: '-'
           });
        }
        
        window.allActsForToggle.clear();
        mergedActs.forEach(a => window.allActsForToggle.add(a.label));
        
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
                     '<th style="padding:10px 12px; font-weight:500;">Action</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Model</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Duration</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Tokens</th>' +
                     '<th style="padding:10px 12px; font-weight:500;">Round</th></tr></thead><tbody>';
          
          function renderLogLine(line) {
            function escapeHTML(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
            const timeMatch = line.match(/202\d-[\d\-T:.]+Z/);
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
            return '<div class="log-line" style="display:flex; gap:12px;"><span class="log-time" style="opacity:0.5; width:65px; flex-shrink:0;">' + localTime + '</span><span class="log-msg ' + cls + '">' + msg + '</span></div>';
          }
          
          for (const phase of phases) {
            const acts = byPhase[phase];
            if (acts && acts.length > 0) {
               acts.forEach(act => {
                 let isWarning = false;
                 if (act.verdict) {
                    const v = String(act.verdict).toUpperCase();
                    if (v === 'CHANGES NEEDED' || v === 'FAILED' || v === 'RED' || v.includes('BUGS')) isWarning = true;
                 }
                 const isExpanded = window.expandedActs.has(act.label);
                 const toggleIcon = isExpanded ? '▼' : '▶';
                 const statusStyle = act.isRunning ? 'color:var(--accent); font-weight:bold;' : (isWarning ? 'color:var(--warning); font-weight:500;' : 'color:var(--success);');
                 const bgStyle = act.isRunning ? 'background: rgba(59, 130, 246, 0.05);' : (isWarning ? 'background: rgba(245, 158, 11, 0.05);' : '');
                 const icon = act.isRunning ? '<span style="display:inline-block; animation: pulse 1.5s infinite;">⚡</span> ' : (isWarning ? '⚠️ ' : '✓ ');
                 
                 let insight = '';
                 if (act.label.includes('planner')) insight = 'Breaking down features into actionable tasks';
                 else if (act.label.includes('reviewer')) insight = 'Evaluating code/plan quality and correctness';
                 else if (act.label.includes('doer')) insight = 'Writing code and implementing requirements';
                 else if (act.label.includes('integ')) insight = 'Running integration test playbook';
                 else if (act.label.includes('harvester')) insight = 'Committing changes, closing tasks, syncing DB';
                 else if (act.label === 'System') insight = 'Orchestrator and sprint setup logs';
                 
                 html += '<tr style="border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer; ' + bgStyle + '" onclick="toggleAct(\'' + act.label + '\')">' +
                         '<td style="padding:10px 12px; width:150px; ' + statusStyle + '"><span style="display:inline-block; width:16px; opacity:0.6;">' + toggleIcon + '</span> ' + icon + phase + '</td>' +
                         '<td style="padding:10px 12px; font-weight:600; color:var(--text);" title="' + insight + '">' + act.label + '</td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + 
                           (act.model === "pm-doer-std" ? "Standard" : 
                           (act.model === "pm-doer-cheap" ? "Cheap" : 
                           (act.model === "pm-doer-prem" ? "Premium" : 
                           (act.model === "native" ? "Orchestrator" : act.model)))) + 
                         '</td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + formatDuration(act.durationMs) + '</td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + (act.outTokens || (act.isRunning ? '-' : '0')) + ' <a href="/log?label=' + act.label + '" target="_blank" title="View LLM details" style="text-decoration:none; margin-left:4px;" onclick="event.stopPropagation()">🔍</a></td>' +
                         '<td style="padding:10px 12px; color:var(--text-muted);">' + parseCycleRound(act.label, act.cycle) + '</td>' +
                         '</tr>';
                         
                 if (isExpanded) {
                    const logLines = logsByLabel[act.label] || [];
                    let termInner = '';
                    if (logLines.length === 0) termInner = '<div style="color:var(--text-muted);">No logs yet...</div>';
                    else termInner = logLines.map(renderLogLine).join('');
                    
                    html += '<tr style="background:rgba(0,0,0,0.3); border-bottom:1px solid rgba(255,255,255,0.05);">' +
                            '<td colspan="6" style="padding: 0;">' +
                            '<div class="terminal" style="max-height: 400px; margin: 0; border: none; border-radius: 0; font-size: 11px; padding: 12px 16px; font-family: \'JetBrains Mono\', Consolas, monospace;">' + termInner + '</div>' +
                            '</td></tr>';
                 }
               });
            }
          }
          html += '</tbody>';
          if (taskList.innerHTML !== html) taskList.innerHTML = html;
        }
        
      } catch(e) {
        document.getElementById('connection-status').innerHTML = '<div style="width:8px;height:8px;background:var(--danger);border-radius:50%;"></div> Offline';
        document.getElementById('connection-status').style.color = 'var(--danger)';
      }
    }
    
    poll();
    setInterval(poll, 2000);
  