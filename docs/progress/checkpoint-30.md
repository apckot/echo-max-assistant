# Checkpoint30 — operations

Authorized scope: iterations26–30, one primary executor in the current chat and checkout, one commit per numbered iteration, one cumulative independent review after30, one final checkpoint gate in a fresh clone. Stop before31. The existing untracked AGENTS.md is preserved.

| Iteration | Implementation | Targeted evidence |
|---|---|---|
|26|a558c88aec79be407caa11627d3379ff7659eeca|health HTTP404 RED→GREEN1; typecheck/architecture PASS|
|27|547c47329a752ed49311f014e541de0ee48e80d3|subscription/lost-NOTIFY RED→GREEN2 + health regression1; typecheck/architecture PASS|
|28|fdb2ce115dbba09d16837fa86db3c708d04d54a3|retention schema/behavior RED→GREEN1 + operations/health regression3; typecheck/architecture PASS|
|29|01cde997f846a2ded713a2e57134c7741fdcecd2|deletion RED→GREEN2 + operations/health regression4; typecheck/architecture PASS|
|30|8e79c2de3012f4655180aed36c3745b6d586bb71|stale subscription RED→GREEN; operations/deletion/health/system-state/ingress46; typecheck/architecture PASS|

## Demonstration

Docker must be running. Use Node22.23.3/npm11.16.0:

```sh
npm exec --yes --package=node@22.23.3 --package=npm@11.16.0 -- sh -c 'npm ci && npm test -- tests/functional/operations/checkpoint.test.ts'
```

The real PostgreSQL/Fastify/scheduler scenario repairs the local fake MAX subscription, exposes missed monitor checks, preserves active content under cleanup, commits the deletion barrier, then resumes physical erasure from the durable job. Health shows cancellation and pending deletion; audit loses its target identity. Other focused tests cover lease fencing, sending uncertainty, cleanup locks/batch bounds and conflicting operation tokens.

Gateway adds live/ready and protected ops routes. Set OPS_HEALTH_TOKEN to access the aggregate using Authorization Bearer. Without an explicit token ops denies access. Scheduler requires MAX_WEBHOOK_SECRET_VERSION (a configuration version, never the secret itself). Compose using createGateway/createWorker/createDelivery/createScheduler; packaging and OS signal wiring remain iteration33.

## Decisions and limits

- Continue the existing codex/stage-1-foundation development branch; no additional executor/worktree. One8-file iteration27 includes a small scheduler timeout extension; preserve the requested coherent single commit.
- The single bot runtime owns its subscription endpoint set. Remove mismatched endpoints and POST the desired one; actual MAX subscription DTO has no activity flag. API format was checked against https://dev.max.ru/docs-api/methods/GET/subscriptions and https://dev.max.ru/docs-api/methods/POST/subscriptions.
- Operational readiness means DB/migrations/fence, with subscription degradation projected separately. Two missed5minute checks produce stale. Backup health remains unknown until iterations31–32 provide verified backup evidence.
- Preserve runnable/sending attempt journals until terminal certainty, even beyond90days. Dead queues expire strictly after30days from incident closure, not creation/failure. Cleanup never deletes inbound/receipt/outbound content; stopping a bot is not erasure.
- Actor is a closed category (operator/self_service), reason is privacy_request; completed audit retains no target identity or hash. Already admitted sends must resolve before physical erasure. New ingress after completed erasure can create a fresh identity; no external tombstone is retained. No downloaded media exists at Stage1.
- Logs30days and backups35days require deployment/provider tooling. Restore reconciliation32, packaging33, load34 and live MAX canary35 remain future work. No production DB, live MAX calls, deployment, AI/STT, billing, task domain or Mini App was touched.

Test development initially encountered missing-contract imports, then used executable no-op contract shells to observe assertion RED. Health teardown was corrected to contain the fixture idle-pool termination event. A lost-NOTIFY fixture initially precreated an inconsistent outbox draft; removing that test-only draft allowed actual processing to create its canonical outbox. No production deadlines were relaxed to pass these tests.

## Final checkpoint procedure

After the one cumulative review and any separate confirmed-fix commit, commit this report and review record before verification. Freeze that HEAD and create a fresh local clone with no reused node_modules. Run once:

```sh
npm exec --yes --package=node@22.23.3 --package=npm@11.16.0 -- sh -c 'npm ci && npm run verify && npm run test:functional'
```

This clean-clone run is the single complete checkpoint gate and also the clean-checkout verification. Run Gitleaks8.30.1 with full-history/root traversal at the same final SHA and a working-tree scan, plus env-ignore/tracked-file hygiene. Actual gate/scan results and exact final SHA are retained in the local checkpoint evidence and reported in the final response; this procedure itself is not a success claim. No second unchanged full gate, extra reviewer, push or subsequent iteration is authorized by this block.

## Cumulative review repair

The one independent review requested changes for subscription work outliving leadership, permanent not_sent retention and generation reuse after queue cleanup. The same executor fixed all three in `a34f9ff150c03cb95b0b3430c8f1814d1d821380`; see [review and repair evidence](checkpoint-30-review.md). Final schema version22. Targeted operations/runtime62 and authority/DB-role/stop-race47 pass, typecheck/architecture pass. No second cumulative audit or full gate was performed during repair.

Retired generation is internal parent-scoped operational authority; cleanup removes technical rows while preserving fencing. Parent FK privacy erasure removes the generation metadata. Bounded cleanup probes at most100 parents per queue and removes no more than the requested batch; parent locks precede work locks. Subscription reconciliation shares a20s network budget and DB cancellation signal under the30s transaction deadline; the store awaits callback settlement after authority loss. Cancelling cannot recall a remote request already consumed; the no-new-dispatch guarantee is tested against a local fake MAX service.
