# Checkpoint35 — Stage1 completion boundary

Current status (2026-10-13): **checkpoint35 accepted by the owner; Stage1 completed with the explicit real-callback exception. No next stage started.** The single final gate on `46e6273aedbc5a30a40e85d098943eb2cb49ac2b` passed in a fresh clone: default572PASS/1SKIP, functional306PASS, typecheck/architecture/buildPASS. Real canary used documentation-only descendant `c42baff0fb50ffadf70d70673f06ea3b024b2457` with unchanged source/migrations. [Anonymous real-canary evidence](checkpoint-35-canary.json). TEST runtimes are now stopped/disabled/fenced, separate MAX PostgreSQL17 stopped, subscription removed, application test account and private captures erased. Earlier pending/failure statements below are historical evidence, not current blockers.

Historical automated-checkpoint publication procedure (completed on2026-10-07): commit documentation, scan the final publication HEAD with pinned Gitleaks8.30.1 (full reachable history and tracked archive), push without force, independently compare local/remote SHA. Actual final scan and publication SHA results are supplied in the checkpoint response; they are not preclaimed here. [Verification record](checkpoint-35-verification.log). [Short MAX setup instructions](../runbooks/max-canary-setup.md).

## Historical canary access attempt — awaiting environment location

The user reports TEST infrastructure and credentials prepared and authorizes only the runbook canary. The executor has not yet received the protected env-file location or remote connection target. Local-process preflight returned exit2: required MAX canary variables are absent from this process; standard local env-file paths are absent. This observation does not establish whether the prepared remote environment is ready. No credentials were printed, no provider requests were sent, and no real MAX case was executed. [Anonymous access/preflight evidence](checkpoint-35-canary.json) records this incomplete attempt, not a passing canary. Required next input: protected env-file path and, for a remote setup, SSH alias and checkout directory; never secret values. The automated gate remains passed; Stage 1 completion awaits actual canary results. No full gate, reviewer, push or next-stage work was performed for this attempt.

## Owner acceptance — 2026-10-13

Checkpoint35 and Stage1 accepted. Explicit exception: real MAX callback was not exercised because no test button existed. Carry the real callback and exact duplicate replay into acceptance of the stage introducing buttons; synthetic callback tests alone do not close the exception. This requirement is preserved in the tracked project AGENTS.md. No next-stage work is authorized or started. Canary evidence commit00cc317 was pushed and its remote SHA independently matched before this documentation-only acceptance commit. No full gate or review rerun is required for these documentation changes.

## Real MAX canary — final PASS and cleanup

| Runbook case | Result | Evidence |
|---|---|---|
|1 Subscription|PASS|Provider200; one matching HTTPS webhook/all four types; healthy version; real signed Start received|
|2 Real text|PASS|Owner confirmed reply; one receipt/outbox/dispatch/sent; inbound persistence→provider completion741ms|
|3 Exact duplicate|PASS|Private raw body matched original hash; signed replay200; unchanged inbound/receipt/outbox/dispatch/sent counts; callback N/A without test button|
|4 Stop/start|PASS|Real stopped/started events; pending old source covered by cutoff, actual claim/admit cancelled without sender; fresh post-start reply confirmed|
|5 Worker restart|PASS|Only MAX worker restarted after processing commit before delivery; persisted counts/state unchanged; one fresh confirmed send, no old send|
|6 Real voice|PASS|Owner confirmed honest unsupported explanation; applied voice retains capability_unavailable; exactly one confirmed voice dispatch; no transcription|
|7 Cleanup|PASS|Only MAX runtimes stopped/disabled, test subscription removed, account/queues/content/attempts erased, private capture/participant env removed; anonymous erasure audit remains|

Before erasure: inbound7/receipts7/outbound4, confirmedSent3, cancelled1, uncertain0. After erasure: users/accounts/conversations/inbound/receipts/outbound/attempts/queue work all0; one completed erasure with user_id=NULL. Echo Secretary and OpenVPN observed PIDs stayed unchanged; Amnezia remained active and existing nginx routes are preserved. No source changes, full gate rerun, reviewer or new agent.

Two diagnostic assertions initially demanded states not required by the code: immediate physical cancellation while delivery was paused (finalization occurs on claim/admit), and preparation_status=failed for unsupported voice (normalized payload stays ready, capability_unavailable is recorded during applied processing). Correct criteria were established from the existing implementation and runbook; initial observations are preserved in JSON. Neither required a code change. Earlier401 was executor credential parsing error, not a bad bot token; corrected extraction accepted by MAX. All evidence omits token values, IDs, raw DTOs, user text and media URLs.

