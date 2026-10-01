# Checkpoint 10 independent cross-iteration review

Date: 2026-10-01. Scope: the authorized iterations 6–10 only.

Base commit: `7fa21458269fc714581c19fc329ab27dd6442ef3`.
Reviewed candidate tree: `a4dbb66c1be8407e0c5f043009956182e3cb984d`.
Iteration 10 was staged and uncommitted during this review. This assessment attaches to that tree, not to a later documentation update or an unverified future commit.

## Review basis and evidence

Read the checkpoint brief first, then the supplied cumulative diff, all five iteration briefs, global constraints, the approved Stage 1 specification, relevant identity/intake/isolation sections of the core architecture, and the requesting-code-review reviewer template. Inspected all 15 changed source/migration/test files and the surrounding database transaction, migration runner, and role-bootstrap interfaces. Checked the supplied selected official MAX schema and iteration reports as supporting context.

Read-only comparison `git diff --cached --exit-code a4dbb66c1be8407e0c5f043009956182e3cb984d` exited 0 with no output. Comparing that tree with `migrations`, `src`, and `tests` in the working checkout also produced no difference. `git diff --cached --check` was clean. The coordinator's unstaged progress document is outside this review candidate.

The coordinator verification log records 100/100 tests in 11 files, successful build, and 51/51 functional tests in 6 files. Those are inspected existing results, not tests independently rerun by this reviewer. Per instruction, no suite or targeted runtime probe was run: static inspection and supplied evidence left no concrete unresolved runtime hypothesis requiring a probe. Fresh-clone verification remains the coordinator's subsequent step. No source, index, HEAD, or branch mutation was performed; this requested scratch report is the sole written artifact.

## Strengths

- The migration chain preserves earlier migrations, advances operational schema version, and keeps `system_state` inaccessible to application roles. Its tests use separate actual credentials and exercise fence/snapshot/epoch storage, constraints, and denial (`migrations/0002_system_state.sql:1`, `tests/functional/postgres/system-state.test.ts:44`).
- Identity relationships enforce tenant consistency in the database through the composite account/user foreign key. Provider identities are unique, sequence counters have explicit defaults and ordering constraints, and unverified capability flags cannot enter the schema (`migrations/0003_identity.sql:20`, `migrations/0003_identity.sql:32`).
- Resolution validates canonical signed int64 input before use, serializes user/chat resolution, rejects cross-owner chat collisions before creating rows, preserves stopped state for ordinary messages/callbacks, and limits reactivation to `bot_started`. Its fixed search path, fully qualified table references, migrator ownership/policies, and gateway-only EXECUTE remain compatible with FORCE RLS (`migrations/0004_resolve_max_identity.sql:17`, `:28`, `:40`, `:52`, `:71`, `:89`).
- Worker policies combine tenant filtering and ownership checks; missing or reset context sees no rows. Gateway still lacks direct identity-table access after worker grants are installed. Real-credential tests exercise each identity table, foreign reads/updates, ownership reassignment, pooled context reuse, and resolver access (`migrations/0005_identity_rls.sql:3`, `tests/functional/identity/rls-isolation.test.ts:56`).
- The adapter/application boundary is narrow: application identity contains internal branded IDs and state, with the shared ID types no longer owned by PostgreSQL infrastructure (`src/infrastructure/postgres/postgres-identity-gateway.ts:19`, `src/modules/identity/application/identity-context.ts:1`).
- The MAX mapper is independent of database/network/logging, consumes only selected DTO fields, uses callback actor identity rather than the original bot sender, handles nullable original messages/bodies, and produces stable length-prefixed UTF-8 hashes. Its numeric handling preserves full signed int64 strings and rejects unsafe already-rounded numbers. Text limits count code points and UTF-8 bytes, and all normalized branches pass the aggregate payload limit (`src/infrastructure/max/update-schema.ts:3`, `src/infrastructure/max/update-mapper.ts:25`, `:31`, `:42`, `:67`, `:94`).

## Issues

### Critical — must fix

None found in the reviewed candidate and authorized scope.

### Important — should fix

None found in the reviewed candidate and authorized scope.

### Minor — nice to have

None raised. No speculative future requirement is being presented as a defect in this incremental checkpoint.

## Recommendations

Carry the already identified integration contracts forward explicitly in the next iteration briefs:

- HTTP parsing must preserve original signed int64 identity tokens before the mapper; `occurredAt` is a canonical epoch-millisecond string requiring deliberate conversion before SQL timestamp persistence.
- Atomic intake must coordinate dedupe and the resolver's lifecycle state changes in one transaction. Calling the current convenience gateway method in a separately committed transaction before dedupe would not establish the final lifecycle idempotency guarantee.
- Keep sender/chat ownership validation in the acceptance path: the mapper filters private chat type/actor and can compare a known owner, while the resolver rejects an existing conversation owned by a different account.
- Verify the final code commit reproduces the reviewed tree and complete the planned fresh-clone gate before recording final checkpoint evidence.

These are continuation obligations, not unresolved findings against iterations 6–10.

## Declined to judge

- HTTP signature/authentication, raw body limit, lossless JSON parsing, and HTTP response behavior: no HTTP route belongs to iterations 6–10; these begin in the next block.
- Atomic duplicate intake, lifecycle replay after a later opposing lifecycle event, durable event IDs/sequences, and wakeup effects: intake persistence and its transaction boundary are iteration 13 work; current resolver tests establish identity idempotence, not event-effect idempotence.
- A total 150 ms gateway transaction deadline and end-to-end latency/load targets: the existing adapter currently installs statement/lock timeouts; the whole-transaction deadline belongs to iteration 15 and no ingress/load path exists here.
- Readiness/restore-fence access by application processes, restore drills, backup, and deployment epoch operations: this checkpoint intentionally closes direct `system_state` access; narrow operational access and orchestration are later work (26/32).
- Worker sequencing, receipts, outbox delivery certainty, stopping pending outbound, subscription recovery, deletion workflow/races, and real MAX canary: their runtime implementations are outside the authorized 6–10 block.
- Voice downloading, URL/MIME validation for retrieval, STT, and product callback operations: this checkpoint reserves a descriptor and transport callback; it performs no remote retrieval or product action.
- Isolation against a process that can execute arbitrary SQL and deliberately forge `app.user_id`: the approved RLS trust model requires the application to supply the authenticated internal UUID. The reviewed policies prove tenant isolation under that contract, not protection against compromise of the role credential itself.
- Final acceptance of the entire 35-iteration Stage 1, deployment readiness, and remote publication: this review is a local incremental checkpoint, with the authorized stop after iteration 10.

## Assessment

**Ready to merge? Yes — for the reviewed iterations 6–10 checkpoint candidate.**

The implementation matches the authorized scope, and no actionable correctness, privilege-boundary, or cross-iteration integration defect was found in the reviewed tree. This clears independent code review before the iteration 10 commit; checkpoint recording still requires the coordinator's exact-commit-tree check and planned fresh-clone verification, followed by the user's checkpoint acceptance rather than automatic continuation to iteration 11.
