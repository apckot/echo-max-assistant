# Checkpoint 15 review record

Final disposition: **all findings addressed; no open review findings** on verified code commit `398a63976e44cdfaa30d3e4bfca6e300daf8d1fc`, tree `9a43bb263210ec588fded073b2a9a76d6ac9f255`.

Each iteration had a fresh implementation agent and independent review. Findings in11,12,13 and15 received fresh fix agents, separate fix commits and independent rereviews. Iteration15 was split into two independently reviewed atomic steps to respect the requested scope limit.

The whole-block review below found one P2 on the initial15b candidate. The independent scoped rereview at the end confirms that the separate fix closes it. The earlier “With fixes” verdict is retained as historical evidence, not an open issue.

# Checkpoint 15 independent whole-block review

Reviewed base `68c184fa994528b3e84d01f73bf7966d15afd726` through candidate tree `68f7dad6f84a660ddd5a7f5d552e416ce8c29fba`, iterations 11–15 only. Read the review brief, whole-block diff in passes, changed production code and tests, relevant existing mapper/resolver, stage specification sections 5–9, 13, 17–18, progress rulings, and 15b implementation report. No subagents; no code, index, HEAD or branch mutations. Only this report was written.

## Strengths

- Atomic intake checks the full canonical key and ownership before acknowledging a duplicate or applying lifecycle transitions. Sequence allocation, identity changes, event insertion and durable work share one transaction (`migrations/0007_atomic_intake.sql:34–75`, `migrations/0008_conversation_work.sql:26–48`). The digest-index ruling is implemented without replacing the stored canonical key.
- The guarded entrypoint holds the system-state row lock through commit, fails closed on a missing/fenced singleton, and serializes admission. Capacity follows `sequence >= next_apply_sequence`, including terminal events still ahead of the pointer and excluding events already advanced past it (`migrations/0009_guarded_ingress.sql:23–39`). Gateway cannot directly read tenant/system-state tables or execute internal intake.
- Total gateway deadline includes pool acquisition, callback time, statements and COMMIT acknowledgement. Expiry destroys the session, invalidates later transaction queries, and leaves ambiguous commit outcomes retryable through durable deduplication (`src/infrastructure/postgres/database.ts:80–158`). Tests cover cumulative queries, suspended callbacks, delayed pool acquisition, blocked timer delivery and lost commit acknowledgement.
- Inbound RLS, immutable-envelope grants, tenant-consistent foreign keys, payload boundaries and technical-only work metadata fit the accepted contracts. Queue upsert preserves an existing lease/generation, and transactional NOTIFY is supplementary to durable rows.
- Authentication occurs before body parsing, signed-int64 lexemes survive JSON decoding, and logs contain closed codes and generated correlation IDs. Application/domain interfaces do not import Fastify, pg or MAX.

## Issues

### Critical

None found.

### Important — P2: Reject unrepresentable key strings before UTF-8 hashing or PostgreSQL text binding

Locations: `src/infrastructure/max/update-schema.ts:20,29,43`; key consumers at `src/infrastructure/max/update-mapper.ts:34,75,104`; new database error classification at `src/infrastructure/postgres/database.ts:35`.

The DTO validates message IDs and callback IDs only as nonempty strings. Authenticated JSON can therefore supply escaped NUL or an unpaired surrogate in a key-bearing field. Unlike the covered JSONB payload cases, `message.body.mid` becomes a plain PostgreSQL text parameter: NUL fails with SQLSTATE `22021`, which currently becomes HTTP 503 instead of the specified permanent-input 400. More seriously, an unpaired surrogate is silently converted to U+FFFD when the key is encoded to UTF-8. Both PostgreSQL text binding and `canonicalHash` exhibit this conversion, so two distinct incoming IDs can be acknowledged as the same durable event. This bypasses the intended full-key/collision protection because the distinct source strings have already collapsed before comparison.

Focused evidence from pinned Node 22.23.3, a disposable PostgreSQL 17 instance, all current migrations and the coordinator-built candidate:

| Authenticated input | Response | Durable result |
| --- | --- | --- |
| text `mid = "nul\\u0000"` (escape denotes actual NUL after JSON parsing) | 503 `temporarily_unavailable` | no rows; direct text binding confirms SQLSTATE 22021 |
| text `mid = "surrogate\\ud800"` | 200 | key persisted as `message:surrogate�`, sequence 1 |
| text `mid = "surrogate\\ufffd"` afterward | 200 | same sole event, sequence still 1 |
| callback `callback_id = "callback\\ud800"` | 200 | one callback event, sequence 2 |
| callback `callback_id = "callback\\ufffd"` afterward | 200 | same callback hash/event, sequence still 2 |

