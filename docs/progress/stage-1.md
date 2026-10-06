# Stage 1 progress

Current status: **iterations21–25 implemented and independently reviewed; checkpoint25 awaits user acceptance. Final exact-HEAD clean-clone, secret-scan and push evidence is supplied in the coordinator checkpoint response. Stop after25; no26+ without acceptance.**

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
| 11 | accepted | 2491d449a3d2d62ac16efdc5c91d447257f1da49 | Empty-secret issue fixed in 7278c1cdc4f70df72254e9ca5f3c6dbb2fc67d72; independent rereview PASS | Pinned verify109/109 + functional51/51; pre-BigInt guard and lossless HTTP covered | Next: inbound model |
| 12 | accepted | 8a5a186e1aba3fc20f11e05a6db3c00cb599b3d4 | Byte-limit mismatch fixed in c93129ce5a7273338beef8c954d13e35c6230498; independent rereview PASS | Pinned verify140/140 + functional75/75; DB/domain exact128KiB boundary | Next: atomic intake |
| 13 | accepted | faf9e6aa65424a3b33348b2395048c195206797a | Atomicity/ACL review passed; test concurrency fixed in 0b4cdc0b9e16b525f345af009a872057bc08971d and rereviewed | Default verify156/156 + functional91/91; production150ms unchanged | Next: conversation wake |
| 14 | accepted | a41efcf4bdd0a762852ab54d2b75c3029c1887a3 | Independent spec/quality review approved, no findings | Pinned verify160/160 + functional95/95; atomic work/NOTIFY, rollback and lease preservation | Next: durable ingress checkpoint |
| 15a | accepted substep | 3d560bf896b0a0e965b2cb2cca6fa653ef804e2c | Independent deadline/concurrency review approved; uncertain COMMIT probe passed | Pinned verify166/166 + functional101/101; total150ms and pool lifecycle | Next: 15b guarded HTTP ingress |
| 15 | accepted | 4ba92dac66c1ef66d295b172ee1f2a0a8d53fd07 | Key Unicode/NUL finding fixed in 398a63976e44cdfaa30d3e4bfca6e300daf8d1fc; fresh scoped rereview PASS | Final verify199/199 + functional102/102; guarded durable HTTP, restart/lost responses | Checkpoint15: STOP for user acceptance |
| 16 | accepted | b2160f8ff1f7fdcaa0cc3948a1dcebd8aef6d495 | Renewal lock-expiry race fixed in3b17b6e90879e5f80b9df17abc5336f66d1e9833; fresh rereview clean | Default verify207/207 +functional110/110; typecheck/guard/build pass; environmental timeout failures reproduced on checkpoint15 and resolved after other test load cleared | Next: fence stale workers |
| 17 | accepted | 3c55afe329b40b5d95d0837773f3db0e466f616e | Independent spec/quality review clean | Verify226/226 +functional129/129; token, expiry, tenant rollback and lock-order evidence | Next: conversation ordering |
| 18 | accepted | 0496cc20d9d32ae96b0e9d09f84854d71cb2a0c3 | Independent spec/quality review clean | Verify236/236 +functional139/139; ordered head, preparing, terminal advance, sleep/wake, no ABA | Next: deterministic handler |
| 19 | accepted | 36fe9c09e746982cc8548ffd68ae27cf6a0bd662 | Independent spec/quality review clean | Verify243/243 +functional139/139; pure deterministic result and privacy tests | Next:20A durable result |
| 20A | accepted substep | 22dde5058b3b0b60df4873f3625b41ed9023e339 | Independent schema/atomicity/deadline review clean | Verify264/264 +functional150/150; complete durable receipt, rollback and handler deadline | Next:20B retries/recovery |
| 20B | accepted substep | a54e450a201d58bdcc70b16bfe286bbaddeabda8 | Independent recovery/ordering review clean | Verify277/277 +functional162/162; five failures, preserved backoff, stale recovery and crash/ack-loss tests | Next:20C runtime/restart |
| 20C1 | accepted substep | 85bc6442e9b23439c49a58eaa7c683ac7d8e119a | Independent review clean; test barrier cleanup fixed in adfeaca3f762f21f222203290f296696ce26e2cf and independently rereviewed | Final fix verify284/284 +functional169/169; bounded worker operations, acquisition and COMMIT uncertainty | Next:20C2 runtime/restart |
| 20 | accepted implementation | 5caeec709a27238f9d47092327ce8367562e7d02 | Independent runtime/fence/restart review approved, no findings | Verify293/293 +functional173/173; typecheck/architecture/build pass | Checkpoint20: STOP for user acceptance |
| 21 | accepted | 8f4f507ef99b4a2b67c0954e60a677f531307295 | Shared Zod contract finding fixed in dcc2a7d2c86fcaefb4899a6863e4ebed36d02453; fresh scoped rereview approved | Default verify304/304 +functional179/179; typecheck/architecture/build; schema12→13 receipts backfill and atomic rollback | Next: MAX certainty adapter |
| 22 | accepted | 000ea8e611c83286296a7057e6d8e2a6694c840c | R1–R4 fixed in ea2982955e23d7eb100838ec7573e1bcc5be7819; HTTP-date R5 fixed in f7a0a51d1e1d74dd9004ff3943452164f50970ee; fresh scoped review PASS | Final default verify401/401 +functional179/179; typecheck/architecture/build pass; initial transient PG gate failure and passing baseline/repeat retained in checkpoint evidence | Next: durable delivery worker |
| 23A | accepted substep | 17d36aabada78614c10f5478e88a886dbd55b4c4 | Independent schema/queue spec and quality PASS; no blockers | Default verify413/413 +functional191/191; typecheck/architecture/build pass | Next: tenant delivery transitions; audited journal erasure remains29 |
| 23B1 | accepted substep | 172ca0b1f30aceb7cef9e314d786ed7127490090 | Independent scoped spec/quality PASS; no blockers | Resumed default verify427/427 +functional205/205; typecheck/architecture/build pass | DB-clock test fix 397870bba5fc1b67e3ffbb05946a4e9ebd31f8ba independently approved, verify428/428 +functional206/206; next admission/recovery |
| Gate fixture fix | accepted | 621a1c3bdc690bfa2daa1f4372cc1904b52702da | Two P2 findings closed by fresh scoped review; no new findings | Verify428/428 +functional206/206; deterministic deadline boundaries, real watchdog/cleanup, production150ms unchanged | Historical transient HTTP503 failures retained; next restore and gate23B2 |
| 23B2 | accepted substep | 7ea860889278452575f6c426e8c350f7633182cf | Independent admission/recovery spec and quality PASS; restored reviewed blobs unchanged | Default verify441/441 +functional219/219; typecheck/architecture/build pass | Next: actual completion and retry scheduling |
| 23B3 | accepted substep | 01b67ec3ed0dd075361c3e086404c5d13527a1a8 | Independent completion/fencing/time-bound review PASS; no findings | Default verify470/470 +functional248/248; typecheck/architecture/build pass | Next: sender orchestration and retry policy |
| 23 | accepted | 30a36536dc8e6b3b3852f86dcf01ef02a76bb3f4 | Independent single-send/retry-policy review PASS; no findings | Default verify495/495 +functional257/257; typecheck/architecture/build pass; all23 substeps accepted | Next: durable stop/cancellation races |
| 24 | accepted | 4e7dc0cd5d36f5330497d3b1c860581f31a7450a | Independent review PASS; no P1/P2 | verify509/509 + functional271/271, typecheck/architecture/build0; focused99/99 | Persistent logical stop cutoff; historical ambiguity fails migration; next25 |
| 25A | accepted substep | e6d0c654131931ee369679ce55bfe087c0bac5fb | Independent review PASS; no P1/P2 | verify520/520 +functional282/282; typecheck/architecture/build0 | Delivery deadline + restoreguard; initial HTTP503 failure retained; next runtime |
| 25B | accepted substep | ceda17cc4c8b5708e4dfc1836ac3ed6cee0bc770 | Independent review PASS; no P1/P2 | verify533/533 +functional286/286; typecheck/architecture/build0 | Delivery composition, bounded concurrency, restore guards and graceful drain; next end-to-end checkpoint |
| 25 | accepted implementation; checkpoint pending | 69573815129b24dd391d2246a2561f6efc2eae2c | Two test-proof P2 fixed in 07564443cd2f6b7f2e962ddb23836ac4ffd18b4a; fresh scoped review both ADDRESSED | verify541/541 +functional291/291; typecheck/architecture/build0; five real-runtime E2E cases | Whole-block review PASS; checkpoint publication evidence recorded separately; STOP before26 |

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