Canary satisfies the previously pending real-provider condition. The owner accepted checkpoint35 and completed Stage1 on2026-10-13. Real callback was not checked because no test button existed; it must be included in acceptance of the stage introducing buttons. This exception is not a passing callback result. This TEST deployment on the owner-selected Kazakhstan host does not establish Russian production storage placement, continuously deployed encrypted WAL/backup monitoring, key escrow or monthly production drills. Existing restore/load evidence remains scoped as documented. No Task Domain or later stage began.

## Worker restart durability and fresh post-start reply — PASS

The fresh post-start text produced one eligible pending outbox before dispatch. With MAX delivery still paused, restarted only the MAX worker after processing commit. Process changed; inbound6/applied6/receipts6/outbound3 and sent1/cancelled1/ready1 work remained unchanged across restart. Then opened delivery: exactly one fresh confirmed sent attempt, total dispatchStarts2/confirmedSent2/uncertain0, sent2/cancelled1. The old cancelled source still has no delivery_attempts. This completes fresh post-start eligibility and worker-restart durability using one real message; no admitted send was interrupted. Owner's visual confirmation of the fresh reply and real voice/cleanup remain pending. No new code, full gate or independent review.

## Real stop/start — cancellation verified, fresh reply pending

Real lifecycle events show two starts/one stop, same single account active again. The pending pre-stop outbound source is covered by the monotonic sequence cutoff and had no dispatch admission. An initial assertion incorrectly expected immediate physical cancellation while delivery was paused; migration16 explicitly finalizes on claim/admit. Read-only cutoff check confirmed the guard, then the actual PostgresDeliveryQueue/Admission adapters finalized cancelled without invoking a sender. Final counts: inbound5/receipts5/outbound2, delivery sent1/cancelled1, dispatchStarts1/confirmedSent1/uncertain0. The first premature observation is preserved in anonymous evidence, not hidden as a code repair. No source change or full gate. Delivery remains paused for a fresh post-start text, which will also exercise worker restart after processing commit before delivery. Full stop/start fresh-send and worker-restart outcomes are still pending.

## Real text and exact duplicate replay — PASS

Owner confirmed the real MAX reply. Verified one applied text, one outbound, one started dispatch and one confirmed sent completion; inbound persistence to provider completion741ms. Exact privately captured webhook body matched the stored original SHA256 and was replayed through the authenticated public HTTPS route:200, unchanged inbound2/receipts2/outbound1/dispatchStarts1/sent1/uncertain0 (counts include the initial lifecycle event). No second dispatch. Callback replay is not applicable because no test button exists. Only anonymous outcomes/counts/timing are retained in tracked evidence. For the upcoming stop/start case, MAX delivery was gracefully paused only after proving no ready/leased/retry work; its runtime fence is ON. No admitted send was interrupted. Pending: stop/start cancellation, worker restart durability, real voice expectation and cleanup. Stage1 remains incomplete.

## Real canary progress — participant verified

Owner pressed Start from the test MAX account. The real signed bot_started event created exactly one account/inbound; after private participant configuration and successful preflight, worker/delivery were opened. Anonymous baseline: one applied inbound, one receipt, zero outbound, ready=true, subscription healthy. Participant ID is stored only in the protected server canary env. Temporary raw-body capture for the upcoming exact duplicate replay is private (0700 directory/0600 file), omits authorization headers and must be removed during runbook cleanup. Text/duplicate/stop-start/restart/voice outcomes are still pending; no full canary success or Stage1 completion is claimed. [Current anonymous evidence](checkpoint-35-deployment.json).

## Authentication correction and subscription readiness — 2026-10-13

The root cause of401 was executor error: secrets.txt contains a max-bot-token= assignment, but the entire line was passed as the credential. Exact-transfer checks had verified that wrong complete line, not the parsed token value. After extracting only the value after the prefix, GET /me returned200/is_bot=true and GET /subscriptions returned200. The actual bot token was valid; prior suggestions to revoke it were unwarranted. Secret values were never displayed.

Verified migration checksums and schema23 on the fresh isolated database, opened its fence and only gateway/scheduler runtime fences. Scheduler registered one matching webhook with all four expected update types; protected health ready=true and subscription healthy/failures0. Worker/delivery are active but remain fenced until the owner presses Start from a consenting test account, which allows private participant identification before enabling replies. Echo Secretary/OpenVPN observed PIDs unchanged. No real inbound/voice/replay/restart/stop-start canary result is claimed yet. [Anonymous current deployment evidence](checkpoint-35-deployment.json).

The earlier authentication-failure observations below are historical and superseded by this established parsing cause.

## TEST deployment on nwc-kz — 2026-10-13

