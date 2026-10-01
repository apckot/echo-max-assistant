# Stage 1 progress

Current checkpoint: **iterations1–10 accepted locally; STOP for user acceptance before11**.

The coordinator adds a row only after independent review.

| Iteration | Status | Implementation commit | Review result | Evidence | Blocker/next |
| --- | --- | --- | --- | --- | --- |
| 1 | accepted | 6842b9ce9b68bb6a8d5e6c400daa2c5c905c472b | Independent review approved after npm pin and scratch tracking fixes | Node 22.23.3: `npm run typecheck && npm test && npm run build` exit 0; 1/1 tests; metadata check and repeated unit/typecheck exit 0 | Next: runtime config; architecture guard deferred to iteration 3 |
| 2 | accepted | 1631dc99ac7dee70202e356dc85a5ce239f2932b | Independent review and URL validation fix re-review approved | Node22 `npm run verify`: typecheck, 19/19 tests, build all exit 0; focused config 18/18 | Next: architecture guard |
| 3 | accepted | 14b4072abbe11518df76f7a2461b0688d0161f5e | Independent spec and quality review approved; valid TS7 paths probe rejects forbidden target | Node22 `npm run verify`: typecheck, architecture OK, 27/27 tests, build exit 0 | Next: migration runner |
| 4 | accepted | b679dee3c0189a83a95dfd6e0d080da8f94d7aa1 | Independent review and transaction-boundary fix re-review approved | Node22 functional PostgreSQL17 4/4, typecheck/guard/build exit 0; full gate 31/31 | Next: DB roles and transaction API |
| 5 | accepted | cc3d71dc2f372a1527ce4d6ab952c8a44d01b019 | Independent review and credential/rollback repair re-review approved | Clean clone at 4e7185e: npm ci + verify (40/40) + functional (13/13), typecheck/guard/build exit 0 | Checkpoint 5 accepted; user later authorized 6–10 |
| 6 | accepted | c8dacb2fc2b825e84828c5435b584fec28d57d64 | Independent spec and quality review approved, no findings | Pinned Node22 verify48/48 + functional20/20, typecheck/architecture/build exit0; RED missing system_state confirmed | Next: identity schema |
| 7 | accepted | 32f6423244eac58b7b54254bb63ed6c9f5593613 | Independent spec/quality approved, no findings | Pinned verify56/56 + functional28/28, typecheck/guard/build exit0 | Next: safe identity resolve |
| 8 | accepted | 33654ee92049f1b61ae9a055dfa8ae22ba2aa57f | Independent spec/security/quality approved, no findings | Pinned verify72/72 + functional44/44, typecheck/guard/build exit0; concurrency and signed64 boundaries | Next: runtime tenant RLS |
| 9 | accepted | 0aaa5c7ea337d54e63e42ed927efae141cef20bc | Independent spec/security approved; minor test lookup fixed and rereviewed | Final pinned verify79/79 + functional51/51, typecheck/guard/build exit0 | Next: MAX mapper checkpoint |
| 10 | accepted | 48b21711743b3ae9ef7a833952390a9e5c4d38f8 | Independent task and whole-block reviews approved, no findings | Pinned verify100/100 + functional51/51, mapper21/21, typecheck/guard/build exit0 | Checkpoint10: STOP for user acceptance |

Iteration 1 fixes: `9e4cb912d42100784c3955769e335072c3cf1691` (pin npm 11.16.0), `f9b39bd0fe3f790d974230790f428edbc1137723` (keep report local). Both independently re-reviewed. No open findings.

Iteration 2 fix: `a32afbdb4800463d39d34525d1e41c5520b5069e` (malformed URLs return sanitized ZodError). No open findings.

Iteration 4 fix: `2342eafb867f103ae558703da8ebe517ad27777a` (server-enforced transaction safety and container cleanup). No open findings.

Iteration 5 fix: `4e7185e6420da925242adbaccd35892a49da4fbe` (reject effective role override; discard failed-rollback connection; clarify statement timeout). No open blocking findings in iterations 1–5.

