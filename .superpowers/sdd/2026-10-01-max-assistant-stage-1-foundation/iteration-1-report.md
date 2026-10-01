# Iteration 1 report

Status: DONE. Commit: `6842b9c` (`feat(foundation): scaffold repository`).

## Stack preflight

- `npm view typescript@7 version --json` returned `"7.0.2"`.
- `npm exec --yes --package=node@22 -- node --version` returned `v22.23.3`.
- `npm exec --yes --package=node@22 -- ./node_modules/.bin/tsc --version` returned `Version 7.0.2`.

## TDD evidence

The test was authored before package metadata, TypeScript configuration, or source. It was initially at `test/scaffold.test.mjs`; after RED it was moved to `tests/unit/scaffold.test.mjs` to match the plan's directory convention. It exercises the real `npm run build` script and imports the generated ESM entrypoint.

RED command (exit 1):

```text
$ npm exec --yes --package=node@22 -- ./node_modules/.bin/vitest run test/scaffold.test.mjs
 RUN  v4.1.11 /Users/epictetus/Documents/MW/echo-max-assistant
 ❯ test/scaffold.test.mjs (1 test | 1 failed) 85ms
   × the package builds an importable ESM entrypoint 84ms
 FAIL  test/scaffold.test.mjs > the package builds an importable ESM entrypoint
AssertionError: npm error code ENOENT
npm error syscall open
npm error path /Users/epictetus/Documents/MW/echo-max-assistant/package.json
npm error errno -2
npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/Users/epictetus/Documents/MW/echo-max-assistant/package.json'
: expected 254 to be +0 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

GREEN focused command (exit 0):

```text
$ npm exec --yes --package=node@22 -- npm run test:unit
> echo-max-assistant@0.1.0 test:unit
> vitest run tests/unit
 RUN  v4.1.11 /Users/epictetus/Documents/MW/echo-max-assistant
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

## Iteration gate under Node 22

All commands exited 0:

```text
$ npm exec --yes --package=node@22 -- npm run typecheck
> echo-max-assistant@0.1.0 typecheck
> tsc --noEmit

$ npm exec --yes --package=node@22 -- npm test
> echo-max-assistant@0.1.0 test
> vitest run
 RUN  v4.1.11 /Users/epictetus/Documents/MW/echo-max-assistant
 Test Files  1 passed (1)
      Tests  1 passed (1)

$ npm exec --yes --package=node@22 -- npm run build
> echo-max-assistant@0.1.0 build
> tsc -p tsconfig.json
```

`lint:architecture` is wired to the future `scripts/check-architecture.mjs`. The implementation belongs to iteration 3, so this command is currently unavailable and is omitted from `verify`; it has not been represented as a passing guard.

## Files and self-review

- Added `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `src/index.ts`, `tests/unit/scaffold.test.mjs`, and `docs/progress/stage-1.md`.
- Seven files including the generated lockfile; six substantive files. No runtime, config loader, ports, domain, database, or source repository changes.
- `docs/progress/stage-1.md` contains only the required empty ledger table; the coordinator owns accepted rows.
- Smoke test catches absent/broken build script, missing emitted entrypoint, and invalid ESM output. Strict compiler flags are explicit in `tsconfig.json` and `typecheck` runs successfully; a future nontrivial source will exercise those flags more deeply.
- No known blocker. The architecture guard remains intentionally pending iteration 3. Functional tests have no cases yet; `test:functional` reports success with no tests.

## Review fix: pin package manager

Added the exact package manager version used for the Node 22 disposable validation: `npm@11.16.0`.

Runtime discovery (exit 0):

```text
$ node --version && npm --version && npm exec --yes --package=node@22 -- node --version
v24.18.0
11.16.0
v22.23.3
```

TDD metadata assertion before the edit (exit 1):

```text
$ node --input-type=module -e 'import assert from "node:assert/strict"; import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json","utf8")); assert.equal(p.packageManager,"npm@11.16.0", "packageManager must pin the npm version used under disposable Node 22");'
AssertionError [ERR_ASSERTION]: packageManager must pin the npm version used under disposable Node 22
+ actual - expected
+ undefined
- 'npm@11.16.0'
```

Focused checks after the edit, all under disposable Node 22 (all exit 0):

```text
$ npm exec --yes --package=node@22 -- node --input-type=module -e 'import assert from "node:assert/strict"; import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package.json","utf8")); assert.equal(p.packageManager,"npm@11.16.0", "packageManager must pin the npm version used under disposable Node 22"); console.log(`packageManager=${p.packageManager}`);'
packageManager=npm@11.16.0

$ npm exec --yes --package=node@22 -- npm run test:unit
> echo-max-assistant@0.1.0 test:unit
> vitest run tests/unit
 RUN  v4.1.11 /Users/epictetus/Documents/MW/echo-max-assistant
 Test Files  1 passed (1)
      Tests  1 passed (1)

$ npm exec --yes --package=node@22 -- npm run typecheck
> echo-max-assistant@0.1.0 typecheck
> tsc --noEmit
```

Review-fix changes: pinned `packageManager` in `package.json` and appended this evidence to the iteration report. The architecture guard is still unavailable until iteration 3, as recorded above.
