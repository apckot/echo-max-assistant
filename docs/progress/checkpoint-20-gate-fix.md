# Checkpoint 20 default-gate repair

The user rejected checkpoint20 after default verification failed twice in an independent clean clone of `1d9da40dc89d4ba2edac09bbf7eef093517b563b`:287/293 then291/293 with varying PostgreSQL DB_TIMEOUT/503 failures. Isolated files, functional173/173 and full tests with `--maxWorkers=1` passed. These are user-supplied observations; the local repair does not claim to have independently reproduced those stochastic database failures.

## Change and behavioral evidence

`vitest.config.ts` changes only `maxWorkers: 2` to `1`. This applies to ordinary `npm test`, `npm run verify` and `npm run test:functional`; no CLI concurrency override is needed. All25 existing files and293 tests remain selected. PostgreSQL file lifetimes (container startup, tests and teardown) no longer overlap within this Vitest invocation. Explicit concurrent operations inside tests remain unchanged.

The installed Vitest4.1.11 scheduler caps active file tasks at maxWorkers. A controlled two-file lifecycle probe under pinned Node22.23.3/npm11.16.0 observed simultaneous starts with the old configuration. After the one-line change, the second file started99ms after the first ended. Temporary probe fixtures were removed from test discovery before the normal suites. This demonstrates the scheduling correction; it does not prove that every prior timeout had the same cause.

No production code,150ms deadline, assertion, fault scenario, dependency, test timeout, retry, skip or quarantine changed. The tradeoff is serial file execution (the first default suite took54.69s). Serialization cannot prevent arbitrary host starvation caused by unrelated processes.

## Reproduction and publication boundary

With Docker running, use a fresh clone of the fix commit and pinned Node/npm:

```sh
npm exec --yes --package=node@22.23.3 --package=npm@11.16.0 -- sh -c 'npm ci && npm run verify && npm run verify && npm run test:functional'
```

The two working-checkout default verify logs and independent scoped review follow. The coordinator commits this fix and evidence together, then clones that exact commit, runs npmci/default verify/functional, scans the same HEAD and full history with pinned Gitleaks8.30.1, pushes and compares independent remote SHA. These post-commit results are reported after execution rather than preclaimed here. The published SHA must equal the clean-clone SHA. Iteration21 remains prohibited until checkpoint acceptance.

## Default verify 1 — exit0

```text
v22.23.3
11.16.0

> echo-max-assistant@0.1.0 verify
> npm run typecheck && npm run lint:architecture && npm test && npm run build


> echo-max-assistant@0.1.0 typecheck
> tsc --noEmit


> echo-max-assistant@0.1.0 lint:architecture
> node scripts/check-architecture.mjs

Architecture boundaries: OK

> echo-max-assistant@0.1.0 test
> vitest run


 RUN  v4.1.11 /Users/epictetus/Documents/MW/echo-max-assistant


 Test Files  25 passed (25)
      Tests  293 passed (293)
   Start at  20:16:54
   Duration  54.69s (transform 502ms, setup 0ms, import 5.34s, tests 46.14s, environment 2ms)


> echo-max-assistant@0.1.0 build
> tsc -p tsconfig.json


```

## Default verify 2 — exit0

```text
TREE=73b2da14d5f65667d026a7c31d340f4ca1c52006
ARGV=['npm', 'exec', '--yes', '--package=node@22.23.3', '--package=npm@11.16.0', '--', 'sh', '-c', 'node --version && npm --version && npm run verify']
v22.23.3
11.16.0

> echo-max-assistant@0.1.0 verify
> npm run typecheck && npm run lint:architecture && npm test && npm run build


> echo-max-assistant@0.1.0 typecheck
> tsc --noEmit


> echo-max-assistant@0.1.0 lint:architecture
> node scripts/check-architecture.mjs

Architecture boundaries: OK

> echo-max-assistant@0.1.0 test
> vitest run


 RUN  v4.1.11 /Users/epictetus/Documents/MW/echo-max-assistant


 Test Files  25 passed (25)
      Tests  293 passed (293)
   Start at  20:19:09
   Duration  56.87s (transform 371ms, setup 0ms, import 4.64s, tests 49.27s, environment 2ms)


> echo-max-assistant@0.1.0 build
> tsc -p tsconfig.json


EXIT_CODE=0

```

## Independent scoped review

# Independent checkpoint 20 gate repair review

**Verdict: ADDRESSED.** No new breakage found in the scoped scheduling change. Reviewed base `1d9da40dc89d4ba2edac09bbf7eef093517b563b` against staged candidate tree `73b2da14d5f65667d026a7c31d340f4ca1c52006` (confirmed with `git write-tree`). The only tracked diff is `vitest.config.ts:5`, `test.maxWorkers: 2` → `1`; `git diff --cached --check` passed.

- `package.json` uses `vitest run` for `npm test`, and `npm run verify` invokes that same command. `npm run test:functional` invokes `vitest run --passWithNoTests tests/functional`. All three therefore load `vitest.config.ts` without a worker override. No script or test discovery rule changed. The repository has 25 existing test files (including two `.test.mjs` files); the first and second postchange default verify logs each report 25/25 files and 293/293 tests. The functional selection remains 14 files / 173 tests based on the prechange clean-clone log; a postchange functional run belongs to the controller's clean-clone gate.
- Installed Vitest 4.1.11's `resolveMaxWorkers` reads project/global `maxWorkers`, and its `Pool.schedule` refuses a new file task when `activeTasks.length >= maxWorkers` (`node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js:3832,3494`). The retained two-file timing probe observed overlapping lifetimes before the edit and nonoverlapping lifetimes afterward. This directly demonstrates the intended file scheduling effect. The probe tests behavior rather than reading config text; its temporary `.test.ts` copies were removed before default verification.
- A worker cap controls file tasks. It does not remove `Promise.all` concurrency inside existing tests, including transaction and race cases in `tests/functional/postgres/roles-and-transactions.test.ts`, `tests/functional/intake/queue-claim.test.ts`, and `tests/integration/http/durable-ingress.test.ts`. The diff touches no assertion, production timeout, retry, skip, quarantine, or test timeout. The gateway's 150 ms deadline remains unchanged.
- The implementer's pinned Node 22.23.3/npm 11.16.0 default verify exited zero with typecheck, architecture check, 293/293 tests, and build (`fix-checkpoint20-default-verify.log`). The controller's second pinned default verify also exited zero with the same gates and counts (`checkpoint-20-fix-verify-2.log`). I did not rerun suites or PostgreSQL probes as instructed.

**Evidence limits:** The user's two 287/293 and 291/293 failures, isolated passing files, and passing 293/293 serial run are supplied external evidence; this review did not reproduce those failures. The probe establishes file overlap as the variable changed, but cannot prove every prior `DB_TIMEOUT`/503 had that cause. Serializing this Vitest process does not eliminate interference or starvation from other host processes. Independent clean-clone verification and its functional run remain pending with the controller at the time of this review.
