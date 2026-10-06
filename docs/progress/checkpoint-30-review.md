# Checkpoint30 independent review

One reviewer, GPT6.1Sol/high, reviewed cumulative d551f7c..8e79c2de3012f4655180aed36c3745b6d586bb71. Read-only, no full suite/gate, no subagents. Verdict: changes requested. The reviewer reproduced three findings using one narrow isolated PostgreSQL17 diagnostic; that original diagnostic used host Node24 and does not establish supported-runtime acceptance. The primary executor subsequently reproduced regressions on Node22.

| Finding | Severity | Trigger | Resolution evidence |
|---|---|---|---|
|Subscription callback outlives database leader|P1|Up to100 sequential5s requests inside30s transaction; DB expiry releases lock while callback continues|a34f9ff: shared20s budget + DB authority AbortSignal + callback settlement tracking. Original-SHA Node22 test observes old-secret then new-secret; corrected takeover permits only new-secret. Budget failure records degradation without install.|
|Permanent not_sent journals never expire|P2|Permanent rejection stores not_sent outbound/dead work; former terminal filter omitted not_sent|a34f9ff: terminal filter includes not_sent, retains runnable exclusion. Exactly90days retains journal;91days deletes both phases after dead work already removed.|
|Retention/recreation revives stale generation|P2|Dead conversation queue row removed; next event inserts generation0; same owner gets old generation1 again|a34f9ff: retired generation preserved in internal parent-scoped metadata. Parent lock precedes queue insert/retirement; same-owner old callback rejects after recreation. Parent FK cascade erases metadata with tenant.|

The fixes were made by the original executor in one separate review-fix commit. Node22 targeted operations/runtime check62 passed, authority/DB-role/stop-race check47 passed, typecheck and architecture guard passed. No full gate ran during review. An intentional original-SHA scratch test was temporarily discovered by a targeted suffix filter; that mixed run is rejected as GREEN evidence and the scratch checkout was moved outside the repository before corrected verification.

## Reviewer coverage and limits

Read current global/project instructions, iterations26–30 and Reference7–8, spec§12/14/16, cumulative diff and surrounding queue/admission/fencing. Existing dedupe, head ordering, transactional outbox and uncertain-no-retry paths remain unchanged. Health protects aggregate output and verifies checksum/fence. Deletion preserves sending certainty recovery, invalidates unadmitted leases, deletes in FK order and removes completed audit identity linkage.

Generation finding proves the DB/adapter fencing invariant; bounded runtime transactions reduce likelihood of a normal30day stalled callback. Retired generation intentionally outlives technical queue retention until identity/outbound privacy erasure. An HTTP cancellation prevents further dispatch by the old callback; it cannot recall a request already accepted remotely. Live MAX semantics require the iteration35 canary.

Reviewed but deferred/outside this block: full-gate and clean-clone results (handled once by the primary executor on final SHA), live MAX/API activity semantics, restored-backup replay reconciliation32, backup/log rotation, deployment/SIGTERM packaging33. These are future acceptance evidence, not silently treated as passing. Additional regression gaps noted by reviewer: concurrent ingress/processing versus deletion, and deletion batches containing blocked/failing jobs. No additional independent review seat or whole-checkpoint audit was requested.

Scoped confirmation by the same reviewer is recorded below before final checkpoint verification.

## Scoped confirmation on a34f9ff

The original reviewer marked all three findings ADDRESSED and found no concrete remaining defect in the directly affected code. This was a read-only check of fixes and supplied regression evidence, with no additional tests/gate or second whole-checkpoint audit. The reviewer reiterates that remote mutations already received cannot be recalled by HTTP cancellation; full checkpoint acceptance awaits the final gate.


## Executor verification after scoped confirmation

On October 6 the user authorized one repeat full checkpoint gate at repaired SHA a3dec1e. The fresh-clone gate passed default 554/554, separate functional 303/303, typecheck, architecture guard and build. Secret scans reported zero findings. This is executor verification after review, not a further independent audit. See [verification evidence](checkpoint-30-verification.log). The documentation publication commit does not change the verified runtime or tests.
