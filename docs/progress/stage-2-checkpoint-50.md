# Stage2 checkpoint50 ledger — plan: docs/superpowers/plans/2026-10-13-max-assistant-stage-2-task-domain.md

Date2026-10-14 Europe/Moscow. **Stage2 implementation and checkpoint50 verified; ready for owner acceptance.** Checkpoint45 accepted; owner authorised only46–50, one cumulative review, one clean-clone gate including functional/review-focus cases once, A24 load and one isolated physical restore drill. No Stage3/deployment. One primary executor, no implementation delegation.
Base d33f73af076dbe5745b240d72f4ba6371c10d882; branch codex/stage-2-task-domain. Preserve unrelated network diagnostic.

## Pre-flight / rulings

- Reuse current branch, Node22.23.3, existing local Docker/PG17. User checkpoint process overrides skill suggestions for full per-task reruns and extra worktrees; targeted checks only until checkpoint.
- 46→47: bound Tasks session uses the existing guarded DbTx; pure handler stays raced separately, continuation is awaited afterward. User FOR SHARE precedes conversation/work/head locks.
- 46→48: bound adapter is an infrastructure composition point, not a public task session API; ownership guard will allow that one bridge and deny other importers/writers.
- 49→50: small load smoke verifies harness only; full fixed-seed A24 once at checkpoint. Extend the existing physical restore test with Tasks fixture so the one default suite run also supplies the one physical drill, avoiding duplicate backup/drill runs.
- Schema26 adds a generated nullable Task receipt reference and deferred composite tenant FK to processing receipts. This binds confirmation to an existing same-tenant receipt; deferred delete allows existing erasure function to remove all receipts in its established transaction/order. No applied migration edits.
- Implementation46 split internally: result/session contracts; bound bridge and lock ordering; additive SQL; fixtures/targeted tests. One iteration/commit/executor.

|Iteration|Commit|Targeted RED→GREEN|Static|
|---|---|---|---|
|46|da9441989dc9793d95498030c7bdc9e225ee0ac2|missing bridge API → processing4 + affected foundation/privacy/schema tests77 PASS|typecheck/architecture PASS|
|47|c6aa0d13f7ba8b391247ae3339b72717e7e6f0ad|real backend disconnect/COMMIT ACK loss and authority races7 PASS; alias snapshot regression RED → GREEN12 including processing4|typecheck/architecture PASS|
|48|955548d95bb740757b99a4b564980ed8d0cb4784|foreign imports/writes10 RED; additional concatenated literal RED → ownership12+architecture8 GREEN20|typecheck/architecture PASS|
|49|d2d8d6c51b020f8774950560586f5f615225da24|temporal PG6 PASS; small load smoke1 PASS, deterministic seed+replay/report validated|typecheck/architecture PASS|
|50|8cb094a1fbf1665dc1098d58a4a695550b30379a|typed e2e1 + row restore1 PASS; closed processing format/composite foreign receipt FK5 PASS|typecheck/architecture PASS|

Review and full gate including physical drill complete; A24 passed on the explicitly approved retry; see final evidence below. No separate review-focus/functional rerun.


Iteration47 diagnosis: application canonicalises Asia/Kolkata to ICU Asia/Calcutta before the bound session; authority had compared against raw event timezone. Compare canonical temporal zone on both sides, while PostgreSQL-compatible storage still resolves the original snapshot. Regression covers actual typed inbound with a Kolkata profile. Other fault proofs passed immediately against46: evidence of existing guards, not invented RED. COMMIT failure fixture throws only after real transaction COMMIT; independent raw DB counts/immutable receipt and restarted connections prove durability.


Iteration48 ruling: temporal adapter needs a public DTO-only TemporalPort but must not import TaskSession. Split temporal-port.ts from private ports.ts, preserving internal re-exports. Guard scans all production src for fixed Task adapter imports/writes; sole bound bridge allowed. Foreign .query requires a single literal (no interpolation/concatenation/nonliteral bypass); database/migration runner are explicit SQL infrastructure exceptions. This is bounded source enforcement, not a SQL parser/security proof; runtime RLS/grants/FK remain necessary.


