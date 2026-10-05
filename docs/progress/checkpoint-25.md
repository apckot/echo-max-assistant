# Checkpoint25 — transactional reply delivery

Implementation21–25 and per-step reviews complete; per-step verification is 541/541 plus functional 291/291. Whole-block review passed at `07564443cd2f6b7f2e962ddb23836ac4ffd18b4a`; no actionable P1/P2 remains. Exact-HEAD publication evidence is reported separately as described below. Accepted starting point: `5e8a5b708361bc9cd622929d760b543ea002a418`. Scope is iterations21–25. Iteration26 is not authorized until checkpoint acceptance.

## Implemented behavior

A shared-secret-authenticated MAX webhook is persisted once. Processing commits a typed receipt and neutral outbound drafts in the same transaction. Existing checkpoint20 receipts are materialized into the outbox by migration without replaying handlers. The outbound dedupe key binds source event and ordered draft index.

Delivery claims technical work under a renewable generation-fenced lease. A separate tenant transaction acknowledges durable admission before the single external call. The immutable journal records both attempt start and actual completion. Losing admission acknowledgement grants no send authority; losing completion acknowledgement grants no resend authority. Abandoned admitted attempts recover as uncertain. Network calls hold no database transaction or row lock.

Only proven retryable `not_sent` can retry: initial call plus at most five repeats. Retry scheduling uses database time, bounded jitter and the complete Retry-After minimum. Unknown transport failures, body-read timeout, malformed success and generic server failures remain uncertain. Conversation ordering and minimum 500 ms admission spacing apply across workers.

Stop records a monotonic per-conversation cancellation cutoff at the existing lifecycle update. Reactivation cannot resurrect an older pending/retry message or a draft materialized later from an older source event. Already admitted sending retains its actual certainty. Logical cancellation is immediate; physical cancelled status is materialized on claim/admission.

The delivery runtime composes the real database stores and MAX adapter, with bounded parallelism, polling, non-overlapping lease renewal and graceful drain. The checkpoint test uses a local HTTP fake MAX and actual gateway, processing and delivery runtimes. It asserts shared-secret rejection without effects, duplicate text/callback across restart, exact int64 recipient, no input-text copy, one confirmed reply per event, consumed-body timeout with uncertain/no resend, stop/start cancellation, tenant progress while another send is blocked, and ordered replies. Test setup does not seed outbound records into the primary flow.

## Reviewed commits and gates

Every accepted substep has tests-first evidence, independent review and its own atomic commit. Verify includes typecheck, architecture checks, the full default test suite and build; functional is run separately. Node22.23.3/npm11.16.0 and PostgreSQL17 are pinned. Test files run serially; concurrency assertions inside tests remain enabled.

| Iteration | Status | Implementation commit | Review result | Evidence | Carry |
| --- | --- | --- | --- | --- | --- |
| 21 | accepted | 8f4f507ef99b4a2b67c0954e60a677f531307295 | Shared Zod contract finding fixed in dcc2a7d2c86fcaefb4899a6863e4ebed36d02453; fresh scoped rereview approved | Default verify304/304 +functional179/179; typecheck/architecture/build; schema12→13 receipts backfill and atomic rollback | Next: MAX certainty adapter |
| 22 | accepted | 000ea8e611c83286296a7057e6d8e2a6694c840c | R1–R4 fixed in ea2982955e23d7eb100838ec7573e1bcc5be7819; HTTP-date R5 fixed in f7a0a51d1e1d74dd9004ff3943452164f50970ee; fresh scoped review PASS | Final default verify401/401 +functional179/179; typecheck/architecture/build pass; initial transient PG gate failure and passing baseline/repeat retained in checkpoint evidence | Next: durable delivery worker |
| 23A | accepted substep | 17d36aabada78614c10f5478e88a886dbd55b4c4 | Independent schema/queue spec and quality PASS; no blockers | Default verify413/413 +functional191/191; typecheck/architecture/build pass | Next: tenant delivery transitions; audited journal erasure remains29 |
| 23B1 | accepted substep | 172ca0b1f30aceb7cef9e314d786ed7127490090 | Independent scoped spec/quality PASS; no blockers | Resumed default verify427/427 +functional205/205; typecheck/architecture/build pass | DB-clock test fix 397870bba5fc1b67e3ffbb05946a4e9ebd31f8ba independently approved, verify428/428 +functional206/206; next admission/recovery |
| 23B2 | accepted substep | 7ea860889278452575f6c426e8c350f7633182cf | Independent admission/recovery spec and quality PASS; restored reviewed blobs unchanged | Default verify441/441 +functional219/219; typecheck/architecture/build pass | Next: actual completion and retry scheduling |
| 23B3 | accepted substep | 01b67ec3ed0dd075361c3e086404c5d13527a1a8 | Independent completion/fencing/time-bound review PASS; no findings | Default verify470/470 +functional248/248; typecheck/architecture/build pass | Next: sender orchestration and retry policy |
| 23 | accepted | 30a36536dc8e6b3b3852f86dcf01ef02a76bb3f4 | Independent single-send/retry-policy review PASS; no findings | Default verify495/495 +functional257/257; typecheck/architecture/build pass; all23 substeps accepted | Next: durable stop/cancellation races |
| 24 | accepted | 4e7dc0cd5d36f5330497d3b1c860581f31a7450a | Independent review PASS; no P1/P2 | verify509/509 + functional271/271, typecheck/architecture/build0; focused99/99 | Persistent logical stop cutoff; historical ambiguity fails migration; next25 |
| 25A | accepted substep | e6d0c654131931ee369679ce55bfe087c0bac5fb | Independent review PASS; no P1/P2 | verify520/520 +functional282/282; typecheck/architecture/build0 | Delivery deadline + restoreguard; initial HTTP503 failure retained; next runtime |
| 25B | accepted substep | ceda17cc4c8b5708e4dfc1836ac3ed6cee0bc770 | Independent review PASS; no P1/P2 | verify533/533 +functional286/286; typecheck/architecture/build0 | Delivery composition, bounded concurrency, restore guards and graceful drain; next end-to-end checkpoint |
| 25 | accepted implementation; checkpoint pending | 69573815129b24dd391d2246a2561f6efc2eae2c | Two test-proof P2 fixed in 07564443cd2f6b7f2e962ddb23836ac4ffd18b4a; fresh scoped review both ADDRESSED | verify541/541 +functional291/291; typecheck/architecture/build0; five real-runtime E2E cases | Whole-block review PASS; final publication gates recorded separately; STOP before26 |

