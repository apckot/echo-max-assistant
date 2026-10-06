# Checkpoint35 — Stage1 completion boundary

Current status (2026-10-06): the authorized gate repeat on `95b77ef` failed in the separate functional suite (304 passed, 1 failed), after the default suite passed (571 passed, 1 skipped). The failure was `DB_INVALID_INPUT` at `operations/checkpoint.test.ts` during `scheduler.clean()`. The focused retention correction below passed targeted checks; a new full gate requires separate user authorization. No push or real MAX canary was performed. Earlier boundary statements below are historical evidence.

## Focused retention clock correction

The original scenario currently passes without an artificial clock shift; its historical gate timestamps were not recorded, so the exact historical cause is not proven. A fixture-only diagnostic evaluated all original SQL input-validation branches using one captured PostgreSQL `clock_timestamp()`. With application Date advanced by 60 seconds, it reproduced the failure with these non-content values:

| Input / observation | Value |
|---|---|
|`as_of`|`2026-10-06T14:27:04.496Z`|
|PostgreSQL `clock_timestamp()` at validation|`2026-10-06T14:26:04.498262Z`|
|`batch_limit`|`100`|
|Rejecting branch|`as_of > clock_timestamp()` (`as_of_future`), SQLSTATE `22023`|

Without the artificial shift, SQL validation observed `as_of=2026-10-06T14:25:46.266Z`, PostgreSQL time `2026-10-06T14:25:46.266039Z`, batch 100, branch `valid`. A separate earlier input probe saw application time 1 ms ahead of PostgreSQL, but the subsequent validation succeeded; that probe alone does not establish the historical failure.

Ordinary retention now calls `retain_technical_records(clock_timestamp(), batch_limit)` inside the same scheduler database transaction and SQL operation. The explicit `clean(Date, limit)` path and injected fixed test clock remain available. Existing SQL future-time validation is unchanged; no delay or tolerance was added. Temporary diagnostic instrumentation was removed.

The permanent regression failed RED on the old code with `DB_INVALID_INPUT`, using the actual scheduler and unchanged PostgreSQL routine. After correction, application Date 60 seconds ahead no longer breaks `scheduler.clean()`, while an explicitly supplied future cutoff still fails. Related checkpoint/retention/retention-fencing: **3 files, 6 tests passed**; typecheck and architecture guard passed. Only these targeted checks ran for the correction. Scoped confirmation by the same cumulative reviewer is recorded separately. Full checkpoint readiness remains pending an authorized gate; Stage 1 acceptance also requires the real MAX canary and its infrastructure/credentials. Stop before the next stage.

Scope: iterations31–35, one primary executor in the existing context/branch; no per-iteration reviewer or full gate. Baseline55977f317458cdd282bd522648d05c56dc410ac1 (checkpoint30 accepted by user). One cumulative independent review and one final full gate/functional/clean-clone/secret scan are authorized after35; the single full gate failed; targeted repairs passed, but a repeat requires user authorization. See the verification record. No next-stage work is authorized.

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


Cumulative review found four local issues: encrypted archived-WAL recovery/RPO proof missing; archive success before fsync; .history/.backup rejected; unready-head test absent from focused suite. Same executor adds authenticated archive preparation with a named recovery target, a post-base acknowledged marker drill, durable publish/retry, all valid PostgreSQL archive filename shapes and the existing ordered-head suite. SQL rejects snapshot cutoffs older than restored inbound/outbound so PITR cannot partially quarantine. One focused run had39/40 with an ingress503 in an existing restart/idempotency case; diagnostic assertion now exposes response code without retrying. The isolated affected test subsequently passed1/1; the failure remains preserved in local evidence. At that point the full gate had not run; its later failure and targeted repairs are recorded below.

Implementation commits:31=714bf94,32=bbe2334,33=804a806,34=dffb549,35=ec64bbe. Same-executor cumulative review corrections03fb24b were independently confirmed by the same reviewer, scoped to four findings. [Review record](checkpoint-35-review.md). The single final gate froze d818324 after a deterministic smoke-artifact setup correction, then failed as recorded below.


## Final boundary — BLOCKED, stop

[Verification record](checkpoint-35-verification.log): the one full clean-clone gate on d818324 failed566PASS/3FAIL/1SKIP. Operational CLI main detection treated a symlinked /tmp checkout as a library and silently skipped encryption/manifest work. Same executor fixed it in1300def, added symlink regressions and fail-closed artifact assertions; targeted9/9 plus static checks passed and the same reviewer scoped-confirmed it. Same-clone checks passed backup5/canary3; physical drill then exposed an early hot-standby connection race. Test-only e351079 waits for promotion; same-clone physical1/1 plus static checks passed (acknowledged post-base marker RPO0ms/RTO12680ms). No second full gate was run. Functional/final build/image commands after the failed default suite were not reached; earlier iteration33 image/smoke evidence is not substituted for them.

Current code e351079 is ready for an explicitly authorized single gate repeat. Stage1/checkpoint35 remain blocked on that repeat and a real dedicated-test MAX canary. The user must provision local TEST token, webhook secret/version, safe test user/confirmation and approved HTTPS endpoint (see runbook); nothing is sent externally until those prerequisites exist. Successful-checkpoint push is withheld; remote remains accepted checkpoint30 SHA55977f3. Final documentation-only commit and secret scans preserve this stopped state. No next stage begins.