The probe was justified because existing tests cover NUL/surrogate inside JSONB payload, not key fields bound as text or encoded before hashing. No full suite was rerun. Two initial invocations failed at import before database setup because the probe used `dist/src` instead of `dist`; the corrected isolated probe exited 0 and cleaned up its app, pools and container.

Fix: reject NUL and ill-formed UTF-16 in the relevant external key-bearing strings before normalization/hashing/persistence, retaining valid surrogate pairs and literal U+FFFD. Cover text message ID, callback ID, callback message ID and applicable reply metadata consistently; include permanent-error normalization for SQLSTATE 22021 as a defense at the database boundary. Add focused HTTP/PG regressions proving malformed keys return closed 400 with no identity/event/work/sequence effects and cannot alias valid U+FFFD IDs. No architecture change is needed.

### Minor

None found.

## Verification evidence

Parent reports full gate on the exact reviewed candidate: verify 188/188 (including 22 durable HTTP/PostgreSQL integration tests), functional 101/101, typecheck, architecture guard and build all exit 0. Inspected `iteration-15b-coordinator-verify.log`, whose final functional run reports 101 passing and EXIT_CODE=0. Those passing tests do not cover the confirmed key-encoding cases above. Clean-clone verification and commit/push remain parent-owned and were not yet claimed.

## Declined to judge

- Worker claim/scan, processing retries, fencing-token commit and event application: iterations 16–20, explicitly outside this checkpoint; only queue lease preservation on ingress was assessed here.
- Outbox creation, delivery certainty and MAX sending: iterations 21–25; no implementation or acceptance claim at 15.
- General readiness/ops health, ignored-event metric and operational telemetry: iteration 26 and later; scoped ingress fence behavior and sensitive logging were assessed here.
- Target burst throughput, latency/backlog drain SLOs and admission-count cost at 100,000 pending events: later load acceptance; this review assesses admission correctness and bounded transaction behavior, not achieved production SLOs.
- Subscription reconciliation, backup/restore orchestration, privacy deletion, deploy/canary and full Stage 1 acceptance: explicitly later iterations 26–35; no production claim is justified by checkpoint 15.
- Voice download/STT/AI and product button semantics: later stages, not normalized transport intake.
- Arbitrary SQL with stolen runtime credentials, including manually selecting authenticated tenant context or invoking the previously accepted narrow identity resolver: outside the approved trusted-context threat model. Runtime grants and exposed intake wrappers were reviewed within that model.
- A practical SHA-256 collision experiment: infeasible and unnecessary; the accepted collision ruling was checked statically against full-key and owner comparison, which fails closed.

## Assessment

**Ready for checkpoint acceptance: With fixes.**

The block coherently implements durable, guarded, idempotent ingress and its authorized boundaries. One confirmed P2 encoding/permanent-input finding must be fixed and independently re-reviewed before checkpoint acceptance; no other actionable findings were found in this pass.


# Independent scoped rereview of the fix

**P2: Reject unrepresentable key strings before UTF-8 hashing or PostgreSQL text binding** — ADDRESSED. `src/infrastructure/max/update-schema.ts:3-5` rejects NUL and unpaired high/low surrogates, while allowing paired surrogates and literal U+FFFD. The validated schema covers message and callback-original `body.mid` (`:24`), reply `link.message.mid` (`:33`), callback ID and hash-bearing payload (`:47`) before the mapper binds the message key or hashes callback fields (`src/infrastructure/max/update-mapper.ts:67-77,94-106`). This prevents malformed source strings from collapsing into a valid replacement-character key. Real PostgreSQL HTTP regressions assert closed 400 and zero durable effects for each malformed field, then two accepted distinct events for U+FFFD and an astral pair (`tests/integration/http/durable-ingress.test.ts:110-139`). Direct database defense maps SQLSTATE 22021 to typed `DB_INVALID_INPUT` (`src/infrastructure/postgres/database.ts:35-36`), covered at `tests/functional/postgres/roles-and-transactions.test.ts:150-152`.

### New Breakage in the Fix Diff

None found. The validator preserves nonempty valid Unicode and adds no length cap; the changed SQLSTATE branch only changes 22021 from generic failure to the established invalid-input code. Focused RED/GREEN evidence in `fix-15-report.md`: 9 failures before production edits; 70/70 focused tests and typecheck passed afterward. Parent reports full gate on staged tree `9a43bb263210ec588fded073b2a9a76d6ac9f255`: verify 199/199, functional 102/102, typecheck, guard, and build passed. I did not rerun suites.

### Out-of-Scope Observations

None.

### Verdict

**Fix round:** All findings addressed, no new Critical/Important breakage.
