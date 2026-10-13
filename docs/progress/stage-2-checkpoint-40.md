# Stage 2 — checkpoint40 ledger

Status: **checkpoint40 verified and ready for owner acceptance; stopped before41**. Authorised36–40 only. Spec/plan accepted2026-10-13, documentation commit a462564.
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
|39| 77c2606 | schema24 absent → schema/RLS5 + migrations4 + system-state10 =19PASS | typecheck/architecture PASS |
|40| 33aeeca | create-idempotency.test.ts: missing executor → 8PASS; affected pure lifecycle15PASS | typecheck/architecture PASS |

## Checkpoint

Cumulative review: **all three P2 findings closed**, one independent reviewer with scoped fix checks; final approval on acb8f2d. See [review record](stage-2-checkpoint-40-review.md).

Final tested code SHA: `acb8f2d9f29ecdcf9f6097542a21bd3d942ca7d2`. One clean clone: `/tmp/echo-max-stage2-checkpoint40.Cu7QhM/repo`.
Node22.23.3/npm11.16.0/PostgreSQL17. Combined gate exit0,60files/613PASS/0FAIL/0SKIP;113.46s test run.
Functional34files/322PASS is extracted from that **same** JSON report; no second functional run.
Unit20files/241PASS; integration3/36PASS; architecture1/8PASS; e2e1/1PASS; smoke1/5PASS.

Commands, each once at this checkpoint: npm ci; typecheck; architecture; build; docker build; npm test.
Ruling: build image before the single test suite and set ECHO_SMOKE_IMAGE, so all image-only smoke cases run within it without a separate rerun. Fresh-clone HEAD/ tracked status unchanged after gate. No new Task performance run or Task restore drill (iteration50); the existing foundation restore test ran as part of default suite.

Gitleaks8.30.1 (pinned image digest c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f): full reachable history95commits and tracked archive on that code SHA, both0leaks/exit0. Broad source scan: no TODO/FIXME/TBD in src/migrations, diff whitespace clean, all three Task-table INSERT sites within the sole Tasks PostgreSQL adapter. Enforced cross-module SQL ownership guard is still iteration48, not claimed here.
[Full verification log](stage-2-checkpoint-40-verification.log).

Publication: this progress/evidence commit is a documentation-only descendant of the tested code SHA; no code changes or gate rerun. Owner-authorised next action is push `codex/stage-2-task-domain` to origin and compare publication HEAD with git ls-remote. Actual push/SHA result is reported in the final handoff, not preclaimed in a pre-push commit. Iteration41 remains not started.

Iteration39 evidence: fixture initially used nonnumeric MAX IDs (setup error corrected before RED); actual RED was missing schema24. First SQL GREEN exposed shared-trigger NEW.task_id on work_items; raw runtime-role PG diagnostic identified it; JSON-based field selection fixed it. Strict receipt malformed-map/error-code RED→GREEN added before commit.

Iteration39 correction before publication: premature commit after the strict-JSON run had failed SQL parsing (CASE in IF needed parentheses); fixed and observed19PASS. Event→receipt FK also deferred: raw worker-role event-before-receipt RED→GREEN proves planned write order; constraints still enforce final commit. Latest unpushed iteration39 commit amended to preserve one reviewable commit.

Iteration40 rulings: structural context/shape validation precedes replay; semantic intent denial follows exact canonical-payload comparison, so same key + changed evidence yields idempotency_conflict per A03. Defaults (including timezone) and source instant canonicalised before fingerprint. Single-create only; existing-target persistence41 and multi-command application42 are not implemented. Turn contexts rejected until guarded bridge46 proves source ownership. Pure create now uses its validated normalised DTO.

Iteration40 internal steps separated within the same executor/commit: extend DTO-only session ports/context parser, implement the four PostgreSQL adapter files, then wire one public executor. Small interface edits to ports/evidence/transitions are necessary to compose the planned single behavior; no additional execution owner or behavior added.

Checkpoint review fixes (same executor): SQL null outcome/error.code/kind/outcome rejected and receipt CHECK uses IS TRUE; optional undefined rejected before patch application; timezone names normalised against the PG17 catalogue before canonical fingerprint/persistence (raw accepted name first, Intl canonical fallback). ICU Asia/Calcutta absent from PG catalogue while Asia/Kolkata present was reproduced; using ICU names alone was insufficient. New session timezone lookup is a read-only compatibility check, not a second Task writer. Targeted review regression RED3/17PASS → GREEN39PASS across five files, typecheck/architecture PASS. No full gate run yet.

Review declined-to-judge areas41–50 remain intentionally deferred per accepted scope; no new implementation is inferred from checkpoint40 tests. Migration0024 is new in this un-deployed checkpoint, so its review correction does not edit any previously deployed Stage1 migration.

Scoped confirmation closed SQL-null and undefined findings; timezone finding remained open on resolver→create (Intl renamed usable Asia/Kolkata to missing Asia/Calcutta). Added real resolver→create RED, retained original timezone in TemporalResult, targeted create10/time4GREEN plus staticPASS. Same reviewer receives only this remaining finding for closure; full gate has still not run.

## Checkpoint result and boundaries

Typed single-create harness now proves optional dates, timezone snapshots, persisted current state/event/receipt, exact payload replay, concurrent-key serialization, closed rejection and precommit rollback. Pure lifecycle/date contracts are tested but persistent existing-target commands are not exposed until41. Multi-command groups42, queries43/49, privacy integration45 and transactional inbound bridge46 remain deferred. No production deployment, AI/STT/reminders/billing/Mini App, extra executor or full-gate repeat. The real MAX callback/duplicate replay exception remains open for the buttons stage.

Owner acceptance of checkpoint40 and authorisation of the next block are required before41.
