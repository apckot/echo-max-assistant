# Stage2 typed Task acceptance

Scope: application commands and reads against isolated PostgreSQL17. One owner of Task rules, same API for future MAX/AI/Mini App. Production MAX still uses foundation; this is not live task NLP/canary evidence. No deployment implied.

Commands: Create optionally dated; Update explicitly changes/clears only supplied fields; Complete/Cancel/Reopen use expectedVersion, with conflict before no_change. Cancel is recoverable. Terminal states cannot be updated. Group1–20 is atomic; local labels are unique/backward references. Each effect adds exactly one version/event. No_change/replay/rejection adds no event. Valid-envelope refusal persists indexed rejected receipt, without earlier effects. Identical key/payload returns the original snapshots; changed payload conflicts.

Date-only values remain dates. UTC instants have milliseconds and offsets; snapshot timezone belongs to each Task. Meeting gaps reject; folds require explicit valid offset. Calendar reading separately uses earliest midnight/first existing time, or empty interval for skipped days while retaining literal dates. Date-only deadline becomes overdue at next calendar-day boundary, not23:59. Cursor keeps first-page asOf while authority uses the new transaction; it does not freeze MVCC rows. List/search/history remain tenant-scoped and capped100.

Integration: typed fixtures inject PostgresTypedTaskProcessing after pure preparation. Task state, event, receipt, processing receipt, outbox and ordered pointer commit together in the existing guarded session. Deterministic confirmation says applied/no_change/rejected and names a rejection code; it promises no delivery. Delivery retry invokes no Task command. Failure/policy/outbox error rolls back everything. Lost acknowledgement after real COMMIT is retried by durable identity, not assumed rollback. Production test webhook/header/parser/backdoor is absent.

Noop TaskEffectsPolicy creates no reminder work. AI/STT, reminders/delivery, payments, Mini App and Stage3 remain future work. Account erasure removes state/history/keys through narrow privacy functions; restored fence/reconciliation and explicit reopen are described in [backup/restore](backup-restore.md). Real MAX callback and duplicate replay remain untested until buttons exist; synthetic cases cannot close that accepted exception.

|Acceptance|Automated evidence|
|---|---|
|A01–A03|functional/tasks/create-idempotency.test.ts; canonical receipts/replay/conflicts|
|A04–A07|unit/tasks/transitions.test.ts; functional/tasks/mutations.test.ts; atomic-groups.test.ts|
|A08–A10|unit/tasks/time.test.ts; functional/tasks/temporal-queries.test.ts; profile snapshot/recovery|
|A11|functional/tasks/concurrency.test.ts; create-idempotency.test.ts; authority-races.test.ts|
|A12–A13|functional/tasks/atomic-groups.test.ts; indexed semantic refusal and staged rollback|
|A14|functional/tasks/recovery.test.ts; processing-transaction.test.ts; groups policy rollback|
|A15–A16|functional/tasks/schema-rls.test.ts; queries.test.ts; privacy.test.ts; processing tenant FK|
|A17|unit/tasks/command-contract.test.ts and transitions.test.ts; evidence rejection|
|A18–A19|functional/tasks/queries.test.ts; temporal-queries.test.ts; history.test.ts|
|A20–A21|functional/tasks/processing-transaction.test.ts; recovery.test.ts; authority-races.test.ts; e2e/task-domain-flow.test.ts|
|A22|functional/tasks/privacy.test.ts; restore-consistency.test.ts; operations/isolated-restore-drill.test.ts|
|A23|functional/tasks/atomic-groups.test.ts policy failure and no_change; no production reminder policy|
|A24|performance/task-domain.run.ts fixed seed1000×100,10 clients,100 warm-up,1000 measured80/20; local p95 typed command<1s|

Checkpoint protocol: one cumulative review46–50; one clean-clone gate with npm ci/typecheck/architecture/build/image and npm test (functional, typed e2e, image smoke and physical restore included once). Review-focus config is a targeted convenience, not a second gate run. Full A24 runs once separately on frozen code, preserving environment/index/query-plan report without task text. Publish [checkpoint50 evidence](../progress/stage-2-checkpoint-50.md), push/SHA comparison, stop for Stage2 acceptance. Green tests alone do not authorize Stage3 or deployment.
