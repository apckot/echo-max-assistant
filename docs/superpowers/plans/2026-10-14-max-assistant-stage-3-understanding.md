# Echo MAX Stage3 — план реализации 51–70

> **Исполнение:** superpowers:executing-plans. Один исполнитель на разрешённый блок из пяти итераций, без делегирования реализации. Отдельный коммит на итерацию; одно накопительное независимое ревью на checkpoint. Базовые документы приняты; попытки1/2 probe53 сохранены FAIL, разрешённая попытка3 PASS12/12. Checkpoint55 принят. Владелец разрешил56–60; они реализованы, checkpoint60: одно review, один общий прогон и точечное закрытие упавших fixture-проверок зафиксированы в progress ledger. Блок61+ не разрешён.

**Цель:** понимание текста и голоса через OpenAI, управление Tasks через MAX, сохранение смысла и контекста, Privacy Gateway и восстановление без повторного эффекта.
**Архитектура:** Context/Privacy → один внешний MeaningDraftV2 → QuoteGrounder → внутренний MeaningDecisionV1 → validator/resolver → durable groups → публичный Tasks API → response intent/final outbox. OpenAI semantic/STT — заменяемые adapters; сеть вне DB locks.
**Стек:** существующие TypeScript ESM/Node22/PG17/Zod4/Vitest; provider API/codec версии закрепляются при реализации.
**Спецификация:** [Stage3](../specs/2026-10-14-max-assistant-stage-3-understanding-design.md).
**Корпус:** [регрессионные диалоги, ранний probe и контроль](../corpora/2026-10-14-max-assistant-stage-3-dialogues.md).
**Baseline:** принятый Stage2 `66014298a4e511a1aa10a1df0242deda06ecc48e`, migration head26. Проект для принятия, уточнённый2026-10-14.

## Ограничения и порядок проверок

- Реализуются только OpenAI semantic и OpenAI STT. YandexGPT/GigaChat/local semantic/local ASR/model privacy classifiers — будущие adapters, без установки, реализации и qualification в Stage3; не блокируют запуск.
- Tasks единолично владеет правилами, SQL, версиями и receipts. Semantic/Agent не становятся вторым владельцем Task state. Foundation и task_commands_v1 остаются совместимыми.
- Обычная успешная команда≤1 semantic invocation; голос дополнительно≤1 STT dispatch. Auto retries/repair/style/resolver AI отсутствуют. Started/uncertain provider attempt не отправляется снова автоматически.
- Source time/timezone immutable. «К девяти» — deadline.at09:00, «в девять» — scheduledAt09:00; без дня — source local date, без переноса прошедшего срока. Stage2 strict meeting DST и calendar-day/cursor asOf политики сохраняются.
- Максимум20 units/actions,10 groups,20 commands/group. Context: text16000CP/64KiB, transcript32000CP, history12pairs/48h, candidates50, description512CP; auxiliary6000tokens/full provider24000tokens. Exact anchors/current source не обрезаются; budget overflow — отказ.
- Privacy локальная детерминированная: минимизация/allowlist/известные значения/шаблоны/метки/denied. Нет гарантии обнаружения всех PII. Технические IDs/секреты/mapping исключаются; отказ запрещает downstream dispatch/Task effect; audio denied до STT означает0STT, transcript denied после STT не отменяет предыдущую передачу записи. Политика, требующая полного локального анализа, не исполняется внешним route.
- Аудио: внешний STT получает сам файл. Нужны отдельное audio разрешение, разрешённый profile и декларация допустимого содержания; техническая проверка не подтверждает отсутствие третьих голосов/PII. Limits25MiB/20min, decoded50MiB, sandbox codec, SSRF checks. Ранний probe не включает аудио.
- Maps30min/hard2h, raw audio≤30min, choices24h, finalized content30days, dedup tombstone до account erasure. Каждая content migration сразу подключает own RLS/erase/counts/retention, не ждёт checkpoint.
- Dialogue7s/STT18s, download10s/codec5s; standard text10s/voice30s afterdownload, long voice90s отдельный profile; slots4semantic/2STT perworker.
- Migrations0027–0036 additive; если номер занят к preflight, последовательно перенумеровать новые файлы и зафиксировать ruling. Applied checksums не менять.
- Реальный callback-canary и его повтор обязательны при первом кнопочном checkpoint65. Без разрешённого TEST bot/endpoint/получателя — partial checkpoint и остановка, exception остаётся открытым.
- Reminders/Daily View/billing/MiniApp/calendar/deployment/Stage4 вне объёма. Посторонний untracked network diagnostic не изменять и не коммитить.