## Block 11–15 authorization

User accepted checkpoint 10 and authorized sequential iterations 11–15, each with a separate atomic commit, TDD, checks and independent review. Additional iteration11 requirement: bound signed-int64 string length before BigInt and test an excessively long ID. After 15: clean-clone gate, full-history Gitleaks, push and remote SHA verification; stop for user acceptance.

Historical pause on 2026-10-01: iteration 12 was preserved uncommitted. User resumed on 2026-10-03; iterations 12–15 subsequently completed. Original resume note: `.superpowers/sdd/2026-10-01-max-assistant-stage-1-foundation/PAUSED-RESUME.md`.


## Checkpoint 15 — 2026-10-03

**STOP. Iteration 16 has not started and requires user acceptance.** The user authorized 11–15 and the final clean-clone checks, history scan and push. Each iteration has a fresh implementer, TDD evidence, independent review and an atomic commit. Iteration 15 was split into 15a and 15b to keep the changes reviewable; both received full verification and independent review. The accepted implementation and fix hashes appear in the table above.

### Working result

- `createGateway(environment, logger?)` validates configuration and explicitly composes Fastify with a gateway-only PostgreSQL pool. The caller starts it with `app.listen(...)`; `app.close()` closes HTTP connections and its database resources.
- Authenticated `POST /webhooks/max` preserves numeric signed-int64 ID tokens, bounds string IDs before BigInt, enforces the configured body limit (maximum 1 MiB), and keeps secrets, payloads and external identifiers out of logs. Invalid secrets return 401; permanently invalid input returns 400.
- Supported text, callback, lifecycle and reserved voice descriptors enter the neutral intake model. Raw webhook bodies are not retained; SHA256 is stored. Tenant ownership, full-key dedupe, lifecycle transitions, event/sequence allocation and conversation wake are atomic.
- Duplicate events return 200 after commit without another event, sequence or wake. A replayed old start cannot undo a newer stop. One technical work row exists per conversation; new inbound preserves an active lease and transactional NOTIFY disappears on rollback.
- Config and database restore fences reject ingress with 503. The narrow database guard serializes the hard-limit decision, defaults to 100000 unapplied events, and measures pending events against `next_apply_sequence`. Duplicates remain valid at capacity. Gateway has no unrestricted tenant/system-state read access.
- A fixed total 150 ms gateway transaction deadline includes pool acquisition, cumulative statements, awaited callbacks and COMMIT acknowledgement. Expiry closes transaction access and discards the connection; late callback work cannot commit. A COMMIT already submitted can have an uncertain outcome: HTTP returns 503 and durable retry resolves it without duplicates.
- Real PostgreSQL and loopback HTTP tests cover process-component recreation against the same database, lost response after commit, delayed COMMIT acknowledgement, lock/deadline failure, pool recovery, idle backend termination, bounded shutdown, fence transitions, capacity concurrency, malformed IDs and privacy-safe responses/logs.

