# Stage3 checkpoint60 — progress ledger

Owner accepted55; authorised56–60 only. Base publication SHA b8b6f7d90e7f2dc28a54a89874bc9c54b7283bc5. Same primary executor/branch, no implementation agents. One cumulative independent review and one clean-clone gate after60. FakeHTTP/FakeAI/STT only; no external AI/STT, real user/audio/MAX or deployment. Untracked network diagnostic stays unchanged. Existing instructions/accepted plan/spec reread.

Preflight:56 short staged claim shares ordered/fenced authority with57 Tasks bound bridge;57 group receipts/continuation→58 finalizer/outbox;59 audio admission→60 transcript→same56 pipeline. Tasks remains sole domain writer. Runtime default-off. Source.kind=turn must use assistantTurnId, not provider source IDs.

## 56 — staged decision

RED missing coordinator/authority. GREEN2files/4tests: slow FakeAI holds no DB row locks; independent renewal, durable accepted replay1call; restart after started marker0redispatch; stale generation/source/account/fence cannot accept result. typecheck/architecture PASS. No full gate.

Migration29: own FORCE RLS/composite FK, immutable terminal context/decision, source/profile/context digests, bounded content linked to30day retention and account erasure counts/cascade. Claim and acceptance use short ordered/fenced transactions; provider between them. SourceMap encrypted with existing AES-GCM map owner. Per-coordinator dialogue slots≤4; local deadline bounds an adapter that ignores AbortSignal. Typed handler DB timeout unchanged.

[Local saved-response replay](stage-3-checkpoint-60-local-replay.json) traverses all12 successful probe3 answers through current grounding/validator/resolver/time preparation with0newAI calls. Eleven cases have no blocked component. **C020 is correctly understood by the saved model response but rejected locally**: «Её заверши», candidateT1 with pronoun evidence, returns TARGET_NOT_FOUND because current candidate guard requires literal Task title; it does not promote delivered reply context to candidate proof. This is a known safe false rejection, not a model failure/new AI-test PASS. Baseline assertion retains this reason explicitly. Guards and historical probe results unchanged. Full application quality remains future acceptance.

Ruling: reuse accepted existing branch/checkout and current ordered/fenced authority; add transaction-bound TurnStore.beginWith to avoid nested connection acquisition while holding head locks. No network transaction or increase in DB deadlines.

## 57 — atomic groups and trusted Tasks bridge

RED missing group executor; GREEN2files/4tests, typecheck/architecture PASS. Bound bridge takes commands only from immutable accepted_decisions, proves current head/user/run/generation/source, and uses assistantTurnId for Task source. Existing typed bridge remains compatible. Stable group effect key turn:<id>:1:<labels>; group result/Task receipt/history/effects/response intent share the same DbTx. Real PostgreSQL trigger failure on intent insert rolls all writes back. Concurrent/repeated group reads original result; injected acknowledgement loss after actual guarded COMMIT followed by a restarted runner gives one effect/receipt. C034 commits independent purchase and retains dated target choice without modifying calls. Created→complete references share one group/two domain events.

Ruling: capture full local Task snapshots alongside minimized provider candidates, then reuse public Tasks createTask/transition for deterministic command version/no-op planning before acceptance. Provider envelope still contains only bounded excerpts; full snapshots stay tenant-private and budget-bounded. No duplicated lifecycle rules, no Task SQL outside sole Tasks adapter. Migration30 immediately adds FORCE RLS/composite FKs/erasure counts and content-retention cascades. Final outbox is intentionally absent until58; durable response intent already exists atomically with any effect.

## 58 — recoverable finalizer and truthful response

RED missing finalizer; query-only/bounded renderer cases initially RED. GREEN2files/5tests, typecheck/architecture PASS. Restart after committed group consumes original receipts without AI; final outbox/processing receipt/pointer/lease/tombstone finalize atomically. Outbox insert failure leaves prior committed Task intact and finalizer recoverable, without a processing receipt claiming success. Duplicate finalizer reads saved result. Completed source replay after technical source/content removal yields0AI/0newTask/0outbox and advances its new head.

Finalizer reads real committed Task receipts, not model success claims; choice/blocked/rejected shown separately. Public bound TaskQueries supports query-only open/day/find/history/capabilities, captures result/asOf and source-local day. Up to20 shown entries; displayed list order/versions become delivered-only anchors. One canonical Delivery outbox key turn:<id>:final:v1; private response intents are not a second sender. No typing indicator is emitted without verified MAX capability. Migration31 preserves foundation/task result versions and adds assistant_turn_v1/composite turn refs.

Runtime composition is opt-in ASSISTANT_STAGE3_ENABLED=false by default; concurrency≤4 and original DB deadlines retained. Lifecycle/buttons still route to Foundation, text/voice staged route uses replaceable provider ports. Production key material is not read or copied during this block; tests inject fakes. Runtime registration does not authorise running real providers or deployment. Audio remains closed until59–60 policy/transcript integration.

