# Checkpoint35 — Stage1 completion boundary

Scope: iterations31–35, one primary executor in the existing context/branch; no per-iteration reviewer or full gate. Baseline55977f317458cdd282bd522648d05c56dc410ac1 (checkpoint30 accepted by user). One cumulative independent review and one final full gate/functional/clean-clone/secret scan are authorized after35; results will be added after execution. No next-stage work is authorized.

| Iteration | Result | Targeted evidence |
|---|---|---|
|31|Authenticated encrypted physical backup, verifiable snapshot/WAL manifest; continuous encrypted WAL archive tool|backup3 RED→GREEN; typecheck/architecture|
|32|Offline preview/apply restore, anonymous incident, quarantine old outbox and late old-inbound materialization, generation invalidation|restore+system-state+backup15; isolated physical data/WAL restore|
|33|One pinned Node22 non-root read-only image, four roles, bounded SIGTERM, systemd/nginx|local startup/config23; container smoke5; image build|
|34|Real HTTP5RPS/30s steady,30RPS/60s burst,300message paused-worker backlog|load thresholds; receipt latency upper bound; max runnable depth/connections/waiting locks|
|35|Review Focus reused fixtures, voice end-to-end, ADRs/architecture and safe real-canary preparation|six Review Focus suites40 (includes ordered-head); canary guard2; static checks|

[Performance report](checkpoint-35-performance.json); [isolated restore report](checkpoint-35-restore.json). First load passed latency/drain thresholds but its depth counter included sleeping work; a focused repeat corrected runnable depth and measured phase-specific wake latency. This was a targeted metric correction, not a second full gate. PostgreSQL auto.conf contains default comments; backup rejects active configuration while allowing comments. Both are documented diagnostics, with progress and focused fixes.

Stage1 remains **blocked on real MAX canary**: environment/local envfiles do not provide a dedicated test token, safe recipient confirmation or reachable HTTPS endpoint. Preflight exit2 names only MAX_BOT_TOKEN, MAX_WEBHOOK_SECRET, MAX_WEBHOOK_SECRET_VERSION, MAX_CANARY_TEST_CONFIRMED, MAX_CANARY_TEST_USER_ID, MAX_WEBHOOK_URL. No external calls, bot creation, server provisioning or real sends occurred. [Prepared canary checklist](../runbooks/foundation-canary.md) states the exact user-provisioned prerequisites. Do not accept Stage1 or start Task Domain from FakeMAX evidence alone. Successful-checkpoint publication is pending the real canary requirement.

## Specification §19 evidence map

| Acceptance requirement | Evidence |
|---|---|
|Real and repeated MAX text end-to-end|FakeMAX runtime checkpoint proves duplicate behavior; real-provider canary BLOCKED|
|Duplicate text/callback no second event/sequence/receipt/outbox/send|functional/runtime/checkpoint.test.ts|
|Strict sequence and unready head, terminal continuation|functional/runtime/worker.test.ts; functional/intake/ordered-head.test.ts|
|Independent conversations run concurrently|functional/runtime/checkpoint.test.ts; runtime/worker.test.ts|
|Expired worker cannot commit after another claim|functional/intake/queue-fencing.test.ts|
|Crash after processing commit preserves reply|e2e/foundation-flow.test.ts; functional/runtime/checkpoint.test.ts|
|Consumed-body timeout becomes uncertain, no blind retry|functional/runtime/checkpoint.test.ts; delivery-worker.test.ts|
|Tenant RLS isolation|functional/postgres/roles-and-transactions.test.ts; identity/RLS tests|
|Subscription detect/recover|functional/operations/subscription.test.ts and subscription-deadline.test.ts; real-provider BLOCKED|
|5RPS steady/30RPS burst, no Redis, drain thresholds|checkpoint-35-performance.json; manual performance scenario|
|Restore RPO≤5m/RTO≤4h and no old outbox|checkpoint-35-restore.json; restore-fence.test.ts; production second-storage/PITR continuity requires deployment evidence|
|Account erasure removes queues/content/mappings|functional/identity/deletion tests; operations/checkpoint.test.ts|
|No application/domain adapter imports|npm run lint:architecture; tests/architecture/dependency-boundaries.test.ts|

Backup/restore tooling and the local physical drill do not establish ongoing deployed WAL continuity, storage location, key escrow or monthly drills. Health intentionally reports backup unknown until operator monitoring establishes those facts. Canary/production setup requirements are operational blockers, not silently assumed successful results.


Cumulative review found four local issues: encrypted archived-WAL recovery/RPO proof missing; archive success before fsync; .history/.backup rejected; unready-head test absent from focused suite. Same executor adds authenticated archive preparation with a named recovery target, a post-base acknowledged marker drill, durable publish/retry, all valid PostgreSQL archive filename shapes and the existing ordered-head suite. SQL rejects snapshot cutoffs older than restored inbound/outbound so PITR cannot partially quarantine. One focused run had39/40 with an ingress503 in an existing restart/idempotency case; diagnostic assertion now exposes response code without retrying. The isolated affected test subsequently passed1/1; the failure remains preserved in local evidence. Full gate remains unrun until scoped review confirmation.
