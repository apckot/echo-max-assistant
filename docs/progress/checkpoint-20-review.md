# Checkpoint 20 independent final review

**Reviewed range:** `45a923e505d574ac13098fd47026d78da8a260dc` → `5caeec709a27238f9d47092327ce8367562e7d02`.

**Scope:** Authorized iterations 16–20, including 20A/B/C1/C2 and the separate renewal/fixture fixes. The checkpoint brief and its explicit receipt-first and finalization-time rulings govern this incremental review alongside the stage specification, plan, and global constraints. This is approval of the event → durable receipt processing checkpoint, not acceptance of the entire stage.

## Strengths

- Claim is a finite `SKIP LOCKED` operation that increments the retained generation; renewal locks the identified row before checking fresh expiry. The accepted iteration-16 correction is present, with a real PostgreSQL lock-barrier regression (`src/infrastructure/postgres/postgres-conversation-queue.ts:19`, `:44`; `tests/functional/intake/queue-claim.test.ts:137`).
- The composition consistently locks state (when runtime admission is used), conversation, work, then current head. Initial and final owner/generation/expiry checks surround provisional effects, and finalization retains locks through COMMIT (`src/runtime/worker.ts:63`; `src/infrastructure/postgres/postgres-fenced-conversation.ts:16`, `:36`; `src/infrastructure/postgres/postgres-ordered-head.ts:39`). The SQL uses a fresh clock after acquiring relevant locks. No callback or heartbeat is awaited after the final guard.
- Head processing distinguishes drained state from an allocated gap, advances terminal heads one at a time, and defers preparation without charging retries. Sleeping work retains its generation and ingress wakes the same row. The concurrency tests exercise both ingress-before-inspection and ingress-after-drain interleavings (`src/infrastructure/postgres/postgres-ordered-head.ts:49`; `tests/functional/intake/ordered-head.test.ts:69`, `:155`, `:183`).
- The handler is pure and emits only neutral versioned drafts without echoing private input. Receipts preserve the complete ordered result, enforce source ownership and tenant RLS, deny worker updates/deletes, and reject conflicting results. Receipt, event outcome, pointer, and guarded work disposition commit together (`src/modules/intake/application/inbound-handler.ts:24`; `migrations/0010_processing_receipts.sql:4`, `:24`; `src/infrastructure/postgres/postgres-atomic-processing.ts:54`).
- Only an exception at the pure handler boundary creates the private recovery marker. Recovery uses a new fenced transaction and checks the same event ID, sequence, preparation state, and nonterminal status before mutation. SQL failures and uncertain commit acknowledgements do not charge a successor. Five recorded failures create one terminal result and expose the next head, while unrelated inbound preserves retry backoff (`src/infrastructure/postgres/postgres-atomic-processing.ts:29`, `:36`; `src/infrastructure/postgres/postgres-ordered-head.ts:49`; `migrations/0011_preserve_processing_retry.sql:8`).
- The application deadline races only the pure handler; late settlement cannot resume persistence. Runtime production ports also have a finite acquisition/transaction deadline. Claims are serialized and bounded by free slots; each slot includes its pending renewal. Stop suppresses queued scans, abandons late claims, drains operations, then awaits actual pool closure (`src/modules/intake/application/process-inbound.ts:30`; `src/runtime/worker.ts:23`, `:40`, `:49`, `:61`).
- The runtime restore guard fails closed on an enabled or missing singleton, grants only a narrow worker capability, and holds state admission through the transaction. Production echo opt-in precedes resource creation. The restart smoke demonstrates preservation of a committed result, precommit abandonment with zero retry charge, natural lease reclaim, exact second result, replay stability, and eventual session cleanup (`migrations/0012_worker_restore_guard.sql:1`; `src/runtime/worker.ts:59`; `tests/functional/runtime/worker.test.ts:51`, `:87`).

## Issues

### Critical — must fix

None found.

### Important — should fix

None found.

### Minor — nice to have

None found. No observations are being silently parked as deferred minor findings.

## Verification and review method

- Read the supplied 2,570-line unified review artifact in sequential portions, recovering the portion omitted by initial tool-output truncation. Did not regenerate the diff or independently reread changed production files.
- Read the checkpoint brief, global constraints, stage specification and relevant plan requirements, checkpoint task-review evidence, 20C2 report, and all iteration 16–20 accepted reviews and fix reviews.
- For the concrete integration risk that runtime stop could leave live transaction access or unbounded acquisition tails, inspected the unchanged deadline/callback/COMMIT/close sections of `database.ts` omitted from the diff. Expiry invalidates access and discards the session; a late acquisition is checked before BEGIN; COMMIT acknowledgement uncertainty is preserved; close awaits the real pools. The prior C1 review also documents the installed pool implementation's finite acquisition behavior.
- The restored candidate gate log records **293/293 tests**, **173/173 functional tests**, and successful typecheck, architecture guard, and build. The controller reports all gate commands exited 0. The clean-clone log and controller report confirm `npm ci` and the same gate passed on the exact reviewed SHA, with clean clone status.
- No suites, PostgreSQL probes, subagents, Git mutations, code changes, or index changes were performed by this reviewer. Only this authorized scratch review was written.
- Previously raised renewal-after-lock-expiry and early-failure fixture-cleanup findings have explicit accepted fixes and retained regression coverage. No unresolved earlier finding was identified.