В каждой итерации: целевой RED → минимальная реализация → GREEN плюс `npm run typecheck` и `npm run lint:architecture`; если тест нового доказательства сразу GREEN — честно зафиксировать это, не выдумывать RED. Файлы ниже — responsibility map; basename в brace/после запятой наследует указанный каталог. Большой файл разделять внутри того же исполнителя и итерации; это не разрешение дополнительного агента.

Checkpoint55/60/65/70: один reviewer накопительного diff блока; исправления возвращаются тому же исполнителю, closure только по finding. На окончательном code SHA — **один полный gate в чистом клоне**: install, typecheck, architecture, build, один image build и один `npm test`, включающий functional/e2e/image smoke; broad scans один раз. Не запускать отдельно functional/review-focus либо повторять уже входящий restore набор. Progress/report/push/local=remote SHA после успешных обязательных проверок; остановка до принятия следующего блока. Docs-only публикация не повторяет code gate. Дополнительные агенты, полные прогоны или внешние эксперименты требуют согласования.

Ранний probe53 — отдельное уже разрешённое синтетическое исследование, не полный gate. Финальные real-text/audio/canary — отдельные заранее ограниченные проверки, не default tests. После двух целевых ремонтов без прогресса сохранять evidence и остановиться; бюджет API не пополняется автоматически.

## Владельцы файлов и review focus

