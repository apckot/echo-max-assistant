# Stage2 checkpoint45 ledger

Date2026-10-14 Europe/Moscow. Status: in progress, owner accepted checkpoint40 and authorised41–45 only.
Base: df6c13f90d110f95c9a538201c186b02226a5a73; branch codex/stage-2-task-domain. One primary executor, no delegation inside iterations. No deployment, iteration46 or change to untracked network diagnostic authorised.

## Pre-flight / rulings

- Reuse existing checkout/branch and Node22.23.3. Local Docker Desktop was stopped; started solely for isolated test PostgreSQL17. Setup failure was not counted as behavioural RED.
- 41→42: TaskChanges carry actual commandIndex (not compressed event-array index), permitting no_change before a real event. Existing rows lock in UUID order; policy receives applied changes only.
- 43→44: queries share bounded session/cursor contracts; asOf is frozen across pages, distinct from transactionNow. Calendar day boundaries use a separate policy from strict meeting resolution.
- 45: additive migration0025 replaces narrow privacy functions; migration0024 is already accepted and will not be edited. Deferred current/history checks remain in place.
- Interface edits to ports/session and a shared test command helper are necessary to compose the planned behaviours; split into internal steps in the same executor/iteration commit, no extra scope or workers.

| Iteration | Commit | Targeted RED → GREEN | Static |
|---|---|---|---|
|41|c4791ad|single-create-only returns invalid_command → persistent mutations14 + concurrency1 PASS|typecheck/architecture PASS|
|42|94092f0|missing group planner/single-command rejection → unit1 + atomic groups5 PASS|typecheck/architecture PASS|
|43|11bf9bb|missing query API → queries5 PASS|typecheck/architecture PASS|
|44|ad75f78|missing history/changes API → history2 + affected queries5 PASS|typecheck/architecture PASS|
|45|c051119|missing task erasure counts → privacy3 + identity3 + retention3 + schema6 + system-state10 =25 PASS|typecheck/architecture PASS|

Checkpoint cumulative review completed: two P2 findings confirmed and repaired by the same executor; scoped confirmation pending. Full clean-clone gate/push not started. No separate functional rerun planned.

Iteration43 ruling: calendar boundary policy is implemented now because day/overdue queries already require it; iteration49 adds further temporal/roundtrip/load evidence, not a temporary wrong midnight rule. Date-only overdue uses exact boundary facts for tenant due-date/timezone pairs; public Task pages remain capped100. Cursor includes normalised filters/tenant/limit/asOf plus sort tuple; continuation asOf is independent of new transactionNow. Literal search uses strpos, so wildcard characters have no SQL semantics.

Iteration43 environment evidence: first setup hook timed out before tests; narrow Docker lifecycle and one get/list check proved recovery; then full targeted queries5PASS in2.49s. No full gate run and no source fix based on that setup timeout.

Iteration44 ruling: since is inclusive (>=) to avoid dropping events sharing one timestamp; keyset recordedAt/id disambiguates pages. asOf upper bound is frozen from first cursor. sourceOccurredAt is separate evidence, never used as history recordedAt. History includes terminal tasks and emits no synthetic events for no_change/replay/rejection.

Iteration45: migration0025 replaces existing narrow functions, adds tasks/taskEvents/taskReceipts preview counts and deletes events→receipts→tasks within the existing privacy flag/definer transaction. No checksum edits to applied migrations. Retention remains separate; anonymous audit has counts only. Schema readiness remains derived from migration checksums/count; explicit schema assertions now25.


Review repairs: UUIDs canonicalise to lowercase at the shared validation boundary, including context/evidence, targets and fingerprints. Valid JSON command envelopes now persist indexed semantic refusals (invalid title/date/empty patch), with exact replay and changed-payload conflict; malformed/non-JSON envelopes and unauthorized contexts remain receipt-free. Four behavioural regressions were RED, then atomic groups/mutations/domain unit tests49 PASS; typecheck and architecture PASS. No additional executor/reviewer or full run.
