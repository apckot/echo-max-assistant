# Echo MAX cost-aware development process

These project instructions refine the global cost-aware routing policy for this repository. Architecture and acceptance requirements remain binding; process overhead must stay proportional to risk.

## Checkpoint execution

- Work is authorized in sequential checkpoint blocks of five numbered iterations unless the user explicitly chooses a different scope.
- One primary executor owns the full authorized block and keeps its context across all five iterations. The executor must not spawn or delegate to other agents.
- Keep one reviewable commit per numbered iteration. Do not combine unrelated iterations, but do not create a fresh agent for each commit.
- During an iteration run only its targeted RED/GREEN tests plus the necessary typecheck and architecture guard. Do not run the full project gate after every commit.
- After the fifth iteration, use at most one independent reviewer for the cumulative checkpoint diff. Per-iteration reviewers are prohibited by default.
- Return confirmed review fixes to the same executor. A rereview is scoped to the findings and affected area; it does not restart the entire audit.
- On the final checkpoint SHA, run the full project gate, functional suite, clean-clone verification and broad scans once. Repeat a full gate only after relevant code changes, an actual failed or uncertain run, or an explicit user request.
- Publish the checkpoint evidence and stop before the next block until the user accepts it.

## Cost and stop rules

- Additional executors, reviewers, parallel agents, full gates or broader scope require explicit user approval before launch.
- Do not split work merely to obtain fresh context. Split oversized implementation inside the same executor context and preserve separate commits.
- After two focused diagnostic or repair cycles without progress, preserve the evidence and stop for user direction.
- Historical progress documents may describe the former fresh-agent-per-iteration process. They are evidence of completed work, not instructions for future iterations.

## Active plan

The stage plan is `/Users/epictetus/Documents/MW/echo-secretary/docs/superpowers/plans/2026-10-01-max-assistant-stage-1-foundation.md`. Its current checkpoint protocol governs remaining Stage 1 work. If older passages or historical reports conflict with this file, use this file and the current checkpoint protocol rather than recreating the former per-iteration agent chain.

## Accepted Stage 1 boundary

The owner accepted checkpoint 35 and completed Stage 1 on 2026-10-13 with one explicit exception: the real MAX callback scenario was not exercised because no test button existed. This is an accepted exception, not a passing callback test. Include the real callback scenario and its duplicate replay from the canary runbook in acceptance of the stage that introduces buttons. Do not close that requirement using only synthetic callback tests. The next stage requires separate owner authorization.