Iteration49 ruling: calendar policy already implemented43; new PostgreSQL temporal evidence passed without production changes. Range/leap, snapshot timezone, strict meeting distinction, gap/fold/skipped literal dates and overdue frozen cursor covered. A24 seed inserts via isolated migrator fixtures with all constraints/triggers enabled, real normalized canonical payload/hash and state/event/receipt; a seeded receipt replay is verified. Smoke2 tenants×5 tasks/10 measured ops; final profile1000×100/10 clients/100 warm-up/1000 measured/80:20 with query plan and environment report deferred checkpoint. Harness pool matches concurrency, production pools unchanged.


Iteration50 rulings: targeted row snapshot restore checks state/history/receipt, fence and surviving-key replay without executing physical backup; physical drill executes once in checkpoint gate. Extended the existing WAL drill (no second drill). Source Task created pre-base, update post-base/pre-target, extra task post-target; target must restore update/history/receipts and exclude extra task, block writes under fence and replay originals after explicit isolated reopen. New e2e uses real PG processing/delivery ports with deterministic sender outcomes, not live MAX/NLP. Test setup first assumed queue wake bypassed conversation send spacing, then expected not_admitted for an already completed lease; corrected to real due/spacing and existing DeliveryLeaseLostError, without changing delivery behavior. Targeted final2 PASS; physical drill subsequently passed once in the gate. Temporal/fault/restore proof tests of existing guards passed without new feature edits; only actual alias defect47 needed production repair.


Cumulative review: two P2 findings confirmed. Same executor closed straightforward ONLY/computed/optional query-call guard bypasses (three RED regressions) and supplied successful policy contract evidence. Capturing real-PG policy proves one call per create/update/complete/cancel/reopen event with the persisted eventId and none on replay/equal patch/rejected group. Policy code already correct, so coverage test was immediately GREEN; no invented production fix. Targeted ownership/architecture/groups34 PASS; typecheck/architecture PASS. Both findings closed by scoped confirmation on ec682a868c767ebba842432980d68f415499b4e3. Gate and physical drill passed; A24 passed on the explicitly approved retry; see final evidence below. See [review](stage-2-checkpoint-50-review.md).


## Frozen checkpoint evidence

