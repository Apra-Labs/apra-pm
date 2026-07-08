import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStatusServer } from '../../skills/auto-sprint/lib/status-server.js';

describe('status-server', () => {
  let server = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  const fetchJson = (url, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });

  test('GET / returns STATUS_HTML', async () => {
    const deps = {
      port: 0, repo: '.', STATUS_HTML: '<html>MOCK</html>',
      getLiveState: () => ({}), dispatchLedger: [], dispatchOutputs: {},
      fs: { existsSync: () => false }, pathJoin: (...args) => args.join('/'),
      log: () => {}, setAbortRequested: () => {}, execSync: () => {}, platform: 'linux'
    };
    
    server = startStatusServer(deps);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    
    const html = await fetchJson(`http://127.0.0.1:${port}/`);
    assert.equal(html, '<html>MOCK</html>');
  });

  test('GET /state returns JSON state with ledger and file existence flags', async () => {
    const deps = {
      port: 0, repo: 'mock-repo', STATUS_HTML: '',
      getLiveState: () => ({ phase: 'Develop' }), 
      dispatchLedger: [{ phase: 'Plan' }], dispatchOutputs: {},
      fs: { existsSync: (p) => p === 'mock-repo/deploy.md' }, 
      pathJoin: (...args) => args.join('/'),
      log: () => {}, setAbortRequested: () => {}, execSync: () => {}, platform: 'linux'
    };
    
    server = startStatusServer(deps);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    
    const state = await fetchJson(`http://127.0.0.1:${port}/state`);
    assert.equal(state.phase, 'Develop');
    assert.equal(state.deployMdExists, true);
    assert.equal(state.playbookExists, false);
    assert.equal(state.ledger.length, 1);
  });

  test('GET /log?label= returns output for task', async () => {
    const deps = {
      port: 0, repo: '.', STATUS_HTML: '',
      getLiveState: () => ({}), dispatchLedger: [], 
      dispatchOutputs: { 'task-1': 'Output for task 1' },
      fs: { existsSync: () => false }, pathJoin: (...args) => args.join('/'),
      log: () => {}, setAbortRequested: () => {}, execSync: () => {}, platform: 'linux'
    };
    
    server = startStatusServer(deps);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    
    const logOut = await fetchJson(`http://127.0.0.1:${port}/log?label=task-1`);
    assert.equal(logOut, 'Output for task 1');
    
    const miss = await fetchJson(`http://127.0.0.1:${port}/log?label=unknown`);
    assert.equal(miss, 'No output found for task: unknown');
  });

  test('POST /stop sets abortRequested to true', async () => {
    let aborted = false;
    const deps = {
      port: 0, repo: '.', STATUS_HTML: '',
      getLiveState: () => ({}), dispatchLedger: [], dispatchOutputs: {},
      fs: { existsSync: () => false }, pathJoin: (...args) => args.join('/'),
      log: () => {}, execSync: () => {}, platform: 'linux',
      setAbortRequested: (val) => aborted = val
    };
    
    server = startStatusServer(deps);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    
    const res = await fetchJson(`http://127.0.0.1:${port}/stop`, 'POST');
    assert.equal(res.status, 'stopping');
    assert.equal(aborted, true);
  });
});
