// Independent post-sprint validation gates.
//
// "All checkpoints PASS" is self-reported by the orchestrator and proves nothing.
// These gates assert, from the pushed branch and the real PR, that a disciplined
// plan -> doer -> review sprint actually took place:
//
//   1. pr-exists              a PR was raised for the branch
//   2. commits>=10            the work landed as 10+ commits (not one dump)
//   3. final-changeset-clean  the PR's net diff carries NO process scaffolding
//                             (requirements.md, PLAN.md, feedback.md, progress.json)
//   4. process-discipline     yet those scaffolding files DID appear in intermediate
//                             commits -- proof the planner/reviewer loop was run and
//                             then cleaned up, not skipped
//   5. beads-closed           the P1 issues picked for the sprint were closed on the branch
//
// evaluateGates() is pure (takes gathered facts, returns verdicts) so it is unit
// testable; validateSprint() gathers those facts from a git clone + the PR object.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCAFFOLD = ['requirements.md', 'plan.md', 'feedback.md', 'progress.json'];
const baseName = (p) => p.split('/').pop().toLowerCase();

// ---- pure verdict logic -------------------------------------------------------

export function evaluateGates(d) {
  const gates = [];
  const add = (name, pass, detail = '') => gates.push({ name, pass, detail });

  add('pr-exists', !!(d.pr && d.pr.url), d.pr ? `#${d.pr.number}` : 'no PR found');

  const minCommits = d.minCommits ?? 10;
  add(`commits>=${minCommits}`, (d.commitCount || 0) >= minCommits, `${d.commitCount || 0} commits`);

  const finalBases = (d.finalFiles || []).map(baseName);
  const leaked = SCAFFOLD.filter((f) => finalBases.includes(f));
  add('final-changeset-clean', leaked.length === 0,
    leaked.length ? `process files still in net diff: ${leaked.join(', ')}` : 'no process files in net diff');

  const touched = new Set((d.touchedBasenames || []).map((s) => s.toLowerCase()));
  const missing = SCAFFOLD.filter((f) => !touched.has(f));
  add('process-discipline', missing.length === 0,
    missing.length ? `never committed (no discipline proof): ${missing.join(', ')}` : 'all process files appeared in intermediate commits');

  const expected = d.expectedIssues ?? 3;
  const closed = d.closedP1 || [];
  add('beads-closed', closed.length >= expected,
    `${closed.length} of the picked P1 issue(s) closed${closed.length ? ': ' + closed.join(', ') : ''}`);

  return { gates, pass: gates.every((g) => g.pass) };
}

// ---- fact gathering -----------------------------------------------------------

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

const isP1 = (o) => o && (o.priority === 1 || o.priority === '1' || String(o.priority).toUpperCase() === 'P1');
const isClosed = (o) => o && String(o.status).toLowerCase() === 'closed';

function parseBeadsJsonl(text, map) {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o.id) map.set(o.id, o); } catch { /* skip */ }
  }
  return map;
}

// Baseline issue state from the base branch (pristine, before the sprint).
function readBeadsRef(repo, ref) {
  const map = new Map();
  let names = (git(repo, ['ls-tree', '--name-only', `${ref}:.beads`]).stdout || '')
    .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.jsonl'));
  if (!names.length) names = ['issues.jsonl'];
  for (const n of names) parseBeadsJsonl(git(repo, ['show', `${ref}:.beads/${n}`]).stdout || '', map);
  return map;
}

// Post-run issue state from the ON-DISK .beads DB at the base checkout. The
// orchestrator runs every `bd close` here (the DB is deliberately kept OFF the track
// branch -- see beads.md), so closures never appear in the branch diff. Read the
// working-tree DB to see what was actually closed.
function readBeadsDisk(repo) {
  const map = new Map();
  const dir = join(repo, '.beads');
  let names;
  try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return map; }
  if (!names.length) names = ['issues.jsonl'];
  for (const n of names) {
    try { parseBeadsJsonl(readFileSync(join(dir, n), 'utf-8'), map); } catch { /* skip */ }
  }
  return map;
}

// Gather facts from the pushed branch and evaluate. `repo` is the local clone whose
// origin is the toy; the branch is fetched fresh so this works even though the work
// was done in a worktree sharing the same .git.
export function validateSprint({ repo, branch, pr, minCommits = 10, expectedIssues = 3 }) {
  git(repo, ['fetch', '-q', 'origin', 'main']);
  git(repo, ['fetch', '-q', 'origin', branch]);
  const head = (git(repo, ['rev-parse', 'FETCH_HEAD']).stdout || '').trim();
  const base = (git(repo, ['rev-parse', 'origin/main']).stdout || '').trim();

  if (!head || !base) {
    return evaluateGates({ pr, commitCount: 0, finalFiles: [], touchedBasenames: [], closedP1: [], minCommits, expectedIssues });
  }
  const range = `${base}..${head}`;

  const commitCount = parseInt((git(repo, ['rev-list', '--count', range]).stdout || '0').trim(), 10) || 0;

  const finalFiles = (git(repo, ['diff', '--name-only', range]).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const touchedBasenames = (git(repo, ['log', range, '--name-only', '--pretty=format:']).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean).map(baseName);

  // beads issues that were open P1 at base and are closed after the sprint.
  // Baseline comes from the base branch; "closed now" comes from the on-disk DB
  // (where `bd close` writes), not the branch -- the DB lives off the track branch.
  const baseB = readBeadsRef(repo, base);
  const headB = readBeadsDisk(repo);
  const closedP1 = [];
  for (const [id, bo] of baseB) {
    if (isP1(bo) && !isClosed(bo) && isClosed(headB.get(id))) closedP1.push(id);
  }

  return evaluateGates({ pr, commitCount, finalFiles, touchedBasenames, closedP1, minCommits, expectedIssues });
}