## Recommendations

No additional changes are required in the reviewed code. The controller should finish the already assigned documentation publication and final-HEAD secret scan, and preserve the receipt materialization obligation when iteration 21 is authorized.

## Declined to judge

Every considered behavior excluded from this approval is listed below for an explicit controller ruling:

1. **Actual outbound/delivery-work creation and delivery to MAX:** explicitly assigned to iteration 21 and later; this checkpoint durably retains typed drafts. Iteration 21 must materialize both preexisting receipts and new results by event/type/ordinal without rehandling. The current approval does not establish delivered messages or complete stage-level outbox atomicity.
2. **Metrics, operational health, and persistent reporting of swallowed runtime failures:** operational observability belongs to iteration 26. This block contains and observes promise failures and retains durable recovery, but does not yet provide the later operational visibility contract.
3. **Scheduler, full restore procedure, account deletion/retention, and delivery certainty:** later authorized plan work; this review covers periodic worker discovery and transaction admission fencing only. It does not establish the full stage's recovery, privacy erasure, backup/RPO/RTO, or external delivery requirements.
4. **OS process crash/SIGTERM packaging and real server shutdown:** process packaging is iteration 33. The demonstrated API-level stop/restart and transaction abandonment are adequate for this checkpoint, but are not a deployment or signal-handling acceptance test.
5. **Production load targets and real MAX canary:** assigned to iterations 34 and 35. Bounded concurrency and independent progress are covered here; target throughput, queue latency, and provider interoperability are not established.
6. **A hard real-time shutdown SLA, arbitrarily blocked event loops/OS/network execution, or instantaneous PostgreSQL rollback at pool close:** not the accepted C1/C2 contract. Production operation drain is finite under a responsive event loop; backend cleanup can lag disconnect. The report explicitly qualifies the conservative resource allowance and the smoke checks eventual backend cleanup. Custom unbounded `startWorkerLoop` ports do not inherit production guarantees.
7. **Expiry checked at the exact physical COMMIT instant:** explicitly superseded by the checkpoint's finalization-time ruling. The final lease guard runs before release and all locks remain held through COMMIT; this approval is for those semantics.
8. **A fresh audit of every unchanged baseline schema grant and all earlier ingress behavior:** accepted checkpoint-15 baseline is outside this diff. New receipt ownership/RLS/grants, worker guard permissions, relevant cross-tenant behavior, and changed wake behavior were reviewed; the controller's full regression and clean-clone gates cover the integrated repository.
9. **Final documentation publication, final documentation-HEAD Gitleaks, and push:** controller-owned and still pending at review completion. Clean-clone code verification is complete; this report makes no claim that those remaining publication steps have completed.

## Assessment

**Ready to merge? Yes, for the authorized iterations 16–20 code scope.**

**Reasoning:** The composed implementation preserves fencing, strict head order, immutable durable results, exact-head retry authority, and bounded production runtime drain, with substantive real-database concurrency and fault coverage. No Critical, Important, or Minor code findings remain; the listed later-stage behaviors and pending publication checks are explicitly outside this scoped approval.

## Controller disposition of all nine review exclusions

1. Accepted incremental boundary: outbox/delivery remains21+; carry preexisting receipt materialization by event/type/ordinal without rehandling into21.
2. Operational observability remains26; no monitoring/health completeness is claimed now.
3. Scheduler/reconciliation, full restore, deletion/retention and delivery certainty remain their later planned iterations; current evidence establishes discovery, durable processing and admission fencing only.
4. Process/SIGTERM packaging remains33; this checkpoint explicitly proves API stop/restart and transaction abandonment only.
5. Load and live MAX canary remain34/35; no target throughput or provider interoperability claim.
6. Accept the documented finite production-port/event-loop contract and eventual backend cleanup. No hard real-time or arbitrary custom-port guarantee; no architecture change required.
7. Accept finalization-time expiry semantics already reviewed: final guard before disposition, locks through COMMIT. Exact physical COMMIT-time expiry is not claimed.
8. Accepted checkpoint15 remains baseline. New and changed boundaries received focused review; full regression and clean-clone gates passed. No request for a new whole-baseline audit.
9. Controller owns final documentation, final-HEAD Gitleaks and push/remote verification. They remain publication gates, not deferred product findings; results are recorded when executed.

