# feat(sprint): auto-sprint workflow -- Code Review

**Reviewer:** claude-sonnet-4-6 (automated)
**Date:** 2026-06-18 00:00:00+00:00
**Verdict:** CHANGES NEEDED

> No prior review history for this PR in this repo. First review.

---

## 1. Working tree / file hygiene

The working tree is NOT clean:

```
?? .claude/settings.json
?? downloaded-artifact/
?? feedback.md
```

`.claude/settings.json` and `downloaded-artifact/` are untracked and should not
live in the repo root. Neither belongs to the sprint. `downloaded-artifact/`
contains `pm-lite-e2e-s8.2/` -- a stale CI artifact that should be deleted from
the worktree. Neither is committed so they do not block merge, but the worktree
is not clean per the review protocol.

Files added by the PR (`git diff main..feat/claude-pm-workflow --name-only`):
all 16 files are justifiable -- the workflow script, nine agent files, install.mjs,
README, docs guide, and e2e files. No temp files, no secrets. PASS.

---

## 2. BLOCKING -- `countBeadsBlockers` tag mismatch (auto-sprint.js line 188)

`countBeadsBlockers` looks for integration-test bugs with this predicate:

```
(b) have a title containing "[sprint-" (created by integration testing this sprint).
```

But the integ-test-runner -- both in the workflow prompt (line 459) and in
`agents/integ-test-runner.md` (lines 46 and 95) -- creates all bug issues titled
`"[integ] <description>"`, not `"[sprint-c<N>] ..."`.

The exit-check agent will never find integration-test bugs because `"[sprint-"`
does not match `"[integ]"`. This means the sprint will declare victory
(count=0) even when unresolved `[integ]` bugs exist above the priority threshold.
The no-progress detection also misses these bugs.

**Fix**: change the search string on line 188 from `"[sprint-"` to `"[integ]"`.

---

## 3. BLOCKING -- `tokenLogInstr` template typo produces malformed `bd remember` call (auto-sprint.js line 164)

```js
`\nWhen done, run: bd remember "${label} ${model} tokens: input=<N> output=<N}"\n`
```

The closing delimiter on `output=<N}` is `}` instead of `>`. The rendered
instruction sent to every reviewer agent is:

```
bd remember "... tokens: input=<N> output=<N}"
```

`tokenLogInstrVerify` (line 172) has the correct `>` close. Only `tokenLogInstr`
is broken. It is used by plan-reviewer, cycle reviewer, and final-reviewer --
all three record a malformed token string in `bd memories`.

**Fix**: change `<N}"` to `<N>"` on line 164.

---

## 4. BLOCKING -- `headSha` captures local HEAD before any push; CI will not have seen it

The comment at line 408 says: `// Record HEAD SHA after develop phase -- CI triggers from this push.`
But neither the doer agent (`agents/doer.md`) nor the workflow script ever
instructs a `git push`. The doer commits locally (doer.md Step 6: `git commit`),
and the harvester pushes only in its Step 5 -- long after the CI check runs.

When `ci-watcher` polls for `headSha` during Harvest, the commit has not been
pushed to the remote yet. `gh run list` will return nothing and CI will be rated
`not_configured`, spuriously creating an "Add CI pipeline" task on every cycle.

**Fix**: add a `git push origin <branch>` agent call immediately after the
`head-sha` capture block (lines 409-415), before the integration-test or CI
phases begin.

---

## 5. BLOCKING -- e2e scenario still invokes workflow by old name `claude-pm`

`e2e/scenario-claude-pm.md` line 31:

```
  name: "claude-pm"
```

The workflow `meta.name` is now `"auto-sprint"` (auto-sprint.js line 2).
The Claude Code Workflow runtime dispatches by `meta.name`; this mismatch will
cause the s10 e2e suite to fail with "workflow not found".

**Fix**: update `e2e/scenario-claude-pm.md` line 31 to `name: "auto-sprint"`.

---

## 6. Minor -- `phaseModel` helper is defined but never called

Lines 75-76:

```js
const PHASE_MODELS  = [MODEL_HAIKU, MODEL_SONNET];
function phaseModel(id) { return PHASE_MODELS.includes(id) ? id : MODEL_SONNET; }
```

`phaseModel` is dead code -- no call site exists in the file. Likely a leftover
from a prior design with dynamic model selection. Not blocking, but adds
confusion.

---

## 7. Minor -- `devIter` incremented before null-guard, log label off by one

Line 370 increments `devIter++` before the null check on line 372:

```js
devIter++;
if (!doerResult) {
  log(`Doer returned null on cycle ${cycleCount} dev iter ${devIter} -- aborting`);
```

On the first iteration the log says "dev iter 1" when the doer label was
`doer-c1-i0`. Cosmetic, but makes correlation between log messages and agent
labels slightly confusing.

---

## 8. Minor -- Planner token spend not accumulated; cycle totals undercount

The planner is called with no schema and no `tokenLogInstr` append. It returns
unstructured text; `plannerResult.tokens` is never read; `addTokens` is never
called for the planner. For MODEL_OPUS this is the most expensive agent per cycle.
The same applies to the deployer and teardown calls. Cycle cost totals logged to
`bd remember` will systematically undercount.

Not blocking, but degrades cost observability for the sprint summary.

---

## 9. Note -- `bd list --status=closed --since=today` flag unverified

`agents/reviewer.md` line 21 uses `--since=today`. This flag does not appear in
any bd reference in this repo. If `bd` does not support it the reviewer agent
will error or list all closed issues. Should be verified against `bd help list`
before shipping.

---

## Summary

**Must fix before merge (4 blockers):**

1. `countBeadsBlockers` searches `"[sprint-"` but integ bugs are tagged `"[integ]"` --
   the exit gate is silently broken. (auto-sprint.js line 188)

2. `tokenLogInstr` emits `output=<N}` with wrong brace -- every reviewer records
   a malformed token string. (auto-sprint.js line 164)

3. No `git push` happens before the CI-watcher runs -- CI always appears as
   `not_configured` and a spurious task is created every cycle.

4. `e2e/scenario-claude-pm.md` line 31 still calls `name: "claude-pm"` -- the
   s10 e2e suite will fail to dispatch the workflow.

**Should fix (minor):**

5. Dead code: `phaseModel` function defined but never called.
6. `devIter` incremented before null-guard -- error log label is off by one.
7. Planner, deployer, teardown have no token schema -- cycle cost totals undercount.

**Investigate:**

8. `bd list --since=today` in reviewer.md -- verify this flag exists.
