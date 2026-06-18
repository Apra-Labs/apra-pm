# feat(sprint): auto-sprint workflow -- Code Review (second pass)

**Reviewer:** claude-sonnet-4-6 (automated)
**Date:** 2026-06-18 14:30:00+00:00
**Verdict:** APPROVED

> First review found 4 blockers (countBeadsBlockers tag mismatch, tokenLogInstr brace typo,
> no git push before CI check, wrong e2e scenario/workflow name) and 3 minor issues
> (dead phaseModel, devIter off-by-one, planner token tracking incomplete).
> All were addressed in commit 265acd2. This pass verifies each fix.

---

## 1. Working tree / file hygiene

Working tree has two untracked files: `.claude/settings.json` and `downloaded-artifact/`.
Both were present in the first review. Neither is committed to the branch; they are
local runner artifacts and do not affect the merge. All committed files in the branch
diff (`git diff main..feat/claude-pm-workflow --name-only`) are justified:
auto-sprint.js, eight agent files, install.mjs, e2e files, README, docs guide,
pm-e2e.yml, and feedback.md. No temp files or secrets. PASS.

`scenario-claude-pm.md` remains in the branch with the stale `name: "claude-pm"` and
old arg schema. It is a dead scenario file -- `suites.json` s10 now points to
`scenario-auto-sprint.md`, so no suite invokes it. It is harmless but worth noting.
Not blocking; the active scenario is correct.

---

## 2. Fix 1 -- countBeadsBlockers tag (VERIFIED FIXED)

`countBeadsBlockers` previously searched for `"[sprint-"`. Commit 265acd2 changed the
predicate to `"[integ]"` (auto-sprint.js line 182). The integ-test-runner prompt (line
463) and `agents/integ-test-runner.md` (lines 46, 95) both prefix bug titles with
`"[integ]"`. The exit gate now correctly finds integration-test bugs. PASS.

---

## 3. Fix 2 -- tokenLogInstr brace typo (VERIFIED FIXED)

The `tokenLogInstr` function previously emitted `output=<N}"`. Commit 265acd2 corrected
it to `output=<N>"` (auto-sprint.js line 160). `tokenLogInstrVerify` was already correct
and remains unchanged. PASS.

---

## 4. Fix 3 -- git push before head-sha capture (VERIFIED FIXED)

A `git push origin <branch>` agent call is now inserted at lines 405-408, after the
develop loop and before the `head-sha` agent. The push uses the correct `${branch}`
variable. The head-sha agent runs after the push so CI sees the commit before the
ci-watcher polls. Sequencing is correct. PASS.

---

## 5. Fix 4 -- e2e scenario and suites (VERIFIED FIXED)

`e2e/scenario-auto-sprint.md` is a new file with the correct Workflow args schema:
`branch` (string), `issues` (JSON array), `goal` (string), `base_branch` (string).
The step 2 command reads `--type=feature` issues (consistent with the workflow
expecting epic IDs), and step 3 passes `issues` as `[<array of IDs>]`. Correct.

`e2e/suites.json` s10 now points to `"scenario": "scenario-auto-sprint.md"` and sets
`minCommits: 6` and `expectedIssues: 1`. PASS.

`pm-e2e.yml` pre-flight check for s10 now asserts `auto-sprint.js` at
`$HOME/.claude/workflows/auto-sprint.js` rather than the old `claude-pm.js` path. PASS.

---

## 6. Fix 5 -- dead phaseModel() function (VERIFIED REMOVED)

`PHASE_MODELS` array and `phaseModel()` function removed in commit 265acd2. No call
sites remain. PASS.

---

## 7. Fix 6 -- devIter++ placement (VERIFIED FIXED)

`devIter++` is now on line 372, after the null-guard at line 367. When the doer returns
null the log message correctly reports `dev iter 0` on the first iteration, matching the
`doer-c1-i0` label. PASS.

---

## 8. Fix 7 -- planner token tracking (PARTIALLY FIXED -- known gap, non-blocking)

`tokenLogInstr(plannerLabel, MODEL_OPUS)` is now appended to the planner prompt, so the
planner agent is instructed to run `bd remember` for its token counts. However, the
planner is called with no schema (returns unstructured text), so `plannerResult.tokens`
is always undefined and no `addTokens` call was added for the planner. The in-memory
cycle token totals in `cycleInputTokens`/`cycleOutputTokens` still undercount planner
(Opus) spend. The deployer schema was extended to include `tokens` and `addTokens` is now
called for it. Teardown agents (two calls) still have no schema or addTokens.

This was classified as a minor cosmetic issue in the first review. The instruction to
the planner agent was added so it writes to `bd memories`; the JS-side accumulator just
does not capture it. Cycle summary logs will still undercount the most expensive agent.
Acceptable for merge; the fix is directionally correct even if incomplete.

---

## 9. Fix 8 -- reviewer.md --since=today (VERIFIED FIXED)

`agents/reviewer.md` line 21 now reads:
```
bd list --status=closed --closed-after=$(date -I)
```
`--since=today` is gone. PASS.

---

## 10. No regressions found

All agent files (planner, plan-reviewer, doer, reviewer, deployer, integ-test-runner,
ci-watcher, harvester) were verified. None reference PLAN.md, progress.json, or
`--since=today`. The doer.md and reviewer.md step structure is consistent with what
auto-sprint.js expects (VERIFY checkpoint, APPROVED/CHANGES NEEDED verdict). No
regressions introduced by the fix commit.

---

## Summary

All 4 blocking issues from the first review are confirmed fixed. All 3 minor issues are
addressed (phaseModel removed, devIter moved, deployer gets tokens; planner token
accumulation is partially addressed via prompt instruction but the JS accumulator gap
remains -- acceptable). The `--since=today` investigation finding is resolved.

The branch is clean from a committed-code standpoint. The two untracked files
(`.claude/settings.json`, `downloaded-artifact/`) are local artifacts that do not
affect the merge. `scenario-claude-pm.md` is a dead file but not harmful.

**APPROVED for merge.**
