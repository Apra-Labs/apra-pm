import http from 'node:http';

export function startStatusServer({ 
  port, repo, STATUS_HTML, getLiveState, 
  dispatchLedger, dispatchOutputs, fs, pathJoin, log, 
  setAbortRequested, execSync, platform 
}) {
  let server = null;
  try {
    server = http.createServer(function(req, res) {
      if (req.url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const _repo = typeof repo === 'string' && repo ? repo : '.';
        const deployMdExists = fs.existsSync(pathJoin(_repo, 'deploy.md'));
        const playbookExists = fs.existsSync(pathJoin(_repo, 'integ-test-playbook.md'));
        const statePayload = Object.assign({}, getLiveState(), { ledger: dispatchLedger, deployMdExists, playbookExists });
        res.end(JSON.stringify(statePayload));
        return;
      }
      if (req.url.startsWith('/log?label=')) {
        const u = new URL(req.url, 'http://localhost');
        const l = u.searchParams.get('label');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(dispatchOutputs[l] || 'No output found for task: ' + l);
        return;
      }
      if (req.url === '/stop' && req.method === 'POST') {
        setAbortRequested(true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'stopping' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(STATUS_HTML);
    });
    
    server.listen(port, '127.0.0.1', function() {
      log('[STATUS] Sprint dashboard: http://127.0.0.1:' + port);
      try {
        const _openCmd = platform === 'win32'
          ? 'start http://127.0.0.1:' + port
          : platform === 'darwin'
          ? 'open http://127.0.0.1:' + port
          : 'xdg-open http://127.0.0.1:' + port;
        if (execSync) execSync(_openCmd, { stdio: 'ignore', timeout: 5000 });
      } catch {}
    });
    
    server.on('error', function(err) {
      log('[WARN] Status server error: ' + err.message);
    });
  } catch (err) {
    log('[WARN] Status server failed to start: ' + err.message);
  }
  return server;
}
