import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..');
const installMjs = join(REPO_ROOT, 'install.mjs');
const pkgJsonPath = join(REPO_ROOT, 'package.json');

const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
const expectedVersion = pkg.version;

test('install.mjs --version prints package.json version and exits with 0', () => {
  const result = spawnSync('node', [installMjs, '--version'], { encoding: 'utf-8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), expectedVersion);
});

test('install.mjs -v prints package.json version and exits with 0', () => {
  const result = spawnSync('node', [installMjs, '-v'], { encoding: 'utf-8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), expectedVersion);
});
