# Stage2 checkpoint45 ledger

Date2026-10-14 Europe/Moscow. Status: **checkpoint45 verified and ready for owner acceptance; stopped before46**. Owner accepted checkpoint40 and authorised41–45 only.
Base: df6c13f90d110f95c9a538201c186b02226a5a73; branch codex/stage-2-task-domain. One primary executor, no delegation inside iterations. No deployment, iteration46 or change to untracked network diagnostic authorised.

## Pre-flight / rulings

- Reuse existing checkout/branch and Node22.23.3. Local Docker Desktop was stopped; started solely for isolated test PostgreSQL17. Setup failure was not counted as behavioural RED.
- 41→42: TaskChanges carry actual commandIndex (not compressed event-array index), permitting no_change before a real event. Existing rows lock in UUID order; policy receives applied changes only.
- 43→44: queries share bounded session/cursor contracts; asOf is frozen across pages, distinct from transactionNow. Calendar day boundaries use a separate policy from strict meeting resolution.
- 45: additive migration0025 replaces narrow privacy functions; migration0024 is already accepted and will not be edited. Deferred current/history checks remain in place.
- Interface edits to ports/session and a shared test command helper are necessary to compose the planned behaviours; split into internal steps in the same executor/iteration commit, no extra scope or workers.

| Iteration | Commit | Targeted RED → GREEN | Static |
|---|---|---|---|
|41|c4791adec3c096cc474515da4c5f9a83d71c2cba|single-create-only returns invalid_command → persistent mutations14 + concurrency1 PASS|typecheck/architecture PASS|
|42|94092f06a8652705d451410fe739df64029d29af|missing group planner/single-command rejection → unit1 + atomic groups5 PASS|typecheck/architecture PASS|
|43|11bf9bb5424d3b112c2ed32939752192020592bc|missing query API → queries5 PASS|typecheck/architecture PASS|
|44|ad75f78a314df494f11696b4881bdd05b2e3f9fa|missing history/changes API → history2 + affected queries5 PASS|typecheck/architecture PASS|
|45|c051119f1f936d6d6466b4b41b3c5973d6e59757|missing task erasure counts → privacy3 + identity3 + retention3 + schema6 + system-state10 =25 PASS|typecheck/architecture PASS|

Checkpoint cumulative review: two P2 findings repaired by the same executor and closed by the same reviewer. Full clean-clone gate PASS, functional suite included once. See [review record](stage-2-checkpoint-45-review.md).

Iteration43 ruling: calendar boundary policy is implemented now because day/overdue queries already require it; iteration49 adds further temporal/roundtrip/load evidence, not a temporary wrong midnight rule. Date-only overdue uses exact boundary facts for tenant due-date/timezone pairs; public Task pages remain capped100. Cursor includes normalised filters/tenant/limit/asOf plus sort tuple; continuation asOf is independent of new transactionNow. Literal search uses strpos, so wildcard characters have no SQL semantics.

Iteration43 environment evidence: first setup hook timed out before tests; narrow Docker lifecycle and one get/list check proved recovery; then full targeted queries5PASS in2.49s. No full gate run and no source fix based on that setup timeout.

Iteration44 ruling: since is inclusive (>=) to avoid dropping events sharing one timestamp; keyset recordedAt/id disambiguates pages. asOf upper bound is frozen from first cursor. sourceOccurredAt is separate evidence, never used as history recordedAt. History includes terminal tasks and emits no synthetic events for no_change/replay/rejection.

Iteration45: migration0025 replaces existing narrow functions, adds tasks/taskEvents/taskReceipts preview counts and deletes events→receipts→tasks within the existing privacy flag/definer transaction. No checksum edits to applied migrations. Retention remains separate; anonymous audit has counts only. Schema readiness remains derived from migration checksums/count; explicit schema assertions now25.


Review repairs: UUIDs canonicalise to lowercase at the shared validation boundary, including context/evidence, targets and fingerprints. Valid JSON command envelopes now persist indexed semantic refusals (invalid title/date/empty patch), with exact replay and changed-payload conflict; malformed/non-JSON envelopes and unauthorized contexts remain receipt-free. Four behavioural regressions were RED, then atomic groups/mutations/domain unit tests49 PASS; typecheck and architecture PASS. No additional executor/reviewer or full run.


## Checkpoint evidence

Final tested code SHA: `1fc103e65a5570a6192e78d88f117b9c3ca44f44` (review repairs). Clean clone: `/tmp/echo-max-stage2-checkpoint45.e5NuPF/repo`. Gate exit0; HEAD and tracked status unchanged after verification. Node22.23.3/npm11.16.0/PostgreSQL17; Docker image built from that SHA.

One checkpoint gate: npm ci; typecheck; architecture; build; docker build; one npm test with ECHO_SMOKE_IMAGE. 67 test files, **649 PASS /0FAIL /0SKIP**,90.07s test duration. Functional40 files/**357 PASS** extracted from the same JSON report; unit21/242, integration3/36, architecture1/8, e2e1/1, smoke1/5. No separate functional/default suite rerun. Existing foundation restore test was included; no new Task load or restore drill (deferred50).

Gitleaks8.30.1 pinned digest c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f: full reachable history102 commits and tracked archive on the tested SHA, both exit0/0leaks. Broad scan: no TODO/FIXME/TBD in src/migrations, cumulative diff whitespace clean, Task-table INSERTs remain in the sole Tasks PostgreSQL adapter. Enforced SQL ownership guard is deferred48. [Verification log](stage-2-checkpoint-45-verification.log).

The unrelated untracked network diagnostic remains untouched and excluded from every commit; original SHA256 d596baa6203db961ea83317b09ad60e1a6cf1bbd71388db3a9e3369d08963ade verified after the block. No changes to live servers.

## Result and publication

Typed Task API now persists modification/rescheduling, completion/cancellation/reopening with expectedVersion; atomic groups1–20 with local references; get/list/literal search/day/overdue and frozen-asOf keyset pages; immutable history/changes; account erasure and retention integration in schema25. Tests exercise lifecycle/date/search/history/erasure through the typed harness. No production MAX wiring or new conversational feature is claimed.

This report/evidence commit is a documentation-only descendant of the tested code SHA. Owner-authorised next action: push codex/stage-2-task-domain to origin and compare publication HEAD with git ls-remote. Actual push/SHA outcome is reported in the final handoff; not preclaimed in this pre-push commit. No gate rerun for documentation-only publication.

Stop before46. Transaction-bound inbound/outbox bridge46, real lost-COMMIT/fencing/races47, ownership enforcement48 and extended temporal/load/restore49–50 remain unimplemented. AI/STT/reminder delivery/billing/Mini App and deployment are outside this block. The accepted real MAX callback/duplicate replay exception remains open for the buttons stage.


Owner accepted checkpoint45 on2026-10-14 and authorised46–50. See [checkpoint50 evidence](stage-2-checkpoint-50.md); Stage2 acceptance remains pending final A24 evidence.
