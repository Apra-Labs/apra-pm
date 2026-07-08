import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeStaticHtmlReport } from '../../skills/auto-sprint/lib/status-html.js';

test('writeStaticHtmlReport generates HTML file replacing dynamic elements', async () => {
  let writtenPath = null;
  let writtenContent = null;
  const safeWriteFile = (file, content, label) => {
    writtenPath = file;
    writtenContent = content;
  };
  const logs = [];
  const log = (msg) => logs.push(msg);

  const deps = {
    _globalRepo: '/mock/repo',
    _globalStartedAt: '2026-07-08T12:00:00.000Z',
    _liveState: { sprintBeads: [] },
    safeWriteFile,
    log,
    pathJoin: (...args) => args.join('/')
  };

  writeStaticHtmlReport(deps);

  assert.ok(writtenPath, 'Should write a file');
  assert.ok(writtenPath.includes('sprint-status-2026-07-08T12-00-00-000Z.html'), 'Filename includes safe timestamp');
  
  assert.ok(writtenContent, 'Should have content');
  assert.match(writtenContent, /const res = { json: async \(\) => \({"sprintBeads":\[\]}\) };/, 'Replaces fetch with static state JSON');
  assert.match(writtenContent, /poll\(\); \/\/ static report/, 'Replaces setInterval with static poll()');
});

test('writeStaticHtmlReport gracefully handles write failures', async () => {
  const safeWriteFile = () => { throw new Error('Disk full'); };
  const logs = [];
  const log = (msg) => logs.push(msg);

  const deps = {
    _globalRepo: '/mock/repo',
    _globalStartedAt: '2026-07-08T12:00:00.000Z',
    _liveState: {},
    safeWriteFile,
    log,
    pathJoin: (...args) => args.join('/')
  };

  // Should not throw, should log the error
  writeStaticHtmlReport(deps);
  assert.match(logs[0], /Failed to write HTML report: Disk full/, 'Must log write failures instead of crashing');
});