No open or deferred review finding remains for authorized16–20. No21+ implementation authorized.

## Per-task independent review archive

### iteration-16-review.md

### Spec Compliance

- ❌ Issues found: renewal can extend an already expired lease after waiting on a row lock, violating the brief's explicit non-revival requirement (`src/infrastructure/postgres/postgres-conversation-queue.ts:49-55`). The claim path, bounded batch, `SKIP LOCKED`, technical-only result, owner/generation fencing, and retained generation otherwise match the iteration scope (`src/infrastructure/postgres/postgres-conversation-queue.ts:19-41`, `src/modules/intake/application/conversation-queue.ts:4-24`).

### Strengths

- The atomic claim selects at most 100 due ready/retry or expired leased rows with `FOR UPDATE SKIP LOCKED`, then changes ownership and increments generation in the same worker transaction (`src/infrastructure/postgres/postgres-conversation-queue.ts:19-37`).
- The neutral contract carries internal IDs and technical metadata only; it explicitly defines `attemptCount` as recorded transient failures (`src/modules/intake/application/conversation-queue.ts:4-24`). The focused real-PostgreSQL tests cover competing claims, skipped locks, reclaim, rollback, bounds, and immediate stale renewals (`tests/functional/intake/queue-claim.test.ts:62-165`).
- The diff makes no migration, event processing, runtime heartbeat, handler, or final commit changes. The existing queue primary key and lease generation constraint support one durable row per conversation (`migrations/0008_conversation_work.sql:1-19`).

### Issues

#### Critical (Must Fix)

- None.

#### Important (Should Fix)

- `src/infrastructure/postgres/postgres-conversation-queue.ts:49-55`: PostgreSQL can evaluate `lease_until > clock_timestamp()` before the `UPDATE` waits for a row lock. If another transaction holds an unchanged row until the lease expires, this renewal still updates and revives it. A focused PostgreSQL 17 lock-barrier probe held `FOR UPDATE`, started the same conditional `UPDATE` while the lease was live, released the lock after expiry, and got `renewalRows: 1, revived: true`. The immediate-expiry test at `tests/functional/intake/queue-claim.test.ts:120-134` cannot catch this. Lock the identified work row first, then evaluate its expiry using a fresh database clock after acquiring the lock, in the same transaction; add a lock-barrier regression test. The worker's one-second lock timeout (`src/infrastructure/postgres/database.ts:117-120`) still permits waits short enough to cross an expiry boundary.

#### Minor (Nice to Have)

- None.

### Assessment

**Task quality:** Needs fixes.

**Reasoning:** Claim and most renewal fencing are well scoped and tested, but renewal violates a stated safety invariant under lock contention. The parent reports the full gate passed on candidate tree `6601460b15dae84869caafdc89fd05b747389771`; the lock-barrier probe establishes a case absent from that gate.


### fix-16-review.md

### Finding Verdicts

- **Renewal can revive a lease that expires while waiting on an unchanged row lock** — ADDRESSED. `src/infrastructure/postgres/postgres-conversation-queue.ts:49-61` acquires `FOR UPDATE` for the exact internal IDs, owner, generation, and leased state before issuing the conditional `UPDATE` in the same transaction. The expiry predicate uses `clock_timestamp()` after lock acquisition. `tests/functional/intake/queue-claim.test.ts:137-169` holds an unchanged row lock, observes the renewal waiting while the lease is live, releases the lock after expiry, and requires `null` with the original deadline intact. The fix report records this test failing before the production edit (expired lease revived) and the focused eight-test file and typecheck passing afterward. Existing normal, wrong-owner, stale-generation, and expired-token assertions remain at `tests/functional/intake/queue-claim.test.ts:122-134`.

### New Breakage in the Fix Diff

- None. The update retains the exact token and state predicates, bounded lease validation, and `GREATEST` no-shrink behavior at `src/infrastructure/postgres/postgres-conversation-queue.ts:44-61`; the additional lock is held within the existing worker transaction.

### Out-of-Scope Observations

- None.

### Verdict

**Fix round:** All findings addressed, no new Critical/Important breakage. Review only; no tests rerun.


### iteration-17-review.md

### Spec Compliance