Owner authorized Echo MAX deployment on the Kazakhstan host and the existing domain, preserving Echo Secretary and VPN. Committed code c42baff is installed at /opt/echo with the existing Docker/systemd runtime artifacts. PostgreSQL17 runs in its own container/network/volume, without a published DB port; all23 migrations applied. Four MAX runtimes are active with restore fences ON. Gateway binds host loopback18080 because8080 belongs to another service. Existing nginx routes are byte-for-byte preserved apart from one MAX-only include, validated and gracefully reloaded.

Public HTTPS verification passed. The existing Let's Encrypt full chain was already valid: earlier local Python verification had zero trusted CAs, so the certificate itself was not changed. MAX API needs its Russian CA; the official CA bundle is mounted only into MAX containers through NODE_EXTRA_CA_CERTS, without modifying system trust or Echo Secretary/VPN. Secret values were never printed or stored in tracked documentation.

Infrastructure checks: protected ops health200/schema23/fenceON/empty queue; unsigned public webhook401 unauthorized (expected); all four MAX services active. Echo Secretary and OpenVPN observed PIDs unchanged, Amnezia active. Provider authentication is BLOCKED: GET /me and GET /subscriptions return401 for the supplied token. A subsequent owner-authorized single GET /me diagnostic from nwc-kz returned JSON code verify.token and message Invalid access_token; the exact token transfer and Authorization header were previously verified. This establishes provider token-validation rejection, but does not distinguish revocation, incomplete copy or other token-issuance state. No subscription created, no real messages sent, no canary case passed. The owner must replace secrets.txt with a valid dedicated MAX bot token before reopening and the real canary. [Anonymous deployment result](checkpoint-35-deployment.json). No source changes, full project gate, reviewer or next-stage work.

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

The permanent regression failed RED on the old code with `DB_INVALID_INPUT`, using the actual scheduler and unchanged PostgreSQL routine. After correction, application Date 60 seconds ahead no longer breaks `scheduler.clean()`, while an explicitly supplied future cutoff still fails. Related checkpoint/retention/retention-fencing: **3 files, 6 tests passed**; typecheck and architecture guard passed. Only these targeted checks ran for the correction. Scoped confirmation by the same cumulative reviewer is recorded separately. The final authorized clean-clone gate subsequently passed as recorded above; Stage 1 acceptance still requires the real MAX canary and its infrastructure/credentials. Stop before the next stage.

Scope: iterations31–35, one primary executor in the existing context/branch; no per-iteration reviewer or full gate. Baseline55977f317458cdd282bd522648d05c56dc410ac1 (checkpoint30 accepted by user). One cumulative independent review completed, followed by scoped confirmations from the same reviewer. Failed gate attempts and same-executor repairs are preserved below; the final explicitly authorized gate passed on46e6273. See the verification record. No next-stage work is authorized.

| Iteration | Result | Targeted evidence |
|---|---|---|
|31|Authenticated encrypted physical backup, verifiable snapshot/WAL manifest; continuous encrypted WAL archive tool|backup3 RED→GREEN; typecheck/architecture|
|32|Offline preview/apply restore, anonymous incident, quarantine old outbox and late old-inbound materialization, generation invalidation|restore+system-state+backup15; isolated physical data/WAL restore|
|33|One pinned Node22 non-root read-only image, four roles, bounded SIGTERM, systemd/nginx|local startup/config23; container smoke5; image build|
|34|Real HTTP5RPS/30s steady,30RPS/60s burst,300message paused-worker backlog|load thresholds; receipt latency upper bound; max runnable depth/connections/waiting locks|
|35|Review Focus reused fixtures, voice end-to-end, ADRs/architecture and safe real-canary preparation|six Review Focus suites40 (includes ordered-head); canary guard2; static checks|

[Performance report](checkpoint-35-performance.json); [isolated restore report](checkpoint-35-restore.json). First load passed latency/drain thresholds but its depth counter included sleeping work; a focused repeat corrected runnable depth and measured phase-specific wake latency. This was a targeted metric correction, not a second full gate. PostgreSQL auto.conf contains default comments; backup rejects active configuration while allowing comments. Both are documented diagnostics, with progress and focused fixes.

Historical real-canary blocker, resolved by the PASS above: environment/local envfiles do not provide a dedicated test token, safe recipient confirmation or reachable HTTPS endpoint. Preflight exit2 names only MAX_BOT_TOKEN, MAX_WEBHOOK_SECRET, MAX_WEBHOOK_SECRET_VERSION, MAX_CANARY_TEST_CONFIRMED, MAX_CANARY_TEST_USER_ID, MAX_WEBHOOK_URL. No external calls, bot creation, server provisioning or real sends occurred. [Prepared canary checklist](../runbooks/foundation-canary.md) states the exact user-provisioned prerequisites. Do not accept Stage1 or start Task Domain from FakeMAX evidence alone. The user authorizes code/automated-evidence publication after the passing gate while real-canary acceptance remains pending.

