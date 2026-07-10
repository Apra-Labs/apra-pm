import { execSync } from 'node:child_process';

/**
 * Validates the parsed arguments and checks if the issues exist in beads.
 * Collects all errors before failing to provide complete feedback.
 * 
 * @param {Object} opts The parsed options object
 * @param {string|Object} rawArgs The raw arguments passed to the skill
 * @param {Function} [exec=execSync] Dependency injected execSync for testing
 * @returns {Object} { ok: boolean, errors: string[], warnings: string[] }
 */
export function runPreflightChecks(opts, rawArgs, exec = execSync) {
  const errors = [];
  const warnings = [];
  const expected = 'Expected a JSON OBJECT, e.g. {"issues":["BD-7"],"branch":"feat/x"}';

  // 1. Validate argument shape
  if (opts == null || typeof opts !== 'object' || Array.isArray(opts)) {
    errors.push(`invalid args: not an object. ${expected}. Received: ${JSON.stringify(rawArgs)}`);
    return { ok: false, errors, warnings };
  }

  const issues = opts.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    errors.push(`invalid args: "issues" must be a non-empty array of beads IDs. ${expected}. Received: ${JSON.stringify(rawArgs)}`);
  } else if (!issues.every(s => typeof s === 'string' && s.trim().length > 0)) {
    errors.push('invalid args: every entry in "issues" must be a non-empty string beads ID');
  }

  if (opts.branch != null && (typeof opts.branch !== 'string' || opts.branch.trim() === '')) {
    errors.push('invalid args: "branch" must be a non-empty string when provided');
  }

  if (opts.goal != null && !['P1', 'P1/P2', 'P1/P2/P3'].includes(opts.goal)) {
    errors.push('invalid args: "goal" must be one of "P1" | "P1/P2" | "P1/P2/P3"');
  }

  if (opts.max_cycles != null && !(Number.isInteger(Number(opts.max_cycles)) && Number(opts.max_cycles) > 0)) {
    errors.push('invalid args: "max_cycles" must be a positive integer');
  }

  if (opts.base_branch != null && (typeof opts.base_branch !== 'string' || opts.base_branch.trim() === '')) {
    errors.push('invalid args: "base_branch" must be a non-empty string when provided');
  }

  if (opts.skip_dolt_push != null && typeof opts.skip_dolt_push !== 'boolean') {
    errors.push('invalid args: "skip_dolt_push" must be a boolean when provided');
  }

  // If argument shape is fundamentally broken, stop here before trying to execute shell commands
  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // 2. Validate issues exist in beads
  for (const id of issues) {
    try {
      exec(`bd show ${id} >nul 2>&1` || `bd show ${id} >/dev/null 2>&1`, { stdio: 'ignore' });
    } catch (err) {
      errors.push(`preflight: root ${id} not found or inaccessible in beads.`);
    }
  }

  // 3. Check network / git fetch (Warning only)
  const base_branch = opts.base_branch || 'main';
  try {
    exec(`git fetch origin ${base_branch} >nul 2>&1` || `git fetch origin ${base_branch} >/dev/null 2>&1`, { stdio: 'ignore' });
  } catch (err) {
    warnings.push(`preflight: git fetch failed (non-fatal network issue) -- cannot guarantee branch is off latest ${base_branch}`);
  }

  return { 
    ok: errors.length === 0, 
    errors, 
    warnings 
  };
}