## Checkpoint 5 — 2026-10-01

Historical status: **accepted; stopped pending user OK**. User subsequently authorized iterations6–10 (see current block below).

The separate repository now builds strict TypeScript 7 ESM on Node 22, validates Zod configuration, checks direct architecture dependencies, runs serialized checksum migrations, and exposes role-specific system/tenant transactions with rollback and tenant-local context. No MAX webhook, task domain, AI, STT, delivery runtime, identity schema, or system_state is implemented yet.

### Independent clean-checkout evidence

Verified code commit: `4e7185e6420da925242adbaccd35892a49da4fbe` in a new local clone with no reused node_modules or generated files. Node `v22.23.3`, npm `11.16.0`, PostgreSQL `17` through owned disposable Testcontainers instances.

| Command | Actual result |
| --- | --- |
| `npm ci` | Exit 0; 236 packages installed; 0 reported vulnerabilities |
| `npm run typecheck` | Exit 0 |
| `npm run lint:architecture` | Exit 0; Architecture boundaries: OK |
| `npm test` | Exit 0; 5 files, 40/40 tests passed |
| `npm run build` | Exit 0 |
| `npm run test:functional` | Exit 0; 2 files, 13/13 tests passed |
| `git status --short` in clean clone | Empty |

`npm run verify` runs typecheck, architecture guard, npm test and build. Exact final output is preserved in [checkpoint-5-verification.log](checkpoint-5-verification.log).

Reproduce from the current local Git branch (Docker must be running):

```sh
CHECKPOINT_DIR=$(mktemp -d)
git clone --no-hardlinks --branch codex/stage-1-foundation /Users/epictetus/Documents/MW/echo-max-assistant "$CHECKPOINT_DIR/checkout"
cd "$CHECKPOINT_DIR/checkout"
npm exec --yes --package=node@22.23.3 --package=npm@11.16.0 -- sh -c 'npm ci && npm run verify && npm run test:functional'
```

[README](../../README.md) separately documents one-time DBA bootstrap and routine migrator setup. The role tests authenticate with actual separate synthetic role credentials; they do not simulate application users through superuser SET ROLE. Verified regressions include query-user role override, pooled tenant context reset, failed rollback connection disposal, embedded migration COMMIT rollback, and concurrent migration serialization.

### Risks and limits carried forward

- No blocker for this checkpoint. This is acceptance of iterations 1–5, not the whole foundation stage.
- `npm ci` warns about transitive `glob@10.5.0` deprecation and uncovered install scripts for `cpu-features`, `fsevents`, `protobufjs`, and `ssh2`. Audit reports zero vulnerabilities; all checks pass without extra script approvals. No unplanned dependency update was made.
- Gateway's 150 ms setting currently limits each SQL statement. Enforce and test the total gateway transaction deadline in iteration 15.
- Original ownership note resolved in iteration8: internal IDs now live in shared types; the DB adapter re-exports UserId for compatibility.
- DBA bootstrap is one-time for a fresh dedicated PostgreSQL cluster/database; it is not an operation to run against a shared existing cluster.
- Origin is `https://github.com/apckot/echo-max-assistant.git`; the supplied SSH URL failed public-key authentication, while HTTPS cloned the empty remote successfully. At the original checkpoint all commits were local on `codex/stage-1-foundation`; no push or production action had been performed.
- Source `echo-secretary` remains at `bffc352` with its original unrelated untracked files unchanged.

### Next five iterations as planned at checkpoint5

| Iteration | Result and evidence |
| --- | --- |
| 6 | Protected `system_state` for schema/deployment/restore fence; system-state tests |
| 7 | Identity schema: internal users, accounts, conversations, sequence counters; migration constraints tests |
| 8 | Safe concurrent MAX identity resolve function; identity-resolution tests |
| 9 | FORCE RLS isolation for two users and restricted gateway; RLS tests |
| 10 | Pure MAX mapper, four update types and stable dedupe keys; contract checkpoint |