Tested business code SHA `ec682a868c767ebba842432980d68f415499b4e3`. Clean clone path recorded in `/tmp/echo-stage2-checkpoint50-evidence/clone-path`. One gate exit0; HEAD/tracked status unchanged. Node22.23.3/npm11.16.0/PG17.11; frozen-SHA Docker image built once. npm ci/typecheck/architecture/build/docker build/one npm test:74 files/**686PASS/0FAIL/0SKIP**,150.55s test duration.

Functional45 files/**378PASS** is extracted from the same JSON report, not rerun. Unit22/257; integration3/36; architecture1/8; e2e2/2; image smoke1/5. No separate review-focus run. [Full verification log](stage-2-checkpoint-50-verification.log).

One physical backup/WAL restore drill inside that gate: authenticated encryption and pg_verifybackup, post-base Task update recovered, current/history/receipts preserved (1/2/2), surviving keys replay original receipt with no effect, beyond-target Task absent, fence denies writes until explicit isolated reconciliation/reopen; old outbound replay eligibility0. Controlled local RPO0ms/RTO10611ms. [Restore report](stage-2-task-restore.json). This does not prove deployed off-host storage availability.

Broad scans on frozen SHA: pinned Gitleaks8.30.1 digest c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f,109 reachable commits and tracked archive, both0leaks/exit0. No TODO/FIXME/TBD in src/migrations; Task INSERT/UPDATE sites confined to sole Tasks PostgreSQL adapter, source guard enforces ownership. Cumulative diff-check found only an extra EOF blank line in temporal-port.ts; publication removes that line (format only) and narrow diff-check passes. Meaningful source remains identical to frozen tested code, so no second full gate.


## Initial A24 attempt — interrupted, not counted as PASS

Owner flagged elapsed time. One full A24 attempt was interrupted before warm-up/measured operations: serial fixture preparation had committed20400/100000 Tasks (206 users including the two base fixtures). No p95/SLO result was produced. Partial counts are retained in /tmp/echo-stage2-checkpoint50-evidence/load-aborted-counts.txt; process exit143, isolated container cleaned up. Full gate/review-focus/functional/physical restore were not repeated.

Cause: one seeding connection executes1000 tenant transactions sequentially, including expensive real snapshot/timezone/receipt constraints. Corrected the isolated harness to seed independent tenants through up to10 connections, with separate temporary tables and all constraints/triggers enabled. Added preparationMs/preparationClients to report and a20-minute safety timeout; measured profile remains exactly1000 tenants×100 Tasks/10 clients/100 warm-up/1000 measured/80:20. A single small smoke (2 tenants×5 Tasks/10 ops),3.04s/PASS, verifies corrected setup and receipt replay. This change affects only the performance fixture, which is not executed by the default gate; business code/default tests remain the frozen verified version (except an EOF whitespace removal). No second full gate is required.

Owner explicitly approved one A24 retry with a20-minute limit. Completed below; gate/functional/review-focus/physical drill were not repeated.


## Approved A24 retry — PASS

Benchmark SHA `4b1b09560a44d1aa2b98fe7845fc50eca50fa03f`, same clean clone after checkout of corrected performance fixtures. One owner-approved retry, exit0/1PASS;582.23s total (9min42s), preparation572772.96ms (9min33s),10 independent seeding connections. All constraints/triggers remain enabled, seeded canonical payload/hash and receipt replay verified. No disabled integrity checks or dataset reduction.

Exact profile: fixed seed echo-task-domain-v1,1000 tenants×100 Tasks,10 clients,100 warm-up,1000 measured operations,80/20 reads/writes,200 measured typed updates. **p95 typed command59.054ms <1000ms**, p95 all operations55.311ms. Final state100000 Tasks/100220 events/100220 receipts includes20 warm-up+200 measured effects. Tenant membership and current/latest event version invariants passed. Node22.23.3,PG17.11,Apple M5/10 logical CPUs/16GiB RAM, isolated local Docker; indexes and tenant-worker EXPLAIN ANALYZE/BUFFERS preserved in [performance report](stage-2-task-performance.json), [run log](stage-2-task-performance.log). This controlled regression is not a production capacity/SLO claim.

Default gate's tested business source remains unchanged except EOF whitespace. Benchmark-only correction is verified by its small smoke and approved full A24; no default gate or independent review was restarted. Publication below changes documentation/evidence only.

## Stage2 result, acceptance and publication

Iterations36–50 provide the shared provider-neutral Task API: lifecycle/rescheduling, version/evidence rules, atomic groups, persistent current state/history/receipts, key replay/conflicts, tenant-scoped lists/search/date boundaries/frozen-asOf pagination, privacy erasure/retention, guarded processing/outbox integration and Noop reminder policy. [A01–A24 evidence mapping and typed acceptance boundary](../runbooks/task-domain-acceptance.md). Checkpoints40/45 accepted by owner; checkpoint50 and Stage2 now await owner acceptance.

Atomicity proof: Tasks/current state/events/Task receipt/processing receipt/outbox/pointer persist in the same guarded DbTx; injected failure and actual PG termination roll all back. Actual COMMIT followed by lost acknowledgement fixture plus independent restarted connections preserves original receipts and exactly one effect/outbox. Two conversations/version1, independent renew, erasure and restore-fence races deny unauthorized commits. Delivery retry and stale processing tokens never execute a second Task effect. This is typed/real-PG integration proof, not NLP/live MAX task proof.

One cumulative reviewer, both P2 findings closed; one full clean-clone gate; one physical WAL restore drill inside that gate; one approved A24 retry after an aborted preparation, no extra executor/reviewer or functional/review-focus/full-gate rerun. Read-only progress counts were observed during A24 preparation; these were not additional test runs. Initial expensive serial preparation and correction are retained above, not hidden.

All authorised checks passed. This documentation/evidence commit is a descendant of the verified gate and benchmark SHAs. Next authorised action: push codex/stage-2-task-domain to origin and compare local publication HEAD with git ls-remote; actual result reported in final handoff, not preclaimed in this pre-push commit. Untracked network diagnostic unchanged, original SHA256 d596baa6203db961ea83317b09ad60e1a6cf1bbd71388db3a9e3369d08963ade verified.

Stop for Stage2 acceptance. Stage3, deployment, providers/AI/STT, reminder delivery, payments, buttons and Mini App have not started. Production MAX still uses FoundationInboundHandler. Accepted real callback/duplicate replay exception remains open for the buttons stage; local restore does not prove deployed second-storage availability.