- ✅ Spec compliant for iteration 17 at frozen tree `8f3e31a7aef121f61e8c20685df8f020fd2c40a5`, base `3b17b6e90879e5f80b9df17abc5336f66d1e9833`. The boundary verifies internal IDs, leased state, owner, generation, and fresh expiry before callback entry; conversation is locked before work (`src/infrastructure/postgres/postgres-fenced-conversation.ts:12–27`).
- ✅ Finalization owns the conditional work transition, checks current expiry before clearing ownership, requires one row, retains generation, and returns directly for commit (`src/infrastructure/postgres/postgres-fenced-conversation.ts:29–49`). This matches the brief's finalization clarification, including finalization-time rather than exact COMMIT-instant expiry semantics.
- ✅ Scope remains three files: an infrastructure boundary, neutral disposition/error contracts, and real-PG tests. No runner, ordering, handler, receipt, outbox, dependency, or migration additions (`src/modules/intake/application/work-disposition.ts:1–14`; `src/infrastructure/postgres/postgres-fenced-conversation.ts:1–52`).
- ⚠️ Existing schema-wide FORCE RLS, grants, and absence of sensitive queue data are not re-audited in this task diff. The new tenant-isolation behavior is exercised at `tests/functional/intake/queue-fencing.test.ts:154–166`; retain the controller's existing schema/security gates. Full-suite execution belongs to the controller; it was not rerun here.

### Strengths

- Entry validation happens after both row locks are acquired, avoiding a stale pre-wait expiry decision; the final guard uses `clock_timestamp()` again (`src/infrastructure/postgres/postgres-fenced-conversation.ts:16–27,34–47`).
- The callback cannot successfully release the token and bypass the final lease check: the adapter owns that transition and throws on a failed guard, rolling back prior tenant writes (`src/infrastructure/postgres/postgres-fenced-conversation.ts:29–49`). Valid keep/ready/retry/sleep and deferred availability have behavioral coverage (`tests/functional/intake/queue-fencing.test.ts:81–110`).
- Tests exercise replaced-generation rejection, seven denial variants before callback entry, cross-tenant isolation, callback exceptions, and fresh-clock expiry rollback (`tests/functional/intake/queue-fencing.test.ts:112–191`). Existing inbound service-state fields provide provisional effects without speculative production tables (`tests/functional/intake/queue-fencing.test.ts:69–76`).
- Real transaction barriers test lock retention between finalization and COMMIT, and an ingress interleaving verifies conversation-before-work compatibility (`tests/functional/intake/queue-fencing.test.ts:193–243`).
- Neutral application types contain no database or infrastructure dependencies, while the DbTx callback is explicitly infrastructure-owned (`src/modules/intake/application/work-disposition.ts:1–14`; `src/infrastructure/postgres/postgres-fenced-conversation.ts:1–11`).

### Issues

#### Critical (Must Fix)

- None found.

#### Important (Should Fix)

- None found.

#### Minor (Nice to Have)

- None found.

### Assessment

**Task quality:** Approved.

**Reasoning:** The implementation satisfies the scoped fencing and finalization contract with a small adapter and targeted real-database evidence. It preserves tenant isolation and locks through transaction completion without introducing future processing policy.

- Check performed: read the supplied review diff once, the brief/global constraints/implementation report, authoritative spec §§7.3 and 9.2–9.3, and the focused preflight finalization guidance. No broad repository crawl or test rerun.
- Named risk checked outside the diff: the existing Database wrapper could swallow/retype the neutral lease-loss signal, fail to roll back provisional effects, or weaken deadlines. Focused read of `src/infrastructure/postgres/database.ts` confirms tenant setting before callback, worker 5s statement timeout and gateway 150ms deadline, callback-error rollback, preservation of Error values without a code property, and COMMIT before returning the callback result. No Database API change is necessary.
- Evidence assessed: the implementer reports expected scaffold RED (19 failures), GREEN (19 passes), and adjacent claim regression verification (27 passes plus typecheck), with pristine output. Controller full gate remains separate. No PostgreSQL tests were launched concurrently.


### iteration-18-review.md

### Spec Compliance

- ✅ Spec compliant. `src/infrastructure/postgres/postgres-ordered-head.ts:39-69` examines only `next_apply_sequence` under the iteration-17 fence, advances terminal heads once, defers a preparing head, fails closed on an allocated gap, sleeps a drained row, and offers an actionable head through the fenced callback. `src/infrastructure/postgres/postgres-fenced-conversation.ts:34-48` preserves retry metadata on preparation deferral and retains lease generation on release.
- ✅ The requested real-PostgreSQL cases cover ordering, terminal advancement, drain/wake, independent conversations, stale lease, rollback, and both intake/processing interleavings (`tests/functional/intake/ordered-head.test.ts:69-256`). The report records the focused RED/GREEN run, adjacent queue tests, typecheck, architecture lint, and clean diff check (`.superpowers/sdd/2026-10-01-max-assistant-stage-1-foundation/iteration-18-report.md:39-72`). The parent owns the full gate.

### Strengths