## Pre-iteration 6 correction — local secret protection

User requested this isolated fix and explicitly authorized pushing `codex/stage-1-foundation` after independent review and verification. At that correction checkpoint, iteration6 had not started.

- `.gitignore` now contains `.env`, `.env.*`, and `!.env.example`.
- `tests/unit/gitignore.test.mjs` checks actual `git check-ignore --no-index` behavior for root/nested env files and the template exceptions, without opening or creating secret files. `git ls-files --error-unmatch .env.example` proves the template is still tracked.
- TDD: test failed on `.env` before the rules, then passed after the change.
- Coordinator verification on Node 22.23.3/npm 11.16.0: `npm run verify` exited 0 (typecheck, architecture guard, 41/41 tests in 6 files, build); `npm run test:functional` exited 0 (13/13 tests in 2 files).
- Pre-commit history scan: Gitleaks 8.30.1, default rules, no baseline or custom exclusions, `--log-opts=HEAD --ignore-gitleaks-allow --redact=100`, exit 0 and zero findings. The non-shallow history at `c15a4f5548171c495ff71130f0f57265d46d48dc` contains 15 commits; Gitleaks processed 14 addition-bearing patches (the remaining commit only deletes a scratch report).
- Scanner image: `ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`, run locally with `--network none` and a read-only repository mount. The final commit is scanned again before push; the post-commit scan and remote SHA verification are reported separately so this record does not claim an as-yet nonexistent commit hash.

## Block 6–10 authorization

The user authorized iterations 6–10 sequentially, with separate commits and independent review. Stop after iteration10 for acceptance. The earlier checkpoint stop text is historical.

Iteration6 stores protected operational metadata; migration-role only, no runtime access path yet. The coordinator maintains this ledger during the block and commits the complete checkpoint record after10.

Carry-forward integration contracts: iteration11 HTTP JSON parsing must preserve signed int64 ID tokens before mapper (Node22 reviver context.source verified); iteration13 must suppress duplicate lifecycle side effects as part of atomic intake. Neither HTTP nor intake is implemented in6–10.

Iteration9 fix: `b474f305908822521f5320f430e318d53e8c2439` replaces position-based role lookup in the schema test with a named map. Fresh implementer, independent rereview approved; no open finding.

## Checkpoint 10 — 2026-10-01

**STOP. Iteration11 and later are not started or authorized.** Iterations6–10 each have an atomic implementation commit, a fresh implementation agent, red/green evidence, independent task review, and coordinator verification. The accepted commit hashes are in the table above. Iteration9's minor role-position test finding was fixed by a fresh agent in separate commit `b474f305908822521f5320f430e318d53e8c2439` and independently re-reviewed. No open review findings or checkpoint blockers remain.

### Working result

- Protected singleton `system_state` stores schema version (currently5), restore fence, restored snapshot time and deployment epoch; application roles have no direct access.
- Internal users, MAX accounts and conversations have defaults, unique provider identities, tenant-consistent foreign keys and constrained sequence counters. Capabilities remain `{}` until a future migration admits verified flags.
- The narrow gateway-only identity resolver serializes concurrent creation, rejects cross-owner chat collisions, preserves stopped state and reactivates only for `bot_started`. Shared internal ID types keep infrastructure out of application contracts.
- FORCE RLS allows worker SELECT/UPDATE only for the current tenant. Missing/reset context exposes no rows; ownership reassignment is rejected; gateway/delivery/scheduler retain no general identity-table access.
- The pure MAX mapper supports the four agreed update types, private text, reserved audio descriptor and callback. It validates signed int64 without rounding, handles nullable original content, applies Unicode/UTF-8/payload limits and computes canonical length-prefixed SHA-256 dedupe keys. It performs no I/O or logging.

### Independent evidence