### Independent verification

Verified code commit: `398a63976e44cdfaa30d3e4bfca6e300daf8d1fc`.
Verified/reviewed tree: `9a43bb263210ec588fded073b2a9a76d6ac9f255`.
The checkpoint documentation commit changes only `docs/progress/`; it does not change verified code.

A new local clone used no reused `node_modules` or build output. Runtime: Node 22.23.3, npm 11.16.0, PostgreSQL 17 through disposable Testcontainers.

| Check | Result |
| --- | --- |
| `npm ci` | Exit 0; 284 packages installed, 285 audited, 0 reported vulnerabilities |
| `npm run typecheck` | Exit 0 |
| `npm run lint:architecture` | Exit 0; Architecture boundaries: OK |
| `npm test` (inside verify) | Exit 0; 199/199 tests in 17 files, including 27 durable HTTP/PostgreSQL cases |
| `npm run build` | Exit 0 |
| `npm run test:functional` | Exit 0; 102/102 tests in 9 files |
| Fresh clone `git status --porcelain` | Empty |

[Full clean-clone output](checkpoint-15-verification.log). [Independent whole-block review and scoped fix rereview](checkpoint-15-review.md).

Review findings were resolved in separate commits: 11 empty secret; 12 PostgreSQL JSONB byte-count mismatch; 13 test-container concurrency; 15 malformed key encoding. The final fix rejects NUL/unpaired surrogates before hashing or text binding, preserves valid U+FFFD and astral characters, and classifies SQLSTATE 22021 as a closed permanent-input error. Fresh scoped rereview reports all findings addressed, no new breakage, no out-of-scope findings.