Additional test-fixture fixes: `397870bba5fc1b67e3ffbb05946a4e9ebd31f8ba` compares delivery leases with the database clock (428/428 +206/206); `621a1c3bdc690bfa2daa1f4372cc1904b52702da` makes readiness/cleanup in deadline fixtures deterministic (428/428 +206/206). Both received independent reviews. No production deadline was increased.

25C independent review found two test-proof gaps: an immediate stop masked the environment-fence assertion, and the drain case did not recheck the final exact HTTP call sequence. A separate test-only fix replaces the first with deterministic default/on/off composition checks and adds the final sequence assertion. Both old tests let their targeted mutations survive; the repaired checks reject those mutations. Fix `07564443cd2f6b7f2e962ddb23836ac4ffd18b4a` passed verify541/541 +functional291/291 and fresh scoped review: both findings ADDRESSED, no new findings.

## Whole-block independent review

[The full independent review](checkpoint-25-review.md) covers accepted checkpoint20 through `07564443cd2f6b7f2e962ddb23836ac4ffd18b4a` (43 files). Verdict: PASS, no actionable P1/P2. The reviewer independently ran157/157 non-PG tests and inspected per-step PostgreSQL evidence. The coordinator’s ordinary final implementation gate passed541/541 plus functional291/291. A separate clean clone of the final documentation HEAD is required by the publication procedure below.

## Decisions and limits