- `src/infrastructure/postgres/postgres-ordered-head.ts:39-68` keeps the conversation→work→head lock order and returns an explicit actionable callback result without implicitly changing the event to applied.
- `src/infrastructure/postgres/postgres-ordered-head.ts:48-55` distinguishes a truly drained conversation from a missing allocated event, preserving the pointer and work state through transaction rollback on the latter.
- `src/infrastructure/postgres/postgres-fenced-conversation.ts:34-48` adds a narrow `defer` outcome while retaining the existing final token guard and retry metadata.
- Focused unchanged-code checks: `src/modules/intake/domain/inbound-event.ts:3-31` matches the event fields mapped at `src/infrastructure/postgres/postgres-ordered-head.ts:17-28`; `migrations/0008_conversation_work.sql:27-43` wakes a retained sleeping row without resetting its generation; `migrations/0006_inbound_events.sql:62-72` grants the worker the tenant-scoped event access used by the new query.

### Issues

#### Critical (Must Fix)

- None.

#### Important (Should Fix)

- None.

#### Minor (Nice to Have)

- None.

### Assessment

**Task quality:** Approved

**Reasoning:** The implementation meets iteration 18's ordering and persistent-work boundaries without adding handler, receipt, worker-loop, or outbox behavior. The focused tests exercise the specified concurrency and rollback cases; the parent full gate remains the final verification step.


### iteration-19-review.md

### Spec Compliance

- ✅ Spec compliant. `src/modules/intake/application/inbound-handler.ts:3-47` exposes the requested async handler and versioned neutral receipt/drafts. Text uses only the internal sequence (`:26-28`); voice and button produce the specified safe responses (`:29-34`); lifecycle produces no draft (`:35-36`). The implementation has no infrastructure imports or side effects.
- ⚠️ The cross-iteration guarantees of durable receipt serialization and future outbox materialization cannot be verified from this pure-handler diff; the controller should check them in iterations 20 and 21.

### Strengths

- `src/modules/intake/application/inbound-handler.ts:3-21` keeps the input minimal and the output contract typed, immutable, versioned, and independent of MAX or storage.
- `tests/unit/intake/foundation-inbound-handler.test.ts:17-62` covers all current payload variants, stable output, absence of copied secrets, and full bigint sequence formatting.

### Issues

#### Critical (Must Fix)

- None.

#### Important (Should Fix)

- None.

#### Minor (Nice to Have)

- None.

### Assessment

**Task quality:** Approved

**Reasoning:** The implementation matches the scoped deterministic handler contract and tests its meaningful privacy and formatting boundaries. The reported focused tests, typecheck, and architecture lint passed; no additional test was needed for a concrete unresolved doubt.

**Focused checks:** Read the stage spec §10 (`2026-10-01-max-assistant-stage-1-foundation-design.md:273-292`) to resolve whether voice requires a typed failure result: it specifies a user-facing future-voice message in the handler, which `inbound-handler.ts:29-31` supplies. Read the existing `InboundPayload` union (`src/modules/intake/domain/inbound-event.ts:5-9`) to confirm the switch covers every current kind and both lifecycle values.


### iteration-20a-review.md

### Spec Compliance

- ✅ Spec compliant for the approved 20A boundary. Tenant receipt ownership, uniqueness, append-only worker access and closed typed JSON are implemented at `migrations/0010_processing_receipts.sql:4-47`. Full ordered results are persisted and conflicts validated at `src/infrastructure/postgres/postgres-atomic-processing.ts:19-31`; outcome, pointer and disposition follow within the same transaction at lines 32-43.
- ✅ The application runner has a neutral port and an independent bounded handler deadline; late settlement cannot reach persistence (`src/modules/intake/application/process-inbound.ts:5-7,20-40`). Preparation failure remains recoverable by throwing before mutations (`src/infrastructure/postgres/postgres-atomic-processing.ts:13-14`). Retry/failure policy in 20B, runtime/config integration in 20C and outbox materialization in 21 are explicitly approved incremental exclusions, not missing 20A work.
- ⚠️ Parent full gate is outside this review. Inspected scoped evidence reports 28 passing tests and clean typecheck in `iteration-20a-green-final.log:10-11` and `iteration-20a-typecheck.log:2-3`; no suite or PostgreSQL probe was rerun.

### Strengths

- Receipt conflict handling checks persisted source, type, version and JSON equality before applying the event; JSON array order is preserved and the returned result comes from persisted data (`src/infrastructure/postgres/postgres-atomic-processing.ts:20-31,43`).
- Tests exercise actual role grants, RLS, ownership and result-shape constraints (`tests/functional/intake/processing-result.test.ts:68-94`), receipt conflict/replay (`:122-137`), rollback after insertion (`:139-152`), late result suppression (`:154-164`) and final lease expiry (`:180-190`).
- The timer is cleared on success/error and the elapsed-time check rejects a result after a delayed event loop (`src/modules/intake/application/process-inbound.ts:29-40`); exact and shorter deadlines, late resolution/rejection and invalid configuration are covered at `tests/unit/intake/process-inbound.test.ts:9-38`.