|Граница|Файлы/владелец|
|---|---|
|Meaning/validation/time/resolution|src/modules/semantic/domain/meaning-decision.ts; src/modules/semantic/application/{provider-port.ts,quote-grounding.ts,temporal-intent.ts,decision-validator.ts,temporal-normalizer.ts,target-resolver.ts}|
|Context|src/modules/context/application/{context-pack.ts,context-builder.ts,context-port.ts}; src/infrastructure/postgres/context/context-reader.ts|
|Privacy|src/modules/privacy/application/{privacy-gateway.ts,source-map.ts}; src/infrastructure/postgres/privacy/token-map.ts|
|OpenAI transport|src/infrastructure/ai/{openai-decision-provider.ts,provider-config.ts}; src/infrastructure/media/openai-stt-provider.ts|
|Media|src/modules/media/application/{audio-policy.ts,media-service.ts,stt-port.ts,transcript.ts}; src/infrastructure/media/{max-audio-loader.ts,sandbox-codec.ts}; src/infrastructure/postgres/media/*.ts|
|Agent|src/modules/agent/application/{turn-coordinator.ts,group-runner.ts,turn-finalizer.ts,choice-executor.ts,response-renderer.ts}; src/infrastructure/postgres/agent/*.ts|
|Единственный Tasks bridge|src/infrastructure/postgres/postgres-typed-task-processing.ts; src/infrastructure/postgres/tasks/task-session.ts|
|MAX/runtime|src/modules/delivery/domain/outbound-message.ts; src/infrastructure/max/{update-mapper.ts,max-client.ts}; src/runtime/worker.ts; src/shared/config/config.ts|
|Eval без default network|tests/semantic/{stage3-probe.ts,corpus-runner.ts,oracle.ts,qualification-report.ts}; tests/fixtures/stage3/*.json|

Review focus: (1) отрицание в цитируемом title против отрицания owner command —55/67; (2) минимизация теряет цель/день/полярность —52/55; (3) SQL порядок меняется после показанного списка или Task вне candidate pack —54/55; (4) group committed, finalizer/provider ACK потерян —56–58/63; (5) старые choices, разные callback IDs, edit/erase/restore races —61–63/69.

## Блок51–55 — контракт и ранний OpenAI probe

### 51. Meaning contract и замороженные сценарии
**Файлы:** src/modules/semantic/domain/meaning-decision.ts, src/modules/semantic/application/provider-port.ts; tests/unit/semantic/meaning-contract.test.ts; tests/fixtures/stage3/{regressions.json,probe-manifest.json}; docs/runbooks/stage-3-provider-admission.md.
**Результат:** strict внешний MeaningDraftV2 (sourceLabel+quote) и внутренний MeaningDecisionV1 (диапазоны только приложения), ProviderContext/ProviderResult и registry, C001–C101 regression oracle. Контроль H001–H020 отдельно, frozen hash до настройки, без доступа prompt tuning; независимый источник/владелец и приватный oracle фиксируются в manifest, не выдаются за готовые фактические данные.
- [x] RED S01/S20: unknown keys/refs, quote-only wire/unique literal grounding/code-point spans внутри,21 actions, negative/quoted units, local labels и relation scope.
- [x] Материализовать12 probe cases из корпуса; зафиксировать source/anchors/pending context, exact oracles, версии/hash и лимиты12 calls/USD2/12000input/2000output. Контроль не используется для разработки; отсутствие H отмечается как незавершённая независимая приёмка.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/unit/semantic/meaning-contract.test.ts`; static; commit `feat(semantic): define meaning contract and regression oracles`.

### 52. Privacy boundary и заменяемый OpenAI adapter
**Файлы:** src/modules/privacy/application/{privacy-gateway.ts,source-map.ts}; src/infrastructure/ai/{openai-decision-provider.ts,provider-config.ts}; migrations/0027_privacy_routes.sql; tests/unit/ai/openai-contract.test.ts; tests/functional/privacy/token-map.test.ts.
**Результат:** `prepare(pack): PrivacyResult` и `decide(ProviderContext,...): ProviderResult`; external_allowed/tokenized/denied; будущий provider подключается портом, без его реализации.
- [x] RED S09/S10/S14: fake HTTP strict output/error/usage/deadline, retriesoff,0network on denied, IDs/secret/context exclusion, unknown/cross-run token, сохранение scope и SourceMap. Проверять payload текущего input и candidates, а не только один текст.
- [x] Реализовать allowlist/templates/known-value masking, encrypted mapping/RLS/erase. Перед настоящим API на53 проверить актуальные официальные schema/model/pricing/processing настройки, секрет читать напрямую из существующего файла в памяти; tests используют FakeHTTP, ключ не нужен.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/unit/ai/openai-contract.test.ts tests/functional/privacy/token-map.test.ts`; static; commit `feat(ai): gate OpenAI requests through privacy boundary`.

### 53. Небольшая настоящая проверка OpenAI до конвейера
**Файлы:** tests/semantic/stage3-probe.ts; tests/unit/semantic/probe-budget.test.ts; docs/progress/stage-3-openai-probe.md.
**Результат:** наблюдаемое понимание12 синтетических cases до основной интеграции; не production и не STT proof.
- [x] RED budget proof: reject call13, token overflow/cost>USD2, retries/real input/audio/control sample; collector audit обязателен, missing output не PASS. Credential loader выводит только readiness и не сериализует Authorization даже при ошибке.
- [x] Перед запуском записать frozen manifest/profile/current unit prices, worst-case12-call estimate≤USD2 и monetary stop counter. Использовать существующий ключ из файла секретов проекта; не создавать новый, не печатать значения или полное env, не копировать ключ в repo/argv. Если файла нет/ключ недоступен или профиль недопустим — reported blocker, не provisioning нового ключа.
- [x] После принятия документов выполнить **один** проход C003/C024/C025/C013/C015/C016/C034/C020/C041/C043/C005/C064:≤12 dispatches,≤USD2, только синтетические pack. Вызов STT/реальный MAX/пользовательские данные запрещены. SDK retryoff; после uncertainty не повторять call.
- [x] Gate:100% safety assertions,≥11/12 full oracle; один semantic request/case. Публиковать все counts/failures/latency/usage/cost без ключа. При fail остановиться до54; дополнительный probe/настройка с внешними вызовами требует согласования, автоматический подбор модели не разрешён.
- [x] GREEN budget test `node node_modules/vitest/vitest.mjs run tests/unit/semantic/probe-budget.test.ts`; static; commit `test(ai): record bounded synthetic OpenAI feasibility probe`.

### 54. Source snapshot, delivered context и dedup tombstone
**Файлы:** src/modules/context/application/{context-pack.ts,context-builder.ts}; src/infrastructure/postgres/context/context-reader.ts; src/infrastructure/postgres/agent/turn-store.ts; migrations/0028_stage3_turns.sql; tests/functional/context/context-pack.test.ts.
**Результат:** immutable source/timezone/context/turn source binding; delivered-only exact reply/list anchors, bounded candidates, tombstone до provider call.
- [x] RED S04/S07/S19: C021/C028/C086/C099, missing/foreign reply, history48h, auxiliary budget, full current source, dedup после technical retention, erasure/RLS/key rotation.
- [x] Построить через public TaskQueries:3prequeries,50candidates incl terminal, description512CP; не использовать недоставленный ответ/пересортированный SQL список. Tombstone HMAC source key без текста; unlink source FK не удаляет dedup.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/context/context-pack.test.ts`; static; commit `feat(context): preserve source and delivered task anchors`.

### 55. Единственный validator, resolver и source-time semantics
**Файлы:** src/modules/semantic/application/{decision-validator.ts,target-resolver.ts,temporal-normalizer.ts}; tests/functional/semantic/{action-boundary.test.ts,task-resolver.test.ts,temporal-intent.test.ts}.
**Результат:** ValidatedDecision/resolved targets/time DTO для будущего runner, без Task writes или второго AI.
- [x] RED S01–S06: C003/C018/C024/C025/C028/C036–C040/C061–C070/C097–C098; «к девяти» deadline, «в девять» schedule, «перенеси на завтра» targetDate; никакой автозамены ошибочного deadline; C016/C034 exact changed/unchanged fields, own temporal scope и independent groups; reply/list target authorization, copy-completion, no mutation→Create.
- [x] QuoteGrounder принимает только sourceLabel/quote: unique exact match и SourceMap,0/2+matches closed refusal, без fuzzy/первого совпадения; validator принимает grounded evidence/graph/ownership; resolver0/1/2–5/>5 и≤3postqueries; связанные actions объединяются; Stage2 time port разрешает gap/fold/day отдельно, source clock не retry clock. Разрешать неопределённость только в связанном компоненте, structural bad frame целиком reject.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/semantic/action-boundary.test.ts tests/functional/semantic/task-resolver.test.ts tests/functional/semantic/temporal-intent.test.ts`; static; commit `feat(semantic): validate intent targets and source-time scopes`.
- [x] Checkpoint55: одно review/gate, отчёт с отдельным probe53 evidence, push/SHA, остановка перед56. Никакого повторного probe в gate.

## Блок56–60 — durable текстовый конвейер и OpenAI STT

### 56. Claim, внешний вызов вне DB locks и staged decision
**Файлы:** src/modules/agent/application/turn-coordinator.ts; src/infrastructure/postgres/agent/{turn-claim.ts,decision-stage.ts}; migrations/0029_turn_authority.sql; tests/functional/agent/staging-authority.test.ts.
**Результат:** `stage/run(turnId)` с short guarded claim, независимым renewal, accepted immutable decision до effects.
- [x] RED S14/S15: long FakeAI не держит row locks; stale generation/user/fence/source discard, started uncertain0redispatch, head ordering, duplicate turn reuses accepted decision.
- [x] Внедрить phases claim→Context/Privacy/provider вне transaction→fresh authority stage; slots4/worker; run/profile digests immutable. Не увеличивать typed-handler DB timeout ради AI.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/agent/staging-authority.test.ts`; static; commit `feat(agent): stage meaning outside database locks`.

### 57. Trusted Tasks bridge и атомарные группы
**Файлы:** src/infrastructure/postgres/postgres-typed-task-processing.ts, src/infrastructure/postgres/tasks/task-session.ts; src/modules/agent/application/group-runner.ts; migrations/0030_turn_groups.sql; tests/functional/agent/{task-binding.test.ts,mixed-groups.test.ts}.
**Результат:** `runGroup` вызывает только bound public Task commands, stable effect keys; command effects/events/receipt/group result/response intent в одной guarded DbTx.
- [x] RED S03/S05/S16: trusted assistantTurn source принадлежит locked inbound/user; provider source IDs запрещены; C032–C039,20commands, independent partial success; rollback на любом insert failure.
- [x] Сохранять accepted intents неизменно, dependent actions atomic. Tasks не читает Agent tables; только sole infrastructure binding доказывает authority. Repeated/lostACK group возвращает original receipt.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/agent/task-binding.test.ts tests/functional/agent/mixed-groups.test.ts`; static; commit `feat(agent): execute atomic task groups with durable response intent`.

### 58. Finalizer и правдивый MAX text response
**Файлы:** src/modules/agent/application/{turn-finalizer.ts,response-renderer.ts}; src/infrastructure/postgres/agent/response-intent.ts; src/runtime/worker.ts; src/shared/config/config.ts; migrations/0031_assistant_processing_result.sql; tests/e2e/stage3-text-flow.test.ts.
**Результат:** один final outbox из committed group outcomes, assistant_turn_v1 совместим с foundation/task_commands_v1.
- [x] RED S17/S24: C080, crash между группой и finalizer, false success, query-only/source-local day/asOf, partial mixed response, processing indicator only if verified MAX capability.
- [x] Finalizer under lock читает receipts/statuses, one final effect key+processing receipt/outbox/pointer. Response intents private finalizer queue, не второй sender. Runtime flags defaultoff; no extra styling AI.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/e2e/stage3-text-flow.test.ts`; static; commit `feat(max): deliver truthful staged task responses`.

### 59. Audio policy, безопасная загрузка и codec
**Файлы:** src/modules/media/application/{audio-policy.ts,media-service.ts}; src/infrastructure/media/{max-audio-loader.ts,sandbox-codec.ts}; migrations/0032_media_preparation.sql; tests/functional/media/audio-boundary.test.ts.
**Результат:** VerifiedAudio→ApprovedAudio либо denied; без локального ASR/модели, с явным disclosure передачи записи внешнему STT.
- [x] RED S11/S12: C078, нет/отозвано audio consent, declared prohibited content, policy requiring content analysis, SSRF/privateDNS/redirect/oversize/badcodec, account stop/erase/fence.
- [x] Технические checks и policy защищают маршрут, не гарантируют PII detection. Декларацию записывать отдельно от результата проверок. Private temporary bytes/cleanup≤30min, token никогда не пересылается чужому origin.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/media/audio-boundary.test.ts`; static; commit `feat(media): admit external audio through explicit privacy policy`.

### 60. OpenAI STT, durable transcript и единый voice pipeline
**Файлы:** src/modules/media/application/{stt-port.ts,transcript.ts}; src/infrastructure/media/openai-stt-provider.ts; src/infrastructure/postgres/media/{media-jobs.ts,transcript-store.ts,cleanup.ts}; migrations/0033_media_transcripts.sql; tests/unit/media/stt-contract.test.ts; tests/e2e/stage3-voice-flow.test.ts.
**Результат:** заменяемый STT port, только OpenAI implementation; transcript reuse→тот же Context/Privacy/Semantic/Tasks.
- [x] RED S13/S14: C042/C079, nullable confidence, критическое ambiguity блокирует компонент, no mandatory repeated voice, no secondSTT after commit; external sent/ACK uncertainty без retry, cleanup crash recovery.
- [x] FakeHTTP проверяет реальный STT request contract без аудио/ключа/сети. Audio bytes удаляются после transcript commit; transcript перед semantic вызовом проходит text Gateway. Не придумывать confidence/детектор потерянного отрицания при отсутствующем signal.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/unit/media/stt-contract.test.ts tests/e2e/stage3-voice-flow.test.ts`; static; commit `feat(media): reuse OpenAI transcripts in the common task pipeline`.
- [x] Checkpoint60: одно review/gate, push/SHA, остановка перед61. Реальный audio eval ещё не разрешён.

## Блок61–65 — необходимые кнопки и callback-canary

### 61. Pending choice как конечный компонент
**Файлы:** src/modules/agent/application/choice-executor.ts; src/infrastructure/postgres/agent/pending-choice.ts; migrations/0034_pending_choices.sql; tests/functional/agent/pending-choice.test.ts.
**Результат:** сохранённые typed options,2–5+cancel, token256bit/hash-only, revision/TTL24h; новое сообщение — новый turn.
- [x] RED S08/S18: C041–C051/C100, unbound«да/второй», exact reply new intent supersedes aftercommit; sameoption new callbackId replay, foreign token/versionconflict/expired0effect.
- [x] Callback consume+Tasks+receipt+group result+response intent/outbox атомарны. Обычные clear commands без кнопок. Не реализовывать глобальный pending capture.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/agent/pending-choice.test.ts`; static; commit `feat(agent): resolve finite choices without capturing new input`.

### 62. Versioned MAX buttons и callback binding
**Файлы:** src/modules/delivery/domain/outbound-message.ts; src/infrastructure/max/{update-mapper.ts,max-client.ts}; migrations/0035_choice_delivery_contract.sql; tests/functional/max/choice-delivery.test.ts; docs/runbooks/stage-3-canary.md.
**Результат:** messageId/user/conversation/revision binding и rich drafts; внутренние defaultoff кнопки готовы к real canary checkpoint65.
- [x] RED S18/S23: button encoding, callbacks exact message source, noID/token content leaks, confirmed/uncertain delivery, duplicate callback IDs and stale options.
- [x] Проверить актуальный официальный MAX contract при реализации; plain draft остаётся совместимым. Callback идёт без AI, произвольный внешний command payload запрещён. Synthetic callbacks не закрывают Stage1 exception.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/max/choice-delivery.test.ts`; static; commit `feat(max): bind inline choices to authentic callbacks`.

### 63. Накопительные authority/erase/recovery races
**Файлы:** migrations/0036_stage3_privacy_restore.sql; tests/functional/agent/{authority-races.test.ts,privacy-lifecycle.test.ts}; owner cleanup adapters, docs/runbooks/account-deletion.md.
**Результат:** S15–S19 cumulative proof на real PG; own cleanup уже внедрён предыдущими content migrations.
- [x] RED/proof: concurrent version edits, двух conversations/renewal/fence/erase during network, PG termination beforecommit, committed receipt lostACK, finalizer restart, retention removes content but not input tombstone, no cross-tenant refs.
- [x] Для каждой фазы проверить0late effects после authority loss, отсутствие resurrection/content logs; audio erasure intents удаляют bytes восстанавливаемо. Не запускать physical restore пока.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/agent/authority-races.test.ts tests/functional/agent/privacy-lifecycle.test.ts`; static; commit `test(agent): prove authority privacy and recovery atomicity`.

### 64. Oracle collector и измерения без внешних calls
**Файлы:** tests/semantic/{corpus-runner.ts,oracle.ts,qualification-report.ts}; tests/unit/semantic/eval-collector.test.ts; tests/fixtures/stage3/regressions.json.
**Результат:** first divergent boundary, точные effects/unchanged/choices, quality/call/latency denominator; regression vs независимый H отдельные reports.
- [x] RED S20–S22: collector read failure не PASS; partial multi-action≠full success; R/V/F/P/unsupported/denied/errors отдельные denominators; missing controls не «независимая оценка».
- [x] Все runtime tests FakeAI/FakeSTT; sampler counts wire attempts/semantic/STT/cost и queues. Не читать контроль для debugging; materialize/audio scripts только permission metadata, не production recordings.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/unit/semantic/eval-collector.test.ts`; static; commit `test(ai): audit semantic quality and latency without hidden retries`.

### 65. Кнопочный acceptance и обязательный реальный callback-canary
**Файлы:** tests/e2e/stage3-choice-flow.test.ts; docs/runbooks/stage-3-canary.md; docs/progress/stage-3-checkpoint-65.md.
**Результат:** new text/voice не захватываются old choice; реальный callback exception закрывается только настоящим MAX evidence.
- [x] Targeted S08/S18/S23: text/voice while3choices, exactreplynewintent, expiry/revision/foreign/version conflict; truthful no extraAI response.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/e2e/stage3-choice-flow.test.ts`; static; commit `test(max): complete finite-choice acceptance contracts`.
- [x] Одно накопительное review и один clean-clone gate (evidence: docs/progress/stage-3-checkpoint-65.md).
- [ ] Отдельно разрешённый TEST MAX canary: настоящий пользовательский callback, private exact webhook replay, sameoption/newcallbackId и stale choice; count Task events/receipts/outbox/confirmed reply, cleanup.
- [x] Process-local fixed FakeSemantic допустим только в изолированном TEST bot profile для создания choices; MAX/DB/Task/delivery настоящие. Public test injection отсутствует. Это proof callback, не OpenAI quality. Без разрешения bot/endpoint/recipient не запускать, оставить exception/partial checkpoint и остановиться. Deploy не разрешён автоматически.
- [x] Publish evidence/push/SHA после обязательных gates, остановка перед66. Успешный реальный callback-canary можно переиспользовать при неизменном contract; сейчас он не выполнен и остаётся открытым условием.

## Блок66–70 — финальная проверка OpenAI Stage3

### 66. Накопительный text/voice/multi-action end-to-end
**Файлы:** tests/e2e/stage3-conversation-flow.test.ts; src/runtime/worker.ts; scripts/check-architecture.mjs; tests/architecture/stage3-boundaries.test.ts.
**Результат:** один runtime path и owners, text/voice/reply/query/choice работают на тех же Tasks.
- [x] RED/proof S01–S19/S24: wholeutterance/selfcorrection/copied completion/mixedgroups/capability_unavailable/critical transcript uncertainty и no old-choice capture; shortcuts0AI, ordinary1semantic+voice1STT.
- [x] Defaultoff profile/admission/status reporting, no local model requirement; transport/provider types не входят в Tasks; no network underDB lock. Фиксить подтверждённые integration gaps внутри этого scope.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/e2e/stage3-conversation-flow.test.ts tests/architecture/stage3-boundaries.test.ts`; static; commit `test(stage3): cover unified task conversations end to end`.

### 67. Privacy adversaries и финальная готовность eval
**Файлы:** tests/functional/privacy/egress-contract.test.ts; tests/semantic/stage3-eval.config.ts; tests/unit/semantic/qualification-report.test.ts; docs/runbooks/stage-3-provider-admission.md.
**Результат:** frozen profiles/cost estimates; регрессии, независимый контроль и audio quality оцениваются раздельно.
- [x] RED S09/S10/S20/S21: C071–C078, quote/title negatives, forgedTOKEN, raw identifiers in candidates; no claim exhaustivePII detection, deniedroute0effect. Экспериментальные fixtures synthetic; scope flags не разрешают реальные данные.
- [x] Локальная часть67: все78R материализованы, application collector читает реальные Tasks/history/receipts/outbox; модель/prompt/schema/privacy/runtime/oracles/runner/R hashes замораживаются в gate. Fake/typed механизм исключён из model-quality evidence.
- [ ] Внешняя часть67: independent H20 provenance/non-tuning, разрешённые audio manifests/routes, native codec, billing cap и отдельное разрешение. Запрос125semantic/27STT/USD10; если H использовался для настройки — новая независимая выборка, не переименование.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/privacy/egress-contract.test.ts tests/unit/semantic/qualification-report.test.ts`; static; commit `test(privacy): freeze measurable OpenAI acceptance boundaries`.

### 68. Bounded queues и нагрузочный harness
**Файлы:** tests/performance/stage3.run.ts; tests/unit/agent/provider-budget.test.ts; docs/runbooks/stage-3-acceptance.md.
**Результат:** bounded4AI/2STT perworker, queues/deadlines/statuses без дополнительного external load experiment.
- [x] RED S14/S22: budget overflow/backpressure/expired authority/uncertain dispatch; one semantic+separate STT counters; cost cap predictive worstcase, missingusage conservativelycharged.
- [x] Подготовить профиль70:2workers,1000tenant metadata/≤5Tasks each, parallel seed,1RPS60s+10RPS10s burst, FakeAI1s/FakeSTT5s; сейчас только harness smoke3cases/2tenants/10operations. Это orchestration proof, не OpenAI capacity.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/unit/agent/provider-budget.test.ts`; static; commit `test(agent): bound provider work and prepare checkpoint load proof`.

### 69. Restore proof без отдельного полного прогона
**Файлы:** tests/functional/agent/final-recovery.test.ts; существующий tests/functional/operations/isolated-restore-drill.test.ts; docs/runbooks/backup-restore.md.
**Результат:** staged decision/group receipt/transcript/choices/dedup переживают разрешённое восстановление, lease/runs disarmed; lostRPO work не реконструируется.
- [x] RED/proof S15–S19: survivingdecision0AIreplay, groups0second effect, restoredexpiredchoices0mutation, cleanup/restore-fence; targeted row-state tests сейчас.
- [x] Расширить существующий physical restore fixture минимальным Stage3 state; запускать его **только один раз внутри full gate70**, без второго backup/restore job или дублирующего wrapper test.
- [x] GREEN `node node_modules/vitest/vitest.mjs run tests/functional/agent/final-recovery.test.ts`; static; commit `test(agent): preserve staged meaning across restore boundaries`.

### 70. Финальная приёмка и отчёт Stage3
**Файлы:** docs/progress/stage-3-checkpoint-70.md; docs/runbooks/stage-3-acceptance.md; targeted acceptance fixtures при необходимости.
**Результат:** S01–S24 evidence, real OpenAI quality и latency, audio consent/STT evidence, truthful ready/blocked status.
- [x] Целевая final contract проверка/static; commit `test(stage3): complete OpenAI task acceptance contracts`.
- [x] Одно cumulative review66–70; тот же reviewer проверил согласованные67/70 доработки и подтвердил закрытие4findings. Один отдельно разрешённый финальный clean-clone gate PASS115files/849tests с functional/e2e/image/physicalrestore внутри; отдельные functional/review-focus/restore не запускались. Code freeze b1d30d6; финальные history/tree secret scans PASS0findings.
- [x] Один FakeAI/FakeSTT load profile из68: исходная попытка завершилась тайм-аутом при sleep269s; после диагностики/phase evidence/smoke — один отдельно разрешённый повтор PASS160/160, исходные профиль и240s сохранены. Stage2 A24/foundation load не повторялись.
- [ ] Только после отдельного согласования final budget/data/audio routes: один проход R-регрессий и один H001–H020 контроль, один audio gate по30 сценариям записей/отказов OpenAI STT→Privacy→semantic→Tasks.125semantic/27STT maximum dispatches, отдельно утверждённый USD10 ceiling с доказанным ограничением расходов; никаких best-of-three/скрытых retries. Latency/quality/calls/errors/cost публиковать раздельно по наборам.
- [ ] S20: safety100%, full exact≥90% overall и create/update/lifecycle/query/multi-action, precision≥98%/recall≥95%; контроль отдельно safety100%/exact≥90%, small sample uncertainty явно. S21: cleanWER≤15%, critical-span≥98%, unsafe critical effect0; deniedpolicy recordings не входят в WER/semantic denominator, refusal отдельно.
- [ ] Реальный MAX text/voice/create→update→complete/restart/delivery требует разрешённого TEST endpoint/bot/recipient и audio. Callback65 остаётся открытым: нужен отдельно разрешённый реальный callback-canary и его точный повтор; synthetic checks это условие не закрывают. Deployment/realuserdata этим планом не разрешены.
- [x] Итоговый отчёт:фактические checks/SHA/profiles/sample counts/limitations, unresolved external evidence явным blocker; docs-only publication/push/local=remoteSHA. **Остановиться для принятия Stage3. Stage4/сервер не начинать.**


Historical checkpoint70 status before separately authorised completion cycle2026-10-17: [actual report](../../progress/stage-3-checkpoint-70.md). One full gate attempted (833PASS/1timeout/4unexecuted), narrow closure5PASS without code change;838distinct tests with passing evidence. One fake load timed out, no successful metrics or repeat. Full typed78R/application collector remains unfinished LOCAL preparation; codeReady=false. History/tree scans each flag the same synthetic refusal test, not green zero-finding scans. Stage3 incomplete; Stage4 not started.

Current local67/70 completion: [local preparation](../../progress/stage-3-local-preparation.md), [unchanged full load PASS](../../progress/stage-3-final-load-evidence.json). All78R mechanisms materialised and wired; one scoped confirmation by the same reviewer closed four harness findings. Final clean-clone gate PASS115files/849tests; final history/tree secret scans PASS0findings; local codeReady=true, stageComplete=false. External Stage3 acceptance and Stage4 remain blocked.

## Карта покрытия

S01→51/55/66; S02→53/55; S03→55/57/66; S04→54/55; S05→55/57/66; S06→55; S07→54; S08→53/60/61/65; S09→52/67; S10→52/59/67; S11→59/60; S12→59/60/63; S13→60/69; S14→52/53/56/60/68; S15→56/63/69; S16→57/63; S17→58/63/69; S18→61/62/65; S19→52/54/59–63/69; S20→51/53/64/67/70; S21→60/64/67/70; S22→64/68/70; S23→62/65; S24→58/66/70.

Результат этого изменения — документы для принятия. Ни API probe, ни код, ни review agents сейчас не запускаются. Уточнённые указания владельца имеют приоритет над прежними обязательными local-model gates и рекомендациями skills о дополнительных агентах/прогонах.

Принято владельцем2026-10-15. Разрешён только блок51–55, включая один ограниченный probe53; остальные блоки требуют отдельного разрешения.

Дополнение к53 (разрешение владельца2026-10-15): один repair cycle (dated C034 плюс C101 без даты, prefix labels, invalid vs transport); replay сохранённых синтетических ответов/targeted tests; freeze attempt2; один полный проход12 на той же модели≤USD2. Первая попытка сохраняется FAIL. При втором FAIL остановка до54, без gate/новой модели/дополнительного probe.

Текущее разрешение после FAIL attempt2: только локальное уточнение quote-only wire и source temporal guards, replay сохранённых ответов/целевые тесты/документы. Шаги54–55 не возобновлены. Диспетчер старых probe закрыт, новый probe/профиль/заморозка требуют отдельного согласования, прежняя модель не меняется.

Разрешение владельца на попытку3: один проход12 на той же модели,≤USD2, без повторов; safety12/12, exact≥11/12. Фактически safety/exact12/12,12 вызовов,USD0.069156. После успеха разрешены54–55 и один checkpoint55 review/clean-clone gate без внешнего probe. См. docs/progress/stage-3-checkpoint-55.md.
