# Stage2 checkpoint50 ledger — plan: docs/superpowers/plans/2026-10-13-max-assistant-stage-2-task-domain.md

Date2026-10-14 Europe/Moscow. In progress. Checkpoint45 accepted; owner authorised only46–50, one cumulative review, one clean-clone gate including functional/review-focus cases once, A24 load and one isolated physical restore drill. No Stage3/deployment. One primary executor, no implementation delegation.
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
|46|da94419|missing bridge API → processing4 + affected foundation/privacy/schema tests77 PASS|typecheck/architecture PASS|

Review, full gate, A24 and physical drill not started. No separate review-focus/functional rerun planned.

|47|c6aa0d1|real backend disconnect/COMMIT ACK loss and authority races7 PASS; alias snapshot regression RED → GREEN12 including processing4|typecheck/architecture PASS|

Iteration47 diagnosis: application canonicalises Asia/Kolkata to ICU Asia/Calcutta before the bound session; authority had compared against raw event timezone. Compare canonical temporal zone on both sides, while PostgreSQL-compatible storage still resolves the original snapshot. Regression covers actual typed inbound with a Kolkata profile. Other fault proofs passed immediately against46: evidence of existing guards, not invented RED. COMMIT failure fixture throws only after real transaction COMMIT; independent raw DB counts/immutable receipt and restarted connections prove durability.

|48|955548d|foreign imports/writes10 RED; additional concatenated literal RED → ownership12+architecture8 GREEN20|typecheck/architecture PASS|

Iteration48 ruling: temporal adapter needs a public DTO-only TemporalPort but must not import TaskSession. Split temporal-port.ts from private ports.ts, preserving internal re-exports. Guard scans all production src for fixed Task adapter imports/writes; sole bound bridge allowed. Foreign .query requires a single literal (no interpolation/concatenation/nonliteral bypass); database/migration runner are explicit SQL infrastructure exceptions. This is bounded source enforcement, not a SQL parser/security proof; runtime RLS/grants/FK remain necessary.

|49|pending|temporal PG6 PASS; small load smoke1 PASS, deterministic seed+replay/report validated|typecheck/architecture PASS|

Iteration49 ruling: calendar policy already implemented43; new PostgreSQL temporal evidence passed without production changes. Range/leap, snapshot timezone, strict meeting distinction, gap/fold/skipped literal dates and overdue frozen cursor covered. A24 seed inserts via isolated migrator fixtures with all constraints/triggers enabled, real normalized canonical payload/hash and state/event/receipt; a seeded receipt replay is verified. Smoke2 tenants×5 tasks/10 measured ops; final profile1000×100/10 clients/100 warm-up/1000 measured/80:20 with query plan and environment report deferred checkpoint. Harness pool matches concurrency, production pools unchanged.