### Reproduce

Docker must be running. The checkout below selects the exact verified code commit:

```sh
CHECKPOINT_DIR=$(mktemp -d)
git clone --branch codex/stage-1-foundation git@github.com:apckot/echo-max-assistant.git "$CHECKPOINT_DIR/checkout"
cd "$CHECKPOINT_DIR/checkout"
git checkout --detach 398a63976e44cdfaa30d3e4bfca6e300daf8d1fc
npm exec --yes --package=node@22.23.3 --package=npm@11.16.0 -- sh -c 'npm ci && npm run verify && npm run test:functional'
```

### Decisions and limits

- The full canonical provider key is preserved with a generated SHA256-backed unique index because a PostgreSQL text B-tree cannot hold every accepted long key. Intake compares the full key and owner before duplicate acknowledgement. Cost of a hypothetical digest collision: the distinct event is rejected; it is never falsely acknowledged as an existing event.
- Iteration 15 was split into deadline/pool lifecycle and guarded HTTP ingress to honor the requested change-size signal. Cost: an additional atomic implementation commit, review and verification gate. Architecture and authorized scope did not change.
- No open review blocker remains. Admission uses a serialized SQL count; target burst throughput and count cost at large retained histories remain for the planned load acceptance. No p95/p99/SLO claim is made here.
- Initial iteration 13 functional validation encountered DB_TIMEOUT during excessive parallel container startup; isolated and two-worker runs identified harness contention. `vitest.config.ts` now caps test workers at 2. Production 150 ms and test state assertions were not relaxed; all final default and clean-clone commands pass.
- Existing dependency warnings remain: transitive `glob@10.5.0` deprecation and four packages with install scripts not covered by npm allowScripts. npm audit reports 0 vulnerabilities. No unrelated dependency change or script approval was made.
- Worker processing, outbox/delivery, metrics/readiness, subscription reconciliation, restore orchestration, deletion, load tests and production MAX canary are later work. Voice is a reserved descriptor; no download, STT or AI occurs. No production credentials, webhook registration or deployment were used.
- Source `echo-secretary` remains at `4d5a516709dec8ed35681cc3159411d68fc1c9e3`; its existing unrelated untracked files were left unchanged.

### Next five iterations — wait for user OK

| Iteration | Planned result |
| --- | --- |
|16|Bounded queue claim with SKIP LOCKED, owner, lease and generation|
|17|Prevent expired workers from committing after a new generation|
|18|Preserve conversation order; preparing head waits, terminal head advances|
|19|Pure deterministic foundation handler creates typed receipts and drafts|
|20|Worker crash/retry/dead recovery and event-to-receipt checkpoint|

Publication procedure: scan the final documentation HEAD and all reachable history with pinned Gitleaks 8.30.1, without baseline or exclusions; then the authorized `git push -u origin codex/stage-1-foundation`, followed by independent `git ls-remote` comparison. Because these run after this documentation commit, the final SHA, scan result and remote SHA are recorded in the coordinator's final response and local `checkpoint-15-history-final.log` / `checkpoint-15-publication.log`. No publication result is claimed in advance here.


## Checkpoint 20 — 2026-10-03

**STOP. Iterations 21 and later have not started and require user acceptance.** Checkpoint15 was accepted and the user authorized16–20, including clean-clone checks, full-history Gitleaks and push. Each iteration/substep has its own implementation commit, tests and independent review; the two corrections have separate fix commits and fresh scoped rereviews. Commit hashes and per-step verification appear in the table above.

### Working result

