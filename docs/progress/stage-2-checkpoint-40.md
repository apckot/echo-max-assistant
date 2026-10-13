# Stage 2 — checkpoint40 ledger

Status: in progress; authorised36–40 only. Spec/plan accepted2026-10-13, documentation commit a462564.
Base implementation SHA: a462564. No iteration41, deployment or real MAX task/callback canary authorised.

## Rulings / pre-flight

- Work in the owner-selected checkout on isolated branch codex/stage-2-task-domain; leave unrelated untracked network evidence untouched. No worktree or baseline full gate: owner authorised targeted iteration checks and one checkpoint clean-clone gate.
- 36→37→38: DTO normalisation, temporal facts, pure lifecycle compose in that order. 39→40: deferred SQL integrity permits create state/event/receipt to commit atomically.
- Ruling: the lifecycle table has 12 existing-command/status cells, not the plan's arithmetic15 (Create is separate). Cover all12 plus Create.
- Local default Node24 is outside engines. Provisioned cached Node22 through npm exec, without adding project dependencies. Subsequent checks and checkpoint gate use Node22.
- npx binary absent locally: use node node_modules/vitest/vitest.mjs run FILE, equivalent pinned local Vitest command; no global changes.
- Checkpoint40 is isolated-test-only: privacy erasure integration arrives45; production MAX keeps foundation behaviour.

## Iterations

| Iteration | Commit | Targeted RED → GREEN | Static checks |
|---|---|---|---|
|36| 8a60aa6 | command-contract.test.ts: missing implementation → 4PASS (Node22) | typecheck/architecture PASS |
|37| fb115ec | time.test.ts: missing resolver → 8PASS with command contract | typecheck/architecture PASS |
|38| 8ba8e11 | transitions.test.ts: missing transitions → 15PASS (12 cells +3 scenarios) | typecheck/architecture PASS |
|39| pending | schema24 absent → schema/RLS5 + migrations4 + system-state10 =19PASS | typecheck/architecture PASS |
|40| not started | | |

## Checkpoint

Cumulative review: not started. Clean-clone full gate: not started. Push/SHA match: not started.

Iteration39 evidence: fixture initially used nonnumeric MAX IDs (setup error corrected before RED); actual RED was missing schema24. First SQL GREEN exposed shared-trigger NEW.task_id on work_items; raw runtime-role PG diagnostic identified it; JSON-based field selection fixed it. Strict receipt malformed-map/error-code RED→GREEN added before commit.

Iteration39 correction before publication: premature commit after the strict-JSON run had failed SQL parsing (CASE in IF needed parentheses); fixed and observed19PASS. Event→receipt FK also deferred: raw worker-role event-before-receipt RED→GREEN proves planned write order; constraints still enforce final commit. Latest unpushed iteration39 commit amended to preserve one reviewable commit.