## Specification §19 evidence map

| Acceptance requirement | Evidence |
|---|---|
|Real and repeated MAX text end-to-end|FakeMAX runtime checkpoint proves duplicate behavior; real-provider canary PASS, checkpoint-35-canary.json|
|Duplicate text/callback no second event/sequence/receipt/outbox/send|functional/runtime/checkpoint.test.ts|
|Strict sequence and unready head, terminal continuation|functional/runtime/worker.test.ts; functional/intake/ordered-head.test.ts|
|Independent conversations run concurrently|functional/runtime/checkpoint.test.ts; runtime/worker.test.ts|
|Expired worker cannot commit after another claim|functional/intake/queue-fencing.test.ts|
|Crash after processing commit preserves reply|e2e/foundation-flow.test.ts; functional/runtime/checkpoint.test.ts|
|Consumed-body timeout becomes uncertain, no blind retry|functional/runtime/checkpoint.test.ts; delivery-worker.test.ts|
|Tenant RLS isolation|functional/postgres/roles-and-transactions.test.ts; identity/RLS tests|
|Subscription detect/recover|functional/operations/subscription.test.ts and subscription-deadline.test.ts; real-provider PASS, checkpoint-35-canary.json|
|5RPS steady/30RPS burst, no Redis, drain thresholds|checkpoint-35-performance.json; manual performance scenario|
|Restore RPO≤5m/RTO≤4h and no old outbox|checkpoint-35-restore.json; restore-fence.test.ts; production second-storage/PITR continuity requires deployment evidence|
|Account erasure removes queues/content/mappings|functional/identity/deletion tests; operations/checkpoint.test.ts|
|No application/domain adapter imports|npm run lint:architecture; tests/architecture/dependency-boundaries.test.ts|

Backup/restore tooling and the local physical drill do not establish ongoing deployed WAL continuity, storage location, key escrow or monthly drills. Health intentionally reports backup unknown until operator monitoring establishes those facts. Canary/production setup requirements are operational blockers, not silently assumed successful results.


Cumulative review found four local issues: encrypted archived-WAL recovery/RPO proof missing; archive success before fsync; .history/.backup rejected; unready-head test absent from focused suite. Same executor adds authenticated archive preparation with a named recovery target, a post-base acknowledged marker drill, durable publish/retry, all valid PostgreSQL archive filename shapes and the existing ordered-head suite. SQL rejects snapshot cutoffs older than restored inbound/outbound so PITR cannot partially quarantine. One focused run had39/40 with an ingress503 in an existing restart/idempotency case; diagnostic assertion now exposes response code without retrying. The isolated affected test subsequently passed1/1; the failure remains preserved in local evidence. At that point the full gate had not run; its later failure and targeted repairs are recorded below.

Implementation commits:31=714bf94,32=bbe2334,33=804a806,34=dffb549,35=ec64bbe. Same-executor cumulative review corrections03fb24b were independently confirmed by the same reviewer, scoped to four findings. [Review record](checkpoint-35-review.md). The single final gate froze d818324 after a deterministic smoke-artifact setup correction, then failed as recorded below.


## Historical failed boundary and focused repairs

[Verification record](checkpoint-35-verification.log): the one full clean-clone gate on d818324 failed566PASS/3FAIL/1SKIP. Operational CLI main detection treated a symlinked /tmp checkout as a library and silently skipped encryption/manifest work. Same executor fixed it in1300def, added symlink regressions and fail-closed artifact assertions; targeted9/9 plus static checks passed and the same reviewer scoped-confirmed it. Same-clone checks passed backup5/canary3; physical drill then exposed an early hot-standby connection race. Test-only e351079 waits for promotion; same-clone physical1/1 plus static checks passed (acknowledged post-base marker RPO0ms/RTO12680ms). No second full gate was run. Functional/final build/image commands after the failed default suite were not reached; earlier iteration33 image/smoke evidence is not substituted for them.

Historical stopped state before the subsequent authorized repeats: code e351079 was ready for an explicitly authorized gate repeat. Stage1/checkpoint35 remain blocked on that repeat and a real dedicated-test MAX canary. The user must provision local TEST token, webhook secret/version, safe test user/confirmation and approved HTTPS endpoint (see runbook); nothing is sent externally until those prerequisites exist. Successful-checkpoint push is withheld; remote remains accepted checkpoint30 SHA55977f3. Final documentation-only commit and secret scans preserve this stopped state. No next stage begins.