- `ConversationQueue.claim` uses bounded `FOR UPDATE SKIP LOCKED` batches, internal IDs, owner UUID and increasing generation. Defaults are60s lease and20s renewal. Renewal obtains the work-row lock before checking expiry against a fresh database clock; it cannot revive a lease that expired while waiting.
- Fenced tenant processing locks conversation then work, checks owner/generation/expiry, and repeats the lease guard before committing business changes and releasing the lease. Locks remain held through COMMIT. Old workers, wrong tenants and stale recovery attempts cannot change the next worker's effects. Expiry is checked at finalization, not at a fictional exact COMMIT wall-clock instant.
- Only `next_apply_sequence` is actionable. A preparing head delays the conversation without spending retries; terminal heads advance safely. Missing allocated heads fail closed. Idle work sleeps in its existing row, retaining generation to avoid delete/recreate token reuse.
- `FoundationInboundHandler` is pure and deterministic: fixed text acknowledgement, voice capability-unavailable result, stale-button response and no lifecycle message. It makes no external call and does not copy private input text into responses.
- Processing atomically persists the complete typed result and ordered neutral drafts in an immutable tenant-protected receipt, marks the event and advances the pointer/work state. Receipt uniqueness and identity checks make restart and uncertain COMMIT recovery idempotent. There is no delivery/outbox implementation at this checkpoint.
- Only a proven pure-handler failure charges the same current event, through a fresh fenced recovery transaction after rollback. Exponential backoff with jitter survives later inbound wakeups. On the fifth failure, one terminal error result is stored and the next event is unblocked. Preparation failure terminates directly; database errors, expired leases and uncertain commits do not spend handler attempts.
- `createWorker(environment)` validates config, creates worker-only resources and starts bounded periodic scanning. It limits claims to free concurrency slots and retains a slot until processing and any outstanding renewal settle. `stop()` is idempotent, stops admission and timers, drains operations and actually closes the pool. Immediate stop suppresses the queued initial claim.
- Every production worker transaction uses the protected restore guard before other locks. The guard holds a system-state share lock through COMMIT, fails closed on a missing singleton or enabled fence, and exposes no unrestricted state-table access. Fence activation waits for already-admitted transactions; transactions admitted afterward reject.

### Verification and review

Verified code commit: `5caeec709a27238f9d47092327ce8367562e7d02`.
Verified/reviewed final implementation tree: `2cee29b0aee935a3abc2e0b66b6e97691b9784d6`.
The final checkpoint documentation commit changes only `docs/progress/`.

Final working-checkout gate: `npm run verify` passed293/293 tests in25 files, including typecheck, architecture guard and build; separate functional suite passed173/173 in14 files. Runtime: pinned Node22.23.3/npm11.16.0 and disposable PostgreSQL17 containers.

A new local clone used no reused `node_modules` or build output. `npm ci` installed284 packages and audited285 with0 reported vulnerabilities. Clean-clone verification:

| Check | Result |
| --- | --- |
| Typecheck | Exit0 |
| Architecture guard | Exit0; boundaries OK |
| Tests inside verify | 293/293 in25 files |
| Build | Exit0 |
| Separate functional suite | 173/173 in14 files |
| Clone `git status --porcelain` | Empty |

[Full clean-clone output](checkpoint-20-verification.log). [Independent reviews](checkpoint-20-review.md). The final whole-block reviewer approved16–20 with no Critical, Important or Minor findings. All nine scope/evidence exclusions received explicit controller dispositions in the review archive; none is an unresolved finding in the authorized block.

Existing dependency warnings remain: transitive `glob@10.5.0` deprecation and four packages with install scripts not covered by npm allowScripts. No dependency or script-approval changes were introduced by this block. Local secret-ignore checks pass for `.env`, `.env.local` and `.env.production`; `.env.example` remains tracked and unignored.

The iteration16 review found a renewal lock/expiry race; the separate fix locks first and tests expiry afterward. During20C2 validation, early fixture failure exposed two20C1 test barriers that could skip cleanup and leak a global pool spy. A separate one-file fix races readiness against transaction settlement, puts cleanup in `finally`, and adds two deterministic early-failure regressions. Scoped rereviews report both corrections addressed and no new breakage. The RED harness reproduction is described in the implementer report; no separate RED transcript was retained. Its focused GREEN23/23 and controller full gate284/169 are recorded.

