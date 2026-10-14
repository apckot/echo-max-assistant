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
|41|pending|single-create-only returns invalid_command → persistent mutations14 + concurrency1 PASS|typecheck/architecture PASS|
|42|not started|||
|43|not started|||
|44|not started|||
|45|not started|||

Checkpoint cumulative review/full clean-clone gate/push: not started. No separate functional rerun planned.