### Issues

- Critical: none.
- Important: none.
- Minor: none.

### Focused unchanged-code checks

- Risk: the new callback could run outside the locked current head or bypass fresh final fencing. Checked `src/infrastructure/postgres/postgres-ordered-head.ts:33-69` and `src/infrastructure/postgres/postgres-fenced-conversation.ts:13-50`: the head is locked under conversation/work locks, only the actionable current head invokes the callback, and guarded release remains the last business mutation.
- Risk: timeout/mismatch errors could return before rollback or expose uncommitted results. Checked `src/infrastructure/postgres/database.ts:117-150`: worker SQL timeout is separate, callback failure rolls back before propagating, neutral errors survive, and successful results return after COMMIT.
- Checked authoritative design sections 9.2–10 against the supplied approved incremental brief. Read the frozen review diff once; no changed source file was separately reread, and no product/index/branch mutations were made.

### Assessment

**Task quality:** Approved.

**Reasoning:** The scoped implementation preserves tenant boundaries and atomic receipt/outcome/pointer/work updates, with fail-closed conflict validation and a correctly isolated pure-handler deadline. No blocking correctness, security or maintainability findings were identified in the frozen candidate tree `554fa00cab2e70f479e60d32d1cdaf85f5a11693` against base `36fe9c09e746982cc8548ffd68ae27cf6a0bd662`.


### iteration-20b-review.md

### Spec Compliance

- ✅ Spec compliant for iteration 20B. Pure callback failures alone enter recovery; event-local attempts 1–4 schedule retries and the fifth saves the error result and advances the head (`src/infrastructure/postgres/postgres-atomic-processing.ts:29`, `:36`, `:38`, `:43`). Preparation failure has a terminal receipt without a charged attempt (`tests/functional/intake/processing-result.test.ts:189`).
- ✅ Recovery validates the exact event identity, sequence, preparation state and nonterminal status before mutation (`src/infrastructure/postgres/postgres-ordered-head.ts:49`). The inherited fence checks the owner, generation and live lease before processing and before release (`src/infrastructure/postgres/postgres-fenced-conversation.ts:24`, `:36`).
- ✅ Unrelated inbound preserves retry state, delay, count and error; sleeping ready work can still wake (`migrations/0011_preserve_processing_retry.sql:8`, `tests/functional/intake/processing-result.test.ts:209`). Retry policy is exponential with bounded jitter and a five-minute cap (`src/modules/intake/application/process-inbound.ts:47`).
- ✅ No runtime scheduler, actual outbox/delivery, dependencies or second queue was introduced. Runtime 20C and outbox 21 remain explicitly deferred by the brief.
- ⚠️ Parent-owned full gate is outside this review. Inspected focused GREEN evidence reports 55/55 passing and typecheck exit success, with no warnings; no suite was rerun (`iteration-20b-green-final.log`, `iteration-20b-typecheck-final.log`).

### Strengths

- Success, exhausted retry and preparation failure share a single immutable receipt/completion owner, retaining mismatch rejection and atomic pointer advancement (`src/infrastructure/postgres/postgres-atomic-processing.ts:54`).
- Regression tests exercise exact five-failure progression, successor budget isolation, pre-commit crash/reclaim, successful commit acknowledgement loss, retry/terminal recovery acknowledgement loss, and stale token/head/identity/terminal/preparation races (`tests/functional/intake/processing-result.test.ts:209`, `:266`, `:284`, `:299`).
- Handler exceptions with SQL-like error codes are classified at the pure boundary; preparing and database lock contention leave the head's budget untouched (`src/infrastructure/postgres/postgres-atomic-processing.ts:29`, `tests/functional/intake/processing-result.test.ts:255`).

### Issues

- Critical: none found.
- Important: none found.
- Minor: none found.

### Focused Checks

- Reviewed the supplied diff against base `22dde5058b3b0b60df4873f3625b41ed9023e339` and frozen tree `0f345ac8680aa8e55651093d22db675cbfb22b22`; recovered the truncated tool-output segment from the same diff. No git commands, tests, agents, or product/index changes.
- Named risk: transaction normalization might erase or misclassify the pure-failure marker, or return before commit. Inspected unchanged `database.ts`: callback errors pass through rollback, safe no-code errors retain identity, and COMMIT precedes return (`src/infrastructure/postgres/database.ts:134`, `:138`, `:147`).
- Named risk: fresh recovery might omit owner/generation/expiry validation or lose retry disposition metadata. Inspected unchanged fenced transaction and disposition contract; both initial validation and final guarded release remain shared (`src/infrastructure/postgres/postgres-fenced-conversation.ts:24`, `:36`, `:49`).
- The ordered-head diff ends mid-function. Inspected only its remaining tail to verify terminal/preparing paths and callback result wrapping; the expected-head guard precedes all of them (`src/infrastructure/postgres/postgres-ordered-head.ts:49`, `:57`, `:66`, `:74`).
- Checked the authoritative specification's lease/retry paragraph against the brief's receipt-first split; actual outbox materialization and runtime metrics remain later scope.

