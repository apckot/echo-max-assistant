# Stage 1 progress

The coordinator adds a row only after independent review.

| Iteration | Status | Implementation commit | Review result | Evidence | Blocker/next |
| --- | --- | --- | --- | --- | --- |
| 1 | accepted | 6842b9ce9b68bb6a8d5e6c400daa2c5c905c472b | Independent review approved after npm pin and scratch tracking fixes | Node 22.23.3: `npm run typecheck && npm test && npm run build` exit 0; 1/1 tests; metadata check and repeated unit/typecheck exit 0 | Next: runtime config; architecture guard deferred to iteration 3 |
| 2 | accepted | 1631dc99ac7dee70202e356dc85a5ce239f2932b | Independent review and URL validation fix re-review approved | Node22 `npm run verify`: typecheck, 19/19 tests, build all exit 0; focused config 18/18 | Next: architecture guard |
| 3 | accepted | 14b4072abbe11518df76f7a2461b0688d0161f5e | Independent spec and quality review approved; valid TS7 paths probe rejects forbidden target | Node22 `npm run verify`: typecheck, architecture OK, 27/27 tests, build exit 0 | Next: migration runner |
| 4 | accepted | b679dee3c0189a83a95dfd6e0d080da8f94d7aa1 | Independent review and transaction-boundary fix re-review approved | Node22 functional PostgreSQL17 4/4, typecheck/guard/build exit 0; full gate 31/31 | Next: DB roles and transaction API |
| 5 | accepted | cc3d71dc2f372a1527ce4d6ab952c8a44d01b019 | Independent review and credential/rollback repair re-review approved | Clean clone at 4e7185e: npm ci + verify (40/40) + functional (13/13), typecheck/guard/build exit 0 | Checkpoint 5: waiting for user OK before iteration 6 |

Iteration 1 fixes: `9e4cb912d42100784c3955769e335072c3cf1691` (pin npm 11.16.0), `f9b39bd0fe3f790d974230790f428edbc1137723` (keep report local). Both independently re-reviewed. No open findings.

Iteration 2 fix: `a32afbdb4800463d39d34525d1e41c5520b5069e` (malformed URLs return sanitized ZodError). No open findings.

Iteration 4 fix: `2342eafb867f103ae558703da8ebe517ad27777a` (server-enforced transaction safety and container cleanup). No open findings.

Iteration 5 fix: `4e7185e6420da925242adbaccd35892a49da4fbe` (reject effective role override; discard failed-rollback connection; clarify statement timeout). No open blocking findings in iterations 1–5.

## Checkpoint 5 — 2026-10-01

Status: **accepted; STOP until explicit user OK for iterations 6–10**.

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
- `UserId` is currently declared in the database adapter. Before iteration 7 introduces domain consumers, put neutral internal identity types in shared types so application/domain never import infrastructure.
- DBA bootstrap is one-time for a fresh dedicated PostgreSQL cluster/database; it is not an operation to run against a shared existing cluster.
- Origin is `https://github.com/apckot/echo-max-assistant.git`; the supplied SSH URL failed public-key authentication, while HTTPS cloned the empty remote successfully. All commits remain local on `codex/stage-1-foundation`; no push or production action was performed.
- Source `echo-secretary` remains at `bffc352` with its original unrelated untracked files unchanged.

### Next five iterations — not started

| Iteration | Result and evidence |
| --- | --- |
| 6 | Protected `system_state` for schema/deployment/restore fence; system-state tests |
| 7 | Identity schema: internal users, accounts, conversations, sequence counters; migration constraints tests |
| 8 | Safe concurrent MAX identity resolve function; identity-resolution tests |
| 9 | FORCE RLS isolation for two users and restricted gateway; RLS tests |
| 10 | Pure MAX mapper, four update types and stable dedupe keys; contract checkpoint |
