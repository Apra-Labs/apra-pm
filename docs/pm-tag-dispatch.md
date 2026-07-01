# pm Skill: Tag-Based Member Selection

Architectural decisions governing how the pm skill selects and dispatches fleet
members, recorded so future contributors understand the invariants and do not
re-introduce role-based wording.

---

## What changed and why

Before this sprint the pm skill dispatched fleet members using a `role:` field
(e.g. `role: doer`, `role: reviewer`). Fleet member selection by role is a
legacy interface that predates the tag system. Tag-based selection
(`tags: ['doer']`, `tags: ['reviewer']`) is the canonical, forward-compatible
interface exposed by the fleet skill's `compose_permissions` tool.

The migration (sprint feat/pm-tag-dispatch, 2026-07) updates three skill docs:

| File | What changed |
|------|-------------|
| `skills/pm/SKILL.md` R9 | `selecting members by tags: ['doer'] / tags: ['reviewer']` replaces role |
| `skills/pm/fleet-addendum.md` Permissions + Doer-reviewer pairing | tag-based selection stated explicitly |
| `skills/pm/doer-reviewer-loop.md` Continuity + Resume rules + Safeguards | `tags: ['doer'] / tags: ['reviewer']` replaces `role: doer / role: reviewer` |

The legacy `role` parameter still works during the transition period. The
backward-compatibility note in SKILL.md R9 is intentional and must stay until
fleet removes the role parameter from its API.

---

## Invariants future contributors must preserve

### 1. Always compose before dispatch

`compose_permissions` must be called before EVERY fleet dispatch, regardless of
unattended mode. The permission config is per-member and per-tag. Skipping
compose when reusing a member across tag switches produces stale permissions.

### 2. Tag switch requires a fresh dispatch

A switch from `tags: ['doer']` to `tags: ['reviewer']` (or vice versa) must
always use `resume=false`. The doer-reviewer-loop.md resume table encodes this:

| Dispatch | resume |
|----------|--------|
| Tag switch (doer -> reviewer, or vice versa) | `false` |

Never resume across a tag switch. The new context file must be sent before the
fresh dispatch.

### 3. Recompose when switching tags

Call `compose_permissions` again whenever the tag changes. The fleet
`compose_permissions` tool accumulates a permissions ledger per member; issuing
it for the new tag ensures future same-member, same-tag calls start from the
correct baseline.

### 4. Preserve git identities and heading names

The git commit identities `pm-doer`, `pm-reviewer`, `pm-planner`, and
`pm-plan-reviewer` are NOT role-dispatch parameters -- they are git author
identifiers and must not be changed to tag names. Similarly, section headings
like "Per-role prompt templates" describe structural roles (doer vs reviewer) and
are not dispatch parameters; they must be preserved.

---

## Scope of the tag-based migration

The migration is documentation-only for the in-repo skill files. The cross-repo
work (updating fleet Phase 2 to emit `tags` instead of `role` in the member
registry) is tracked under `apra-pm-136` and `apra-pm-jnq` and requires changes
to the `apra-fleet` repo. That work is NOT included in this sprint.

The test suite (`test/skill-pm-tags-dispatch.test.mjs`) covers:

- `tags: ['doer']` / `tags: ['reviewer']` present in all three skill files
- `role: doer` / `role: reviewer` absent from dispatch/permission contexts
- `compose_permissions` called before dispatch
- Preserved git identities and section headings
- "Tag switch" resume rule present in doer-reviewer-loop.md