### Assessment

**Task quality:** Approved.

**Reasoning:** Failure classification, recovery fencing, retry authority and atomic terminal completion meet the scoped requirements. The inspected regression coverage addresses the principal crash, acknowledgement-loss and stale-recovery risks without broadening into later runtime or delivery work.


### iteration-20c1-review.md

### Spec Compliance

- ✅ Spec compliant: the opt-in `workerTransactionTimeoutMs` is validated before pool construction, bounds worker pool acquisition and the full transaction, and leaves the gateway and default worker paths intact (`src/infrastructure/postgres/database.ts:51-75`, `:86-87`, `:164-168`). The shared deadline path invalidates the callback capability, discards an expired client, checks a late acquisition before `BEGIN`, and checks after COMMIT acknowledgement (`:95-113`, `:120-123`, `:133-150`, `:152-162`).
- ⚠️ Cannot verify from this task diff: runtime draining and its deadline-to-handler/lease relationship belong to 20C2; this primitive alone makes no runtime shutdown claim (`src/infrastructure/postgres/database.ts:178-180`).

### Strengths

- The five added PostgreSQL tests exercise real SQL for cumulative rollback, suspended callbacks, queued acquisition, and the uncertain delayed-COMMIT case; they also assert default worker behavior and fixed statement/lock limits (`tests/functional/postgres/roles-and-transactions.test.ts:263-394`).
- A late callback query fails through the existing closed transaction guard, while a late acquisition is discarded before `BEGIN` (`src/infrastructure/postgres/database.ts:121-123`, `:133-136`; `tests/functional/postgres/roles-and-transactions.test.ts:291-361`).
- The delayed acknowledgement test correctly permits a committed row after `DB_TIMEOUT` and verifies that the next transaction gets a different backend (`tests/functional/postgres/roles-and-transactions.test.ts:363-394`).

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

None.

#### Minor (Nice to Have)

None.

### Assessment

**Task quality:** Approved.

**Reasoning:** The bounded worker option reuses the established transaction deadline without changing other roles. The installed `pg-pool` implementation was checked for the named shutdown risk: `connectionTimeoutMillis` times out queued acquisition and destroys a stalled new connection (`node_modules/pg-pool/index.js:197-225`, `:245-296`); `Pool.end()` waits for client removal (`:127-146`, `:490-499`). The implementer's focused RED/GREEN and typecheck evidence was inspected; no suite or PostgreSQL probe was rerun during review.


### fix-20c1-review.md

**Worker acquisition fixture hangs and leaks its global connect spy when the first acquisition fails before readiness** — ADDRESSED. `tests/functional/postgres/roles-and-transactions.test.ts:387-413` starts the transaction inside `try`, races readiness with its settlement, and always releases the barrier, restores the spy, observes started transactions, and closes the bounded pool. The injected first-connect failure at lines 366-370 exercises that path; lines 416-419 assert the spy was restored and the pool closed.

**Adjacent worker callback fixture waits for readiness outside cleanup and can leak its held work/pool on early failure** — ADDRESSED. `tests/functional/postgres/roles-and-transactions.test.ts:298-339` races readiness with transaction settlement and runs barrier release, promise observation, and pool closure in `finally`. Lines 299-303 and 349-351 exercise a callback failure before readiness; lines 340-342 retain the closed-pool and no-write assertions.

**New breakage in fix diff:** None. The original deadline, late-query, queued-acquisition, no-BEGIN, and no-callback assertions remain at `tests/functional/postgres/roles-and-transactions.test.ts:324-332` and `:400-419`.

**Out-of-scope observations:** None.

**Checks:** Reviewed the supplied 119-line, one-file fix diff and the two fixtures. The implementer report names the focused PostgreSQL test (23/23 passed) and typecheck; the coordinator gate log independently records verify (284/284 unit tests) and functional (169/169 tests) with exit code 0. The RED injection is described in the implementer report but has no separate retained output. No test was rerun for this review.

**Fix round:** All findings addressed, no new Critical/Important breakage.


### iteration-20c2-review.md

### Spec Compliance