Verified code commit: `48b21711743b3ae9ef7a833952390a9e5c4d38f8`.
Its tree `a4dbb66c1be8407e0c5f043009956182e3cb984d` exactly matches both independent reviews. The checkpoint documentation commit changes only documentation and saved evidence; it does not alter this verified code.

Fresh local clone used no reused node_modules or generated build output. Node22.23.3/npm11.16.0 and PostgreSQL17 Testcontainers:

| Check | Result |
| --- | --- |
| `npm ci` | Exit0;236 packages installed; audit reports0 vulnerabilities |
| `npm run typecheck` | Exit0 |
| `npm run lint:architecture` | Exit0; Architecture boundaries: OK |
| `npm test` | Exit0;100/100 tests in11 files (includes functional tests) |
| Mapper focused tests |21/21 |
| `npm run build` | Exit0 |
| `npm run test:functional` | Exit0;51/51 tests in6 files |
| Fresh clone `git status --porcelain` | Empty |

[Full fresh-clone log](checkpoint-10-verification.log). [Independent cross-iteration review](checkpoint-10-review.md): no Critical, Important or Minor findings. The reviewer explicitly assessed this incremental block, not the whole35-iteration stage.

Reproduce after fetching the branch (Docker must be running):

```sh
CHECKPOINT_DIR=$(mktemp -d)
git clone --branch codex/stage-1-foundation https://github.com/apckot/echo-max-assistant.git "$CHECKPOINT_DIR/checkout"
cd "$CHECKPOINT_DIR/checkout"
git checkout --detach 48b21711743b3ae9ef7a833952390a9e5c4d38f8
npm exec --yes --package=node@22.23.3 --package=npm@11.16.0 -- sh -c 'npm ci && npm run verify && npm run test:functional'
```

### Limits and next-block obligations

- HTTP authentication/body handling and actual MAX webhook intake are not implemented. HTTP parsing in11 must preserve original signed int64 ID tokens before mapping; Node22 `JSON.parse` reviver `context.source` was verified to retain those tokens.
- Mapper `occurredAt` is a canonical epoch-millisecond string, not ISO. Lifecycle/message events use envelope time; callback uses click time. SQL persistence must convert deliberately. Sender/chat ownership must be enforced in the acceptance path through known-owner comparison and the resolver's collision protection.
- Atomic intake13 must coordinate dedupe, identity lifecycle changes, event/sequence and work in one transaction; a duplicate old lifecycle event must not reapply state changes. The convenience identity method alone is not the future atomic intake transaction.
- The existing150ms gateway setting is a statement timeout; total transaction deadline remains15. Narrow system-state read access belongs later readiness/restore work. Runtime queues, outbox, delivery, backup/restore, deletion, real MAX canary and production deployment are not claimed at this checkpoint. Voice retrieval/STT remain later-stage work.
- RLS assumes trusted application code supplies the authenticated internal UUID; protection against compromised credentials executing arbitrary SQL is not an additional guarantee of this design.
- Existing npm warnings remain: transitive `glob@10.5.0` deprecation and four packages with unapproved install scripts. Audit reports0 vulnerabilities; all gates pass. No dependency changes were introduced by6–10.
- This run made no changes in `echo-secretary`. Its branch advanced independently to `4d5a516709dec8ed35681cc3159411d68fc1c9e3` (local AI Privacy Gateway documentation); inspected delta concerns later AI work and does not change6–10 requirements. Existing unrelated untracked source files were preserved.

### Next five iterations — wait for user OK

| Iteration | Next result |
| --- | --- |
|11|Webhook secret, body/JSON validation and safe logging, including lossless IDs|
|12|Inbound event schema/domain model and limits|
|13|Atomic identity/event/sequence intake with duplicate suppression|
|14|Conversation work upsert and transactional wakeup|
|15|Gateway composition and durable ingress/restart checkpoint with total transaction deadline|

Publication evidence: the final documentation commit will be scanned over the full reachable branch history with pinned Gitleaks before push. The final commit SHA, scanner result, push result and independently read remote SHA are reported in the coordinator's final message; this document does not claim publication before it happens.