## 59 — audio policy / safe download / sandbox codec

RED missing media modules; GREEN1file/5tests incl real-PG consent RLS/erasure, typecheck/architecture PASS. Denied policy does0downloads; fresh consent/authority after technical preparation; opaque audio capability excludes URL/token/IDs and does not report PII confidence. FakeHTTP validates origin/DNS pinning/private-range/redirect/stream bounds and no token forwarding. FakeCodec verifies no-network/cleared-environment sandbox command and decoded format/duration/size guards. Synthetic WAV/FLAC bytes only, no actual recording or OpenAI calls.

Ruling: decoder private tmpfs plus process-memory-only audio avoids raw audio in DB/backups/host temp and simplifies crash cleanup. Decode to counted PCMmono16kHz≤50MiB, simultaneously encode lossless FLAC≤25,000,000B for the STT file limit; strip input tags, do not clip audio. Sandbox uses Linux bwrap/ffmpeg/prlimit with no unsafe fallback; image dependencies added for the single checkpoint image build. Native sandbox execution/host user-namespace support is not claimed by fake tests and remains a release prerequisite. [Audio policy/runbook](../runbooks/stage-3-audio-policy.md).

Migration32 adds own consent/declaration metadata and media job states with immediate FORCE RLS/composite FKs/erasure counts, terminal/started no-redispatch/checksum immutability and bounded fenced expiration. No raw bytes/token columns. Audio consent presentation/UI and live permission remain later separately authorised work; no automatic opt-in.

## 60 — OpenAI STT / durable transcript / common pipeline

RED missing STT provider/jobs/voice preparation; explicit critical-component and malformed UTF8 cases RED, then GREEN. Final targeted4files/14PASS incl STT FakeHTTP, voice real-PG flows, cancellation and worker renewal; typecheck/architecture PASS. Separate narrow RED proves prior non-settling port waited its full timeout despite cancellation; current parent cancellation is immediate. No full gate/reviewer before this boundary.

STT adapter is replaceable SpeechToTextProvider, only OpenAI implementation: pinned gpt-4o-mini-transcribe-2025-12-15, official /v1/audio/transcriptions, multipart recording.flac/model/response_format=json only, no Task context/IDs/download tokens, no redirect/SDK retry. Contract checked against [official endpoint reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) and [speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text) on client date2026-10-16. Guide recommends another newer model; this profile deliberately pins the documented mini snapshot without a live model comparison/quality claim. Endpoint has no store=false field; audio processing/retention admission is a separate policy requirement, not an invented API control. Actual API/STT calls in56–60:0.

Transcript has immutable audio checksum/text digest, provider/model/profile, nullable language/confidence/critical uncertainty. Missing signal remains null; no pretend lost-negation detector. Explicit critical span is grounded through unit/action/time/target evidence and blocks only its related component (unbound critical scope refuses). Transcript goes through existing text Privacy Gateway before semantic AI. Test proves STT can have happened once while transcript is denied and semantic calls/effects remain0.

Durable STT-start reservation≤1; started without transcript =>uncertain/0redispatch. Transcript insert + media state share one fresh guarded commit; actual COMMIT/lostACK reads saved fact. Restart before semantic resumes transcript with0STT; accepted semantic decision skips both providers. Ephemeral raw/normalized buffers release after transcript/failure and on cancellation; crash cannot leave host temp audio. Metadata cleanup recovers release markers and fenced expiration; regular scheduler retention now also runs Privacy/Agent/Media owner cleanup. Accepted/failed semantic decisions delete obsolete encrypted SourceMap. Text limit16kCP and transcript32kCP remain separate; full current source is never clipped.

Migration33 adds immutable FORCE-RLS transcript facts/composite checksum FK/account counts/cascades and metadata cleanup; source transcript history remains delivered-only. Real-PG erasure test removes transcript/preparation/consent/run/decision/groups/intents/tombstone. Runtime audio policy defaults denied, requires separate explicit consent and exact allowed origins. Native codec/real audio quality, production latency and live MAX remain unverified/not authorised. No buttons or callback-canary in this block.

Ruling: two active media/STT slots and two bounded waiters under four dialogue slots; process-memory-only raw audio means a pre-STT restart may re-download safely, but cannot repeat an admitted STT. Worker renewal failure/shutdown aborts external waits; all commit paths still require fresh DB authority. No new model/network experiments or additional executor.

## Checkpoint60 pending

Iterations56–60 complete in separate commits; next is the single cumulative read-only review, confirmed fixes by this executor, then one clean-clone gate (one image build/one npm test including functional/restore/image, no separate review-focus/probe). Stop before61 after report/push/SHA equality.