Initial16 timeout failures under competing Docker test load reproduced on the already-accepted15 control. The unchanged candidate passed after contention cleared. The later20C1 fixture issue was diagnosed separately. No production deadline or global test timeout was increased to hide either problem.

### Reproduce

Docker must be running. A fresh checkout of the exact verified code:

```sh
CHECKPOINT_DIR=$(mktemp -d)
git clone --branch codex/stage-1-foundation git@github.com:apckot/echo-max-assistant.git "$CHECKPOINT_DIR/checkout"
cd "$CHECKPOINT_DIR/checkout"
git checkout --detach 5caeec709a27238f9d47092327ce8367562e7d02
npm exec --yes --package=node@22.23.3 --package=npm@11.16.0 -- sh -c 'npm ci && npm run verify && npm run test:functional'
git check-ignore .env .env.local .env.production
if git check-ignore .env.example; then exit 1; fi
git ls-files --error-unmatch .env.example
```

### Decisions and limits

- Ruling: persist full typed results and ordered drafts in receipts during20; actual outbox/delivery starts21. This follows the staged20 event-to-receipt/21 outbox boundary. Cost:21 must atomically materialize both preexisting receipt drafts and new results using stable event/type/ordinal dedupe, without rerunning handlers. No completed delivery guarantee is claimed here.
- Ruling: split20 into20A durable result/deadline,20B retries/recovery and20C runtime to keep changes reviewable. Cost: two additional implementation commits/reviews/full gates. Ruling: split20C again into20C1 bounded database operations and20C2 runtime because existing worker acquisition/callback/COMMIT waits could not support truthful bounded shutdown. Cost: one additional implementation commit/review/full gate. Architecture and authorized scope remain unchanged.
- Handler timeout is configurable up to5s and strictly below renewal, which is strictly below lease duration. Production worker transaction/acquisition budget T equals the renewal interval. Operation drain is bounded by2T with a responsive event loop; conservative resource-drain allowance is3T (60s at defaults), plus local teardown/scheduling. This is not a real-time OS SLA. Caller-supplied unbounded test/custom ports do not inherit production guarantees.
- Expiry invalidates transaction access and discards its connection. PostgreSQL can finish an already-running statement before detecting disconnect, bounded by the existing5s statement timeout; pool closure does not imply instantaneous backend rollback. An already-processed COMMIT can remain uncertain and is resolved through durable idempotency. Real PostgreSQL restart tests verify precommit abandonment, eventual backend cleanup, unchanged attempts and receipt identity across naturally reclaimed leases.
- Metrics/readiness26, reconciliation27, restore procedure32, process/SIGTERM packaging33, load acceptance34 and real MAX canary35 remain future work. There is no throughput/SLO claim, production deployment, webhook registration, live MAX send, voice download, STT or AI integration in this block. Source `echo-secretary` was used read-only by this work.

### Next five iterations — wait for acceptance

| Iteration | Planned result |
| --- | --- |
|21|Transactional outbox, including materialization of durable checkpoint20 drafts|
|22|MAX client certainty: sent, not_sent, uncertain|
|23|Delivery attempts; retries only for proven not_sent|
|24|Cancellation/stop and delivery fencing|
|25|Delivery runtime; signed webhook to one MAX reply checkpoint|

Publication procedure: pinned Gitleaks8.30.1 scans the final documentation HEAD and all reachable current-branch history without baseline or exclusions. Authorized push is followed by independent `git ls-remote`, clean-status and ahead/behind checks. Final scan/push/remote evidence is reported after execution; this document does not preclaim those results.


## Checkpoint 20 default-gate correction

The earlier checkpoint20 green runs did not establish a reproducible default gate. The user's independent clean clone at `1d9da40dc89d4ba2edac09bbf7eef093517b563b` failed twice (287/293 and291/293) with varying PostgreSQL `DB_TIMEOUT`/503 errors. Isolated failing files, separate functional173/173 and full tests with `--maxWorkers=1` passed. This supersedes the earlier completion claim; checkpoint20 remains pending acceptance.

