# Stage3 OpenAI probe — authorised attempt2

Date2026-10-15. Owner authorised one repair cycle and one new12-case pass≤12new calls/≤USD2, same pinned `gpt-4.1-2025-04-14`, no retries/model changes. [Attempt1 remains FAIL](stage-3-openai-probe.md); original frozen profile/results are unchanged.

Explicit scenario correction: C034 now says «Купи молоко и перенеси звонок на завтра». Oracle requires independent milk Create and a saved Update draft with tomorrow date in a needs_choice group referencing that draft, with both call targets still possible. Previous phrase without date is C101 regression: target selection alone cannot execute a move; no guessed date/empty Update. It is not silently removed or retroactively passed in attempt1.

Repair: schema enforces distinct u/a/q/g namespaces and strict reference ownership. No second AI JSON repair. Transport/stream uncertainty differs from received invalid JSON/schema/refs; invalid returns safe reason plus available usage/duration. Local replays of saved C020/C034 and targeted tests:15PASS, typecheck/architecturePASS,0external calls during repair. C020 remains invalid under the stricter schema; a manually corrected test fixture only demonstrates the contract, not model success.

[Freeze](stage-3-openai-probe-attempt-2-frozen.json) pins updated runner/oracles, model/prompt/schema/cases/manifest/registry. Current official prices retained from same-day [pricing verification](https://developers.openai.com/api/docs/pricing): standardUSD2input/USD8output per million. Conservative maximum input10603<12000, output2000; maximum aggregateUSD0.44184<USD2. Existing secrets file is read in memory, never printed/staged. Exclusive attempt2 started marker prevents restart/replay. Attempt1 marker/evidence retained.

Exactly the fixed12 cases once each, including new-input/old-choice and deadline cases absent from the first aborted pass. No JSON repair or retries, invalid outputs count as failures while other fixed cases still run once. Gate safety12/12 and exact≥11/12. Received invalid preserves usage; durations are experimental (45s deadline), not a production latency qualification. Stop before54 on failure.

## Actual outcome: FAIL — stop before54

Exactly12new OpenAI dispatches,0retries,0JSON repair,0model switches. **Safety9/12, exact9/12**; required12/12 safety and≥11/12 exact. All12remote responses completed and usage was available.

- C020 passes: u1/a1 labels, references and T1 completion correct.
- C015 fails exact evidence span/quote matching, despite correctly proposing no mutation.
- C016 fails evidence spans. Manual audit also finds tomorrow wrongly expressed as deadline instead of task targetDate, with a misleading shared_time relation to completion.
- C034 now retains both the milk Create and unresolved Update draft in needs_choice. However, destination tomorrow is wrongly expressed as deadline rather than targetDate, and spans mismatch. The scenario change is not counted as success just because an update is now present.
- Remaining9cases pass the frozen assertions, including new input/old clarification, self-correction and «к девяти» deadline.

[Complete synthetic results](stage-3-openai-probe-attempt-2-results.json) contain all12parsed decisions, counts, usage, durations, frozen hashes and original audit failures. No outputs were selected/rewritten or repaired; manual additional findings are diagnostic, not prompt tuning. Private original envelopes remain /tmp/echo-stage3-55/probe-attempt-2; attempt1 files/marker/report remain untouched.

Usage22574input/2978output tokens. Estimate at frozen standard prices **USD0.068972**, belowUSD2; combined attempt1+2 estimateUSD0.118950 for20requests. These are usage-based estimates, not billing invoices. Experimental per-request durations are not a production end-to-end SLO qualification.

Owner's repeated-failure stop condition applies. No54/55 implementation, independent reviewer, full gate, push, new experiments, real user data/audio/MAX canary or deployment. A further correction/probe requires a new explicit decision.