- Generic MAX5xx remains uncertain because the documented contract does not prove nonacceptance. Cost: some undelivered messages need operator handling instead of an automatic retry. See official [send method](https://dev.max.ru/docs-api/methods/POST/messages) and [schema](https://github.com/max-messenger/api-schema), inspected October4.
- Five retries means six calls including the original, only for proven retryable not_sent. A valid Retry-After that cannot be safely scheduled produces an explicit permanent result, never an earlier fallback.
- Iterations22,23 and25 were split into sequential reviewed substeps to stay within the agreed review-size signal. Cost: additional commits and gates; module ownership and architecture are unchanged.
- Durable admission is the dispatch boundary. A crash after that commit but before an actual POST is indistinguishable from a possible send and conservatively becomes uncertain. Cost: automatic recovery can forgo an unsent reply in exchange for avoiding blind duplicates.
- Same-generation renewal preserves authority; expiry and due times use the database clock. Host timestamps do not authorize work. Expiry checks after locks and at finalization with locks held through COMMIT prevent stale-generation effects; they do not promise an exact physical-COMMIT wall-clock deadline. Pool closure does not imply instantaneous backend rollback.
- Logical stop cancellation avoids an unbounded bulk update inside the150ms webhook transaction. Cost: future metrics26 and retention28 must account for logically cancelled rows that still have pending/retry physical status. Unresolved sending remains an ordering predecessor.
- Migration16 rejects accounts with multiple existing conversations, any active conversation and any recorded historical stop. Earlier schemas did not record exact sibling cutoffs across account-wide stop/restart. Cost: affected databases need operator reconciliation before upgrade; the migration rolls back rather than guessing. All-stopped rows can be safely backfilled. No production database migration was performed.
- Historical backfill covers persisted durable-intake lifecycle events and currently stopped state. Pre16 manual/direct SQL stop/start without a recorded event cannot be reconstructed and also requires reconciliation. Post16 direct resolver state transitions are protected. No universal upgrade guarantee for unrecorded historical SQL mutations is claimed.
- The immutable attempts journal currently blocks DELETE even for the migrator. Iteration29 must add its audited erasure path; account deletion is not yet complete.
- Webhook authentication uses the platform shared secret; it is not a cryptographic payload signature. All external sends in tests target fake local MAX servers.

Delivery runtime timing: database operation T is half the worker renewal interval; default T=10s, sender=5s, renewal=20s and lease=60s. Delivery-specific validation requires `3T+S < lease` and `renew+2T < lease`. Existing worker-only configurations remain valid. A conservative work-drain allowance is 4T+S (45s by default), followed by pool closure of bounded operations. These budgets assume a responsive event loop and do not promise real-time operating-system scheduling. Custom unbounded ports have no bounded-drain guarantee.

Ruling: graceful runtime stop prevents new scans, late-claim launches and queued worker invocations, while already invoked work drains its admission/send/completion chain. Heartbeat continues until that work settles, and stop waits for the outstanding renewal before closing pools. Cost: shutdown can wait an additional bounded renewal and can include the send from an already running operation. Product bot_stopped is a separate conversation cancellation fence; runtime stop is not an instantaneous abort.

## Failed runs and diagnostic limits

The first22B default gate failed388/390 on two unchanged PostgreSQL tests. The accepted22A control passed319/319+179/179; unchanged22B repeat passed390/390+179/179; the subsequent date fix passed401/401+179/179. No exact cause was established for those failures.

October4 closed-lid host sleep interrupted testing. October5 resumed with an owned temporary idle-sleep assertion and no permanent power-setting change.23B1 then passed427/427+205/205.

The first23B2 candidate gate failed436/441 on two deadline-readiness fixtures and three HTTP503 cases. A repeat failed441/442 and accidentally included one scratch diagnostic test, so it is not clean gate evidence. Scratch probes were renamed and isolated thereafter. A first fixture repair exposed missing cleanup and an early fallback; fresh review found both, and the separate621a1c3 fix addressed them with bounded real watchdogs and deterministic clocks. Actual cumulative SQL deadlines remain tested. Some diagnostic failures were caused by the diagnostic spy itself and are not product failures. A corrected full HTTP diagnostic passed428/428. Historical random HTTP503 causes remain unclassified; this report does not claim they were fixed. Final clean-clone gates provide further reproducibility evidence, not a guarantee against every future timing failure.

25A initial full gate failed519/520 on the existing lifecycle HTTP replay case with503. A safe diagnostic full-suite substitution passed520/520; a fixed series of100 fresh-pool lifecycle cases returned300HTTP200 (maximum connection acquisition9.5ms, slowest request51.7ms). No causal cold-pool defect was demonstrated, so no speculative warmup, retry helper or deadline increase was added. The unchanged ordinary follow-up gate passed520/520 and separate functional282/282.

## Remaining work

26health,27subscription/lost-notify reconciliation,28technical retention,29account deletion and30operations checkpoint require the next acceptance. Full restored-backup reconciliation32, process/SIGTERM packaging33, load acceptance34 and real MAX canary35 are future work. No production deployment, live MAX call, AI/STT, billing or Mini App is included. The existing echo-secretary repository is read-only and remains at `4d5a516709dec8ed35681cc3159411d68fc1c9e3`, with its two preexisting untracked paths unchanged.

Exact final-HEAD clean-clone results, secret-scan counts and publication SHA are recorded in the coordinator’s final checkpoint response and its local evidence files. The publication procedure below requires those checks on the same SHA; feature-test results alone do not establish them.


## Reproduction and final publication procedure

Docker must be running. Check out the exact SHA from the coordinator's final response, then run:

```sh
npm exec --yes --package=node@22.23.3 --package=npm@11.16.0 -- sh -c 'npm ci && npm run verify && npm run verify && npm run test:functional'
git check-ignore --no-index .env .env.local .env.production
if git check-ignore --no-index .env.example; then exit 1; fi
git ls-files --error-unmatch .env.example
git status --porcelain
```

The coordinator commits this report before the final fresh clone. That clone uses no reused node_modules and verifies the exact final HEAD twice with the default gate, then functional separately. Gitleaks8.30.1 scans every commit reachable from that same HEAD using full-history/root traversal, without a baseline or allow-comment exclusions. Only after those checks does the coordinator push and independently compare `git ls-remote` with the local and verified-clone SHA. Exact final scan counts, gate results and remote SHA are reported after execution. A documentation commit does not substitute for these final gates.