The separate fix serializes test files using the normal Vitest configuration, preserving discovery, all assertions, production150ms and concurrency within each test. See [the repair evidence and independent review](checkpoint-20-gate-fix.md). Clean-clone, final-HEAD Gitleaks and push are performed after the fix commit, so their exact SHA/results are recorded in the final coordinator response and retained local logs. Iteration21 has not started.

Historical interruption on October4: closed-lid macOS sleep interrupted gates. Work resumed October5 with unchanged staged source;23B1 full verification then passed. Failed runs remain in the checkpoint evidence.

## Checkpoint 25

See [implementation, commits, validation and decisions](checkpoint-25.md) and [independent whole-block review](checkpoint-25-review.md). Final implementation SHA: `07564443cd2f6b7f2e962ddb23836ac4ffd18b4a`; default verify541/541 and separate functional291/291 passed. Both25C test-proof findings are closed in the separate fix commit. The final documentation commit is verified in a fresh clone before push; exact final SHA and publication results belong to the coordinator's checkpoint response. No iteration26 work has begun.

Checkpoint20's earlier rejection above is a historical record: scheduling fix `5e8a5b708361bc9cd622929d760b543ea002a418` was subsequently accepted by the user before this block.

Next, only after acceptance:26 component health;27 subscription/lost-notify reconciliation;28 technical retention;29 account deletion;30 operations checkpoint.

## Checkpoint30 — current protocol

User authorized26–30 with one executor/context, five numbered implementation commits, one cumulative independent review and one final checkpoint gate. Historical per-iteration agent/review/gate statements above do not govern this block. See [the checkpoint report](checkpoint-30.md).

| Iteration | Status | Implementation commit | Review result | Evidence | Blocker/next |
|---|---|---|---|---|---|
|26|accepted|a558c88aec79be407caa11627d3379ff7659eeca|Three findings ADDRESSED in a34f9ff; scoped confirmation|health1 RED→GREEN; typecheck/architecture PASS; clean-clone verify 554/554 + functional 303/303 on a3dec1e; build/typecheck/architecture PASS|live/ready/protected ops|
|27|accepted|547c47329a752ed49311f014e541de0ee48e80d3|Three findings ADDRESSED in a34f9ff; scoped confirmation|subscription/lost-NOTIFY2 + health1; typecheck/architecture PASS; clean-clone verify 554/554 + functional 303/303 on a3dec1e; build/typecheck/architecture PASS|scheduler and secret version|
|28|accepted|fdb2ce115dbba09d16837fa86db3c708d04d54a3|Three findings ADDRESSED in a34f9ff; scoped confirmation|retention1 + operations/health3; typecheck/architecture PASS; clean-clone verify 554/554 + functional 303/303 on a3dec1e; build/typecheck/architecture PASS|technical records only|
|29|accepted|01cde997f846a2ded713a2e57134c7741fdcecd2|Three findings ADDRESSED in a34f9ff; scoped confirmation|deletion2 + operations/health4; typecheck/architecture PASS; clean-clone verify 554/554 + functional 303/303 on a3dec1e; build/typecheck/architecture PASS|anonymous audited erasure|
|30|accepted|8e79c2de3012f4655180aed36c3745b6d586bb71|Three findings ADDRESSED in a34f9ff; scoped confirmation|46 targeted tests; typecheck/architecture PASS; clean-clone verify 554/554 + functional 303/303 on a3dec1e; build/typecheck/architecture PASS|STOP before31|

The authorized repeat gate and clean-clone verification passed on a3dec1e: default 554/554, functional 303/303, npm ci/typecheck/architecture/build exit 0. Gitleaks history and tracked-file scans found zero secrets; env hygiene and clean clone status passed. The user authorized documentation commit and push after success. Publication HEAD changes documentation only, is scanned before push, and is compared with the remote afterward.31–35 remain outside this authorization.

Historical gate blocker, resolved: first frozen SHA62a6565 passed553/554; the old technical-column allowlist missed incident_closed_at. Fixture repair a3dec1e passed focused4/4 and static checks. The executor stopped for approval; the user explicitly authorized one repeat, which passed in a fresh clone. See [the verification record](checkpoint-30-verification.log). No third full gate or new reviewer was launched. STOP before31.
