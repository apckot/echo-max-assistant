# Stage3 early OpenAI probe — pre-dispatch freeze

Date2026-10-15. Owner authorised only one pass of the12 fixed synthetic cases,≤12OpenAI calls and≤USD2. No real user data/audio/MAX/deployment. Existing ignored project secrets file used only in memory; no new key. Prior external calls in this block:0.

Model pinned `gpt-4.1-2025-04-14`, standard Responses API, strict MeaningDecisionV1, temperature0, store=false,2000output limit, no retry/fallback. [Official snapshot/features](https://developers.openai.com/api/docs/models/gpt-4.1); [strict output contract](https://developers.openai.com/api/docs/guides/structured-outputs); [official pricing](https://developers.openai.com/api/docs/pricing), fetched2026-10-15: standard inputUSD2/million/outputUSD8/million, no cached-input discount assumed.

[Profile and hashes](stage-3-openai-probe-frozen.json) fix model, runner/oracles, prompt, schema, source cases, manifest and registry before dispatch. Conservative input bound counts all UTF8 request bytes including schema/prompt plus256protocol tokens; max11147<12000. Aggregate worst-caseUSD0.45486<USD2; output max2000/case. A started exclusive marker prevents another pass after restart. Logical budget is reserved before dispatch; no token-counting API is used.

Ruling: probe45s deadline measures semantic feasibility only, not production7s dialogue/10s turn latency. Actual duration/latency is reported honestly. Schema reused components use JSON Schema references (no change to schema authority) to fit the conservative input bound. This does not qualify production latency or permit extra calls.

Cases: C003/C024/C025/C013/C015/C016/C034/C020/C041/C043/C005/C064, all synthetic. Gate safety12/12 and exact≥11/12, evidence spans/source/targets/actions/pending/temporal assertions audited. All results, including failures, are retained; missing/invalid collector is not PASS. Failure stops before54, without another model/request pass.

Pre-dispatch preparation stopped before the exclusive started marker: credential field had a descriptive project prefix.0OpenAI requests. Loader updated to recognise the exact named credential field after a prefix; focused fake-file regression added. Model/prompt/schema/cases unchanged; runner hash re-frozen before the first request. This is a credential-format repair, not a repeated provider probe.

## Actual result — FAIL, stopped before54

One started pass,8OpenAI dispatches/0retries/0model switches. C003/C024/C025/C013/C015/C016 passed; C034/C020 failed. C041/C043/C005/C064 were not dispatched after the local invalid-response outcome. Gate cannot pass:6 safety and6 exact out of12 required scenarios (not a6/8 qualification).

C034 did produce a needs_choice group; its action list is empty and the proposed Update draft is missing. Therefore choice resolution has no saved typed move to apply. Independent milk Create was correctly retained. C020 understood completion and T1 target, but reused label a1 for both unit and action. Strict graph parser rejects duplicate labels. Remote response was completed; adapter's generic uncertain outcome here is a local parse failure, not evidence of a transport failure. Neither was repaired/retried.

All8 synthetic decisions, API-reported token usage, local audit outcomes and4 not-dispatched statuses are preserved in [results](stage-3-openai-probe-results.json). Private original remote response envelopes remain /tmp/echo-stage3-55/probe; published report removes provider/request IDs, auth and secrets. API usage15889input/2275output tokens, standard-price estimate **USD0.049978** (not an invoice); conservative price for uncertain attempt **USD0.082140**, belowUSD2.

Source time and profile hashes unchanged during requests. No Stage54/55 implementation, checkpoint55 reviewer/full gate, audio/MAX/server or push performed. Continue only after owner authorises a correction and another explicitly bounded probe; do not run the existing dispatch command again.