- ✅ Spec compliant for iteration 20C2, reviewed against base `85bc6442e9b23439c49a58eaa7c683ac7d8e119a` and supplied candidate tree `a3a5361d6492d5413bcba7d532d61fe16ef4ba79`. The runtime composes the accepted queue/processor/handler, restricts claims to free capacity, scans independently of notifications, drains outstanding operations before closing the database, and applies both restore fences: `src/runtime/worker.ts:16`, `src/runtime/worker.ts:40`, `src/runtime/worker.ts:49`, `src/runtime/worker.ts:59`.
- ✅ Config retains valid lower handler deadlines while enforcing the five-second maximum and passing the configured value to the processor: `src/shared/config/config.ts:27`, `src/runtime/worker.ts:74`, `tests/unit/config.test.ts:84`, `tests/functional/runtime/worker.test.ts:78`.
- ✅ The same-database restart test covers committed typed results, precommit abandonment, natural lease reclaim, unchanged attempt counts, unique receipt identities, sequence advancement, replay stability, and eventual runtime-session cleanup: `tests/functional/runtime/worker.test.ts:87`.
- ⚠️ Full repository gate, clean-clone checks, Gitleaks, commit, and push are controller-owned and are not established by this diff review. Metrics 26, process/SIGTERM packaging 33, and outbox/delivery 21 remain explicitly outside this task.

### Strengths

- The single scan promise prevents overlapping claims; a slot remains occupied until both its processor and any outstanding renewal settle. Claim limits therefore cannot oversubscribe production concurrency, including when another slot finishes during a claim: `src/runtime/worker.ts:18`, `src/runtime/worker.ts:23`, `src/runtime/worker.ts:40`; behavioral coverage at `tests/unit/runtime/worker.test.ts:11`, `tests/unit/runtime/worker.test.ts:42`.
- Immediate stop prevents the queued claim continuation from issuing a claim. A claim already in progress is awaited and its returned leases are abandoned without launching work; stop is idempotent and closes only after the drain: `src/runtime/worker.ts:42`, `src/runtime/worker.ts:49`; coverage at `tests/unit/runtime/worker.test.ts:30`, `tests/unit/runtime/worker.test.ts:56`.
- Production enables the accepted finite worker transaction/acquisition deadline and uses the renewal interval as its budget. Both normal processing and handler-failure recovery use the guarded database; renewal is independent and never awaited inside a processing transaction: `src/runtime/worker.ts:25`, `src/runtime/worker.ts:61`, `src/runtime/worker.ts:63`.
- The restore guard fails closed, fixes its search path, grants the worker only function execution, and retains the state-row share lock before conversation/work locks through transaction completion. Fence activation ordering and raw-state denial receive real PostgreSQL coverage: `migrations/0012_worker_restore_guard.sql:1`, `src/runtime/worker.ts:63`, `tests/functional/runtime/worker.test.ts:51`, `tests/functional/runtime/worker.test.ts:68`.

### Issues

#### Critical (Must Fix)

- None.

#### Important (Should Fix)

- None.

#### Minor (Nice to Have)

- None.

### Assessment

**Task quality:** Approved.

**Reasoning:** The bounded loop and production composition match the scoped checkpoint, with meaningful fault and restart evidence. The report correctly limits shutdown claims to finite operation/resource drain under a responsive event loop; it does not claim instantaneous PostgreSQL rollback or completed delivery.

**Checks performed:** Read the supplied diff once and compared all eight changed files with the brief, constraints, report, and relevant authoritative spec sections 9.2/13. No changed-file rereads, Git commands, suites, or PostgreSQL probes were run.

**Focused unchanged-code checks:** For the concrete risk that stop merely hides unfinished writes or acquires clients indefinitely, inspected `src/infrastructure/postgres/database.ts` and confirmed deadline coverage, expired-access invalidation, discarded sessions, finite worker acquisition, and actual pool closure. For the concrete risk that recovery bypasses the deadline/restore guard or exceeds the stated two-transaction budget, inspected `src/modules/intake/application/process-inbound.ts`, `src/infrastructure/postgres/postgres-atomic-processing.ts`, `src/infrastructure/postgres/postgres-ordered-head.ts`, and `src/infrastructure/postgres/postgres-fenced-conversation.ts`; normal processing and the sole recovery transaction traverse the same guarded tenant transaction. For the concrete risk of claim over-allocation or renewal lock inversion, inspected `src/infrastructure/postgres/postgres-conversation-queue.ts`; SQL limits claims and renewal owns only the work lock. For the concrete risk of widened guard privileges or ingress lock inversion, inspected `bootstrap/roles.sql`, `migrations/0002_system_state.sql`, and the state/lock declarations in migrations 0008–0011; application roles retain raw-state denial and ingress already takes the same state share lock before its mutations.

**Verification evidence:** The implementer reports final scoped 61/61 tests, clean typecheck, and clean diff-check in `iteration-20c2-report.md`; this review did not duplicate those runs. Initial expected RED failures and the corrected fixture timeout are described transparently, while the final reported run is free of warnings/unhandled errors.

