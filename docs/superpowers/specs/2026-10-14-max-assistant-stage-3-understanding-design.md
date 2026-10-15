# Echo MAX — Stage 3: смысл, голос и управление задачами

Дата2026-10-14, Europe/Moscow. **Проект для принятия владельцем. Сейчас разрешено только обновление документов. После их принятия ранний шаг53 допускает заранее ограниченные синтетические OpenAI-запросы; реализация сейчас не начинается.** Stage2 принят владельцем на SHA `66014298a4e511a1aa10a1df0242deda06ecc48e`.

## 1. Приоритет и результат

Источники: [принятая архитектура MAX](../../../../echo-secretary/docs/superpowers/specs/2026-09-30-max-assistant-core-architecture-design.md), особенно §§7–8,13–14,20–22; [foundation](../../architecture/foundation.md); [Stage2](2026-10-13-max-assistant-stage-2-task-domain-design.md); [checkpoint50](../../progress/stage-2-checkpoint-50.md). Архитектура MAX и новые указания владельца имеют приоритет над Telegram-решениями. Источники регрессий и точные примеры — [корпус Stage3](../corpora/2026-10-14-max-assistant-stage-3-dialogues.md).

Пользователь пишет или надиктовывает дела; получает короткий правдивый ответ о созданном/изменённом, список собственных задач либо необходимый конечный выбор. Понятное создание допускает отсутствие даты. Явное изменение требует доказанной цели. Несколько независимых действий сохраняются независимо; связанные действия — одной атомарной группой. Нет обязательного «ОК» после обычной команды, обязательной повторной диктовки или автоматического захвата нового ввода старым уточнением.

**Запуск Stage3 — на OpenAI для понимания текста и распознавания голоса.** YandexGPT, GigaChat и локальные модели — будущие адаптеры заменяемых интерфейсов. Их реализации, установка, развёртывание и проверки качества не входят в Stage3 и не блокируют запуск. По уточнению владельца это заменяет первоначальный shortlist и прежнее требование обязательных локальных semantic/ASR/privacy-моделей основной архитектуры. Остальные ограничения на разрешённый внешний маршрут, минимизацию и защиту данных сохраняются. Выбор OpenAI сам по себе не подтверждает доступность в выбранной среде или допустимость обработки конкретных данных; профиль обработки фиксируется перед вызовами, без обхода ограничений через VPN/прокси.

Model/API/profile закрепляются при реализации по актуальному официальному контракту. Пользователь разрешил ранние текстовые запросы только на синтетических обезличенных примерах, существующим ключом из файла секретов проекта; новый ключ не создавать. Это разрешение действует на шаге53 после принятия документов, не на реальные пользовательские данные, аудио или deployment.
В scope: Context, Semantic/Agent Runtime, Privacy, Media/STT, Task Tools, pending choices, MAX текст/voice/reply/callback, staged decision/recovery и измеримые eval. Не входят: reminders/jobs/delivery напоминаний, полноценный Daily View/ранжирование фокуса, billing, Mini App, calendar, общий чат/веб-поиск, auto provider fallback и Telegram migration. «Напомни» понимается как unsupported отдельное намерение, не становится молча задачей или обещанием уведомления. Чтение today/open использует Stage2 query, без новой копии списка.

## 2. Владельцы и контракты

|Owner|Единственная ответственность|Граница|
|---|---|---|
|Intake|аутентичное событие, reply/callback metadata, порядок и leases|не вызывает AI/STT из webhook|
|Media|скачивание, изоляция codec, audio privacy, transcript и cleanup|transcript не является командой|
|Privacy|локальная классификация и минимизация всех данных перед provider|не определяет lifecycle Task|
|Context|доставленная беседа, committed changes, точные ссылки, кандидаты|retrieval не авторизует mutation|
|Semantic|целая реплика → MeaningDecisionV1; один DecisionValidator|не пишет Task SQL и не стилизует committed ответ вторым AI|
|Agent Runtime|бюджет, durable run/decision, группы, pending choices, recovery|не меняет правила Tasks|
|Tasks|существующие команды, версии, events, receipts, public reads|не знает MAX/OpenAI/transcript|
|Delivery|MAX drafts/buttons, outbox, certainty и receipt доставки|не переисполняет команды|

Application/domain остаются DTO/port-only. Runtime выбирает adapter конфигурацией выпуска. OpenAI-вызовы, transport schema, auth, usage/error mapping принадлежат infrastructure. Будущие внешние и локальные backend реализуют те же порты; в текущем runtime есть только OpenAI. Автоматический fallback отсутствует. Запрещённый внешний маршрут означает безопасный отказ, а не необходимость реализовать локальную модель.

Контракты (readonly DTO; JSON schema strict, version1):

- `PrivacyGateway.prepare(pack: InternalContextPack): PrivacyResult` — `external_allowed|tokenized|denied`; выдаёт ProviderContext и локальный handle mapping либо код безопасного отказа. Не делает сеть.
- `AiDecisionProvider.decide(context: ProviderContext, registry: ToolRegistryV1, schemaVersion:1, deadline: Instant, signal: AbortSignal): Promise<ProviderResult>` — decision JSON, model/profile/prompt versions, nullable usage, duration, закрытый outcome. Не получает InternalContextPack или token mapping.
- `AudioPrivacyGateway.route(asset: VerifiedAudio, principal: AudioPolicy): AudioRoute` — external_stt_allowed / denied. Отдельный контракт, не текстовый PrivacyGateway.
- `SpeechToTextProvider.transcribe(input: ApprovedAudio, deadline, signal): TranscriptResult` — текст, язык, segments/critical uncertainty, checksum, provider/model/version; неизвестная confidence остаётся null.
- `DecisionValidator.validate(decision, sourceMap, contextSnapshot): ValidatedDecision|InvalidDecision` — единственный semantic authority validator.
- `TaskResolver.resolve(target: TargetBasis, contextSnapshot): ResolvedTarget|FiniteChoice|NotFound` — только public TaskQueries, не второй AI.
- `TurnCoordinator.stage/run/finalize(turnId)` — durable решение, исполнение групп, общая truthful projection. `ChoiceExecutor.consume(token, authenticatedCallbackSource)` — без AI.

## 3. Понимание целой реплики

Нормативная DTO-форма (спецификация, не реализация):

```typescript
type SpanRef = {sourceLabel:string; start:number; end:number; quote:string}; // code points
type TargetBasis =
 | {kind:'candidate'; label:string; evidence:SpanRef[]}
 | {kind:'reply'; anchorLabel:string; evidence:SpanRef[]}
 | {kind:'list_index'; anchorLabel:string; indices:number[]; evidence:SpanRef[]}
 | {kind:'search'; title:string; qualifiers:{date?:string; status?:'open'|'completed'|'cancelled'}; evidence:SpanRef[]};
type TimeDraft = {field:'targetDate'|'scheduledAt'|'deadline'; expression:string; evidence:SpanRef[]; scopeUnitLabels:string[]};
type ActionDraft = {label:string; unitLabel:string; kind:'create'|'update'|'complete'|'cancel'|'reopen';
 target:TargetBasis|{kind:'created'; label:string}|null; fields:{title?:string; description?:string|null;
 clearFields?:('description'|'targetDate'|'scheduledAt'|'deadline')[]}; times:TimeDraft[]; evidence:SpanRef[]};
type ReadDraft = {label:string; unitLabel:string; kind:'open'|'day'|'find'|'history'|'capabilities';
 text?:string; dayExpression?:string; statuses?:('open'|'completed'|'cancelled')[]; target?:TargetBasis};
type MeaningDecisionV1 = {version:1; units:MeaningUnit[]; relations:MeaningRelation[];
 actions:ActionDraft[]; queries:ReadDraft[]; groups:GroupDraft[]};
```

Все объекты strict, неизвестные keys запрещены. Метки: units `u[1-9][0-9]{0,2}`, actions `a[1-9][0-9]{0,2}`, queries `q[1-9][0-9]{0,2}`, groups `g[1-9][0-9]{0,2}`. Ссылки unitLabel/relation endpoints/scopeUnitLabels только на u, actionLabels на a, queryLabels на q; created target на a-label соответствующего Create. Пересечения/повторы/неизвестные ссылки отклоняются, второй AI для ремонта не используется. MeaningUnit fields: label,kind,speechAct,polarity(`positive|negative`),modality(`asserted|uncertain`),authoredByOwner,evidence[],uncertainty(`null|target|time|intent`). MeaningRelation fields: kind(`shared_time|same_target|correction|depends_on|quote_scope`),fromLabel,toLabels[],evidence[]. GroupDraft fields: label,unitLabels[],actionLabels[],queryLabels[],outcome(`execute|needs_choice|respond|capability_unavailable`),reason(`null|target|time|intent|unsupported`). Group labels canonicalise приложение; unknown/duplicate refs invalid. No UUID/version/effectKey/provider-supplied arbitrary command JSON. Model may suggest needs_choice reason, но options и их command payload строит только application.

Search target set с явным «оба/перечисленные» разрешён только при доказанном bounded scope≤20 и полноте selection, не по первому page. Неполнота/слишком много целей → no effect компонента. Набор targets и versions фиксируется до Task execution. Pure query/history не делает mutation. «Готовые дела на сегодня» означает назначенные на сегодня completed Tasks; запрос факта завершения в день требует history evidence и не подменяется Task.day membership.


`MeaningDecisionV1` содержит `units[]`, `relations[]`, `groups[]`, `queries[]`. До20 units/20 actions/10 groups на ход, до20 commands в группе (лимит Stage2). Для превышения — явный отказ без усечения и без частичного «первых20».

Unit: local label; тип `action|query|context|unsupported`; speech act `request|assertion|question|quote|hypothesis|meta`; polarity, modality, authoredByOwner; ссылки на исходные code-point spans `[start,end)` и точные цитаты; temporal expressions, task target basis, uncertainty. Общие даты/перечисленные цели и self-correction задаются явными relations, не механическим last-field-wins. UUID и expectedVersion назначает приложение, не модель.

Group имеет один исход: execute / needs_choice / respond / capability_unavailable. Для execute — только разрешённые TaskCreate/Update/Complete/Cancel/Reopen и queries. `created:localLabel` допускается внутри одной группы. Зависимости между группами не исполняются как независимые: приложение объединяет связанные actions или отклоняет конфликтующий компонент. Пересечение одного Task/локальных ссылок/условий запрещает частичное исполнение компонента; модель не может сама объявить его независимым. При невозможности доказать independence — не применять спорный компонент, а не откатывать уже доказанную независимую задачу.

Нулевые mutations — нормальный исход мысли, гипотезы, отрицания, цитаты, мета-реплики или вопроса. Исходник сохраняется как принятый turn, но это не обещание создания memory item: Stage2 хранит только Task. Отсутствие действия не запускает capture fallback.

Validator проверяет schema/labels/graph, точные spans и source provenance, владельца, отрицание/цитирование/неопределённость, allowed fields, evidence/target scope, временную связь и группу. Confidence модели не даёт полномочий. Структурно сломанный frame полностью отклоняется без извлечения «хороших кусков» и без JSON-repair AI. В структурно валидном frame локальная неопределённость блокирует только связанный компонент. Это прикладные guards и corpus evidence, не утверждение о формальном доказательстве естественного языка.

### Создание и изменение

Явное создание и обычная утвердительная диктовка новой задачи → Create. Совпадение названия с существующей задачей не превращает новое Create в Update и не требует подтверждать «возможный дубль». Разные явные события с одинаковым title могут создать две задачи по Stage2.

Перенос/исправление/завершение/отмена/восстановление → existing target; never fallback Create. Конкретная цель подтверждается текущим literal intent и одним из оснований: прямое название с нужными qualifiers; точный reply на сообщение, связанное с Task; один объект предыдущего **доставленного** хода; индекс явно показанного и сохранившегося списка. Общая похожесть слов/первый результат/score не являются authorization. «Всё сделано» без ограниченного однозначного набора не завершает всю память. Ясное завершение одной/нескольких доказанных целей применяется без обязательной confirmation кнопки: старые Telegram подтверждения не переносим.

Resolver: ровно1 доказанная цель → UUID/version;2–5 → конечный выбор;0 → not_found без Create;>5 → объяснить необходимость сузить цель, не показывать огромный список кнопок. Один bounded post-decision SQL retrieval разрешён на target-component, общий лимит3/turn; исчерпание → безопасный неисполненный компонент. Без второго AI даже если задача была вне первичного candidate pack.

## 4. Контекст и время

InternalContextPack строится на snapshot исходного события, timezone и локальной дате/времени, не clock времени retry. Текущий input полный: text≤16000 code points/64KiB (существующий intake); transcript≤32000 code points. Больший input не обрезается и не делится на дополнительные AI вызовы автоматически: capability_unavailable, источник сохранён локально.

История: до12 пар/ходов за48ч, только ассистентские сообщения с certainty=sent и действительными внешними IDs; inbound provenance сохраняется отдельно. Uncertain/pending reply не притворяется виденным пользователем. Recent committed Task changes приоритетнее недоставленных реплик. До50 candidates через TaskQueries all/open, включая недавно terminal; description excerpt≤512 code points, явные truncation flags; internal source остаётся доступен локальному resolver.

До AI: максимум3 bounded retrieval requests, используя текущий текст/доставленные anchors для ranking. Regex/lexical extraction здесь не создаёт смысл/действия и не сегментирует реплику в задачи. Exact reply проверяется tenant+conversation и может подниматься вне48ч окна; missing reply не заменяется «последним Task». List anchors хранят показанный порядок Task UUID/version, а не вычисляют его заново.

Бюджет вспомогательного context6000 tokens; полный provider input≤24000 tokens включая current source/registry. Сокращается только auxiliary context; полный current input/нужный точный anchor не помещается → явный отказ, без silent clipping. Максимум input поддерживается выбранным pinned model profile, проверяется локальным tokenizer. Pending choices присутствуют только как справка с labels, не active conversation mode.

Модель возвращает выражения дат/часов и scope. Application TemporalNormalizer использует IANA port Stage2. «Завтра» от local date исходного события; названный weekday без «прошлый» — ближайшая дата не раньше source local date, включая сегодня; «в прошлый» — предыдущая. «Сегодня» при позднем retry не становится завтра. Точные часы дают scheduledAt; targetDate ставится только при явном/общем date scope (Stage2 разрешает instant без targetDate). Deadline задаётся явно: «до», «не позднее», «срок», «к девяти / к9». «Завтра к девяти отправить отчёт» означает deadline.at завтра09:00 в source timezone, без scheduledAt; «завтра в девять» означает scheduledAt. «К девяти» без дня использует source local date, не автоматически завтра; уже прошедший срок не переносится. Отсутствие срока/часа не требует выбора.

Meeting gap → nonexistent, fold → кнопки двух допустимых offsets, без догадки. Calendar day reading использует отдельную политику Stage2 gap/fold/skipped boundaries и cursor asOf; никакого23:59/instant+24h/carry-forward. Перенос date-only не сдвигает точный instant молча: explicit scope меняет ровно выбранные поля. Если пользователь переносит саму встречу «её на завтра», полное доказанное schedule изменение задаёт дату+точное время; если время не сообщено и не унаследовано из цели — не придумывать часы.

## 5. Privacy Gateway перед OpenAI

Сырой input, полная локальная история и восстановленные значения остаются в защищённом контуре проекта. Gateway применяется **ко всему будущему provider payload**: текущему вводу, Task candidates, нужным delivered anchors, snippets истории и registry examples. Внешний AI не используется для проверки приватности сырого текста.

Gateway использует доступные локальные проверки без моделей: allowlist полей, шаблоны телефонов/email/документов/ключей, заданные словари чувствительных категорий, известные профильные значения, явно объявленные пользователем ограничения и policy flags. Сначала исключаются ненужные сведения, затем распознанные чувствительные значения заменяются случайными метками. Не добавлять контакты/профиль, если они не нужны для команды. Имя или идентификатор, уже известные локальному контексту, можно заменить без NER; произвольное имя в свободном тексте может остаться нераспознанным.

**Эти проверки не гарантируют обнаружение всех персональных данных, тайны, косвенной реидентификации или категорий содержания.** Полнота смыслового анализа приватности без моделей не заявляется. Отсутствие совпадения с regex не означает «в тексте нет персональных данных». Отчёт фиксирует покрытые шаблоны, ограничения и остаточный риск. При необходимости полного локального понимания/гарантии отсутствия таких данных текущий внешний маршрут непригоден: отказ, без требования локальной модели для остальных разрешённых запросов.

PrivacyResult:

- `external_allowed`: policy допускает внешний текстовый маршрут; отправляется минимальный pack после исключения запрещённых полей.
- `tokenized`: распознанные или явно обозначенные чувствительные значения заменены метками этого run; polarity, scope, даты и ссылки сохраняются.
- `denied`: маршрут запрещён политикой/пользователем, есть обнаруженные запрещённые данные без допустимой замены, существенная неопределённость в конкретной проверке, ошибка проверки, потеря SourceMap или искажение смысла минимизацией. Никакого AI-вызова или эффекта задачи; короткое объяснение причины и возможность самостоятельно прислать допустимый текст. Это не обещание локального понимания.

Provider получает только эфемерные Task/source labels, календарный anchor, нужные snippets и registry. User/MAX/conversation UUID, message/channel IDs, stable Task IDs, session/trace IDs, auth headers/секреты, media URL/tokens, mapping и полная история исключаются по allowlist. API credential передаётся transport adapter только в предназначенном для авторизации поле, никогда в prompt, arguments, логи или Git. Ключ читается непосредственно из существующего разрешённого файла секретов в памяти процесса; subprocess argv, shell substitution, debug dump и вывод env запрещены. Местоположение файла фиксируется приватным preflight, значение не выводится. Новый ключ и копия в репозитории не нужны.

`SourceMap` хранит связь меток/sanitized code-point spans с оригинальными диапазонами и Task references. Unknown/forged/cross-run refs отклоняются. Rehydration восстанавливает только выданные метки, затем общий DecisionValidator проверяет spans, цели и связи. Mapping encrypted локально, TTL30min, hard cap2h; после accepted normalized decision удаляется. Replay использует durable decision. Потеря mapping не ведёт к повторному raw запросу.

Adapter принимает только ProviderContext/ApprovedAudio; raw-pack overload запрещён. Logs/traces содержат counts, code/profile/version/latency/usage, без текста, prompt/response, аудио, mapping и ключа. Детерминированные privacy-тесты доказывают отсутствие перечисленных запрещённых полей/значений в конкретных fixtures, а не универсальное обнаружение персональных данных.

## 6. Аудиозапись до внешнего STT

**OpenAI STT получает саму запись**, а не предварительно обезличенный текст. В ней могут быть речь третьих лиц, содержание и особенности голоса; изменение codec/имени файла и текстовый gateway после транскрипции не анонимизируют уже переданный звук. Локальная ASR и анализ аудио моделью не требуются и сейчас отсутствуют.

`AudioPrivacyGateway` допускает `external_stt_allowed` только при всех условиях: включён разрешённый OpenAI STT profile; есть отдельное явное согласие на передачу самой записи указанному внешнему processor (текстовое согласие его не заменяет); разрешены регион/категория/retention обработки; пользователь обозначил собственную диктовку без запрещённых данных/неразрешённых третьих лиц; источник и файл прошли локальные технические проверки. По умолчанию до такого разрешения — `denied`. Для обычной голосовой команды после audio opt-in повторное согласие на каждую запись не требуется, но разрешение можно отозвать. Реальные пользовательские записи и тестовые аудио требуют отдельного разрешения владельца: разрешённый ранний текстовый probe их не включает.

Без локального ASR/модельного классификатора невозможно до отправки подтвердить отсутствие чувствительного содержания или чужих голосов. Декларация пользователя и технические проверки — условия policy, не доказательство содержимого. Если действующая политика требует предварительного подтверждения содержания, OpenAI audio route отказывает; будущий локальный STT может расширить допустимые маршруты отдельным этапом.

Причины отказа: нет/отозвано audio разрешение, неизвестный/недопустимый processing profile, declared secrets/sensitive category/третьи лица без разрешения, unsupported policy requirement, остановленный/удаляемый аккаунт или restore fence, непроверенный источник, превышение limits, некорректный codec либо ошибка проверки. До разрешения STT не вызывается. После транскрипции transcript проходит тот же text Privacy Gateway перед semantic AI: можно запретить semantic processing уже полученного текста, но это не отменяет факт отправки аудио в STT. Отказ не требует повторного голосового сообщения; пользователь может прислать разрешённый текст.

Media: только allowlisted MAX origins, HTTPS/redirect/DNS/private-range SSRF checks; bounded stream≤25MiB, duration≤20min. Codec sandbox без сети, непривилегированный, private temp; PCM mono16kHz, decoded≤50MiB, MIME/container/duration проверяются после decode. Redirect не переносит token на чужой host; credentials не попадают в command line/logs/body STT.

`SpeechToTextProvider` заменяемый; реализуется только OpenAI STT. Transcript — durable derived fact: checksum, text, segments, language, nullable confidence/critical uncertainty, model/profile version. Если API не сообщает уверенность, она null; не объявлять детектор утраченного «не» достоверным по отсутствующему signal. Uncertainty из ответа/явного контекста блокирует связанное действие; конечные альтернативы — кнопки, иначе текстовое объяснение. WER и critical-span точность измеряются на разрешённых записях, не подменяются уверенностью провайдера.

После transcript commit звук удаляется; restart использует transcript, без второго STT. Crash между commit и deletion восстанавливает cleanup; erase/stop/fence отменяет текущую работу и удаляет bytes. Ошибка — private retention≤30min и cleanup. Lost ACK после STT dispatch означает uncertain outcome, не proof exactly-once remote billing; автоматического повторного отправления записи нет.

## 7. Durable pipeline без сети под DB locks

Исходные Stage2 transactions и worker pure-handler timeout рассчитаны на typed writes, не на AI. Нельзя вставить медленный AI/STT в `PostgresAtomicProcessing` callback или увеличивать DB deadline вместо разделения фаз.

1. Короткий guarded claim head: restore guard → active users share → conversation/work/head. Создать/найти assistant_turn и подготовительный run с generation/input/context/profile digests, сохранить source snapshot. Освободить DB locks; conversation остаётся leased, независимая renew session работает.
2. Media/Context/Privacy и выбранный provider вне транзакции. Downstream sequence не обгоняет неготовый head. Начало нового сообщения не меняет snapshot уже выполняющегося turn. Backpressure max4 dialogue runs/max2 STT per worker; bounded queues, никакого неограниченного Promise.all.
3. Fresh guarded staging: проверить owner/generation/expiry/user/fence, source digest и manifest revisions; принять normalized validated decision **до** первого Task effect. Stale result записывает только безопасный discarded outcome, не получает права продолжать. Фиксируются groups/command intents/keys и queries; retry использует их без AI.
4. Resume groups в stable order. Для каждой ready independent group одна guarded transaction: тот же Task public bound API, Task events/receipt + group result/turn projection revision + idempotent continuation delivery intent сохраняются вместе. Side effects внутри policy только Noop Stage2. Pending choice вместо partial commands сохраняется в своей группе.
5. Finalizer блокирует turn, читает group receipts/statuses, создаёт один общий final response + processing receipt + final outbox, завершает inbound/pointer/lease. Если early group уже committed и final response ещё не создан, durable turn continuation из шага4 является намерением завершить/доставить ответ; restart гарантированно восстанавливает finalizer. Нельзя заявлять, что final outbox физически существовал до последней группы: независимые groups commit отдельно по архитектуре §8.4.

`turn_response_intents` — private durable очередь финализации, не второй sender/outbox: unique(turnId), versioned group progress, неизменяемый receipt reference. Итоговый MAX message существует только в Delivery outbox с key `turn:<id>:final:v1`. Callback resolution имеет свой source/ответ с key `choice:<id>:<revision>:result:v1`, исходное сообщение не переписывается как seen reply. Task/group receipt и durable ответное намерение атомарны; подтверждение всегда после commit. Для single group finalizer можно выполнить в той же transaction, без дополнительного AI.

Query-only turn исполняет сохранённые read args и детерминированно показывает Tasks; source-local day и Stage2 cursor/asOf сохраняются. First response20/max100, продолжение отдельной read кнопкой только если пользователь запросил больше (это pagination, не confirmation обычной команды). В Stage3 базовая выдача≤20 и текст «показываю20…»; pagination UI можно отложить, Stage2 cursor остаётся port.

Network retries: ordinary successful turn≤1 semantic AI invocation; voice дополнительно≤1 OpenAI STT dispatch, отдельные latency/usage/cost counters. Adapter/SDK auto retries выключены. Неопределённый sent/request-started, malformed JSON, safety refusal не вызывают silent second model/repair/style call. Доказанный pre-dispatch failure допускает≤2 retries через backoff1s/3s в пределах общего deadline, без новой accepted decision; счётчики distinguish logical run/wire attempts. HTTP429 с ответом также уже был provider invocation: сообщить задержку/ошибку, не превращать в ещё один ordinary call. Операторское повторное понимание требует новой revision и никогда не переисполняет accepted effects.

Provider attempt staging не может доказать exactly-once remote billing без гарантий провайдера. После started run без durable response при crash — outcome uncertain, нет mutation/automatic redispatch. UI различает «источник принят», «обработка не завершилась» и «Task сохранён»; не обещает retry, если он не поставлен durable.

## 8. Кнопочные выборы и новое сообщение

`pending_choice` — сохранённый **конечный** unresolved component, не режим беседы. Option содержит только сохранённые typed commands/bindings/expectedVersions, отображаемые локально Task labels/дату; не свободную инструкцию модели.2–5 options + «Отмена» (до6 кнопок), TTL24h, random token≥128bit, только hash в БД; revision, originating turn/group, user/conversation, optionId, expiry и immutable snapshot обязательны. Token не содержит UUID, текст, поля Task или credentials.

Новый text/voice **никогда автоматически не consume/continue** choice, даже «да», «второй» или похожую тему. Точный reply на сообщение с выбором может явным **новым намерением** заменить исходный unresolved component: новый turn, новый validated plan; после commit новая choice revision supersedes старую. Просто новая независимая команда оставляет старый выбор справочным до expiry. «Отмена» как текст без явной ссылки не отменяет последнее ожидание или последнюю задачу автоматически.

Callback проверяет аутентичный MAX user+conversation+message binding (включая callback messageId, который Stage1 пока не сохраняет полностью), token hash/TTL/revision/option, account active/restore fence, task versions и one-shot claim. В одной guarded transaction: consume + Task effect/receipt + group result + response intent/outbox. Повтор точного MAX callback и повтор той же option с новым callback id возвращают уже сохранённый outcome без эффекта. Stale/expired/superseded/foreign tokens дают короткий closed-code ответ, no mutation/no AI. Version conflict не подменяется автоматическим latest version; сохранить источник/предложить новый конкретный выбор при bounded revalidation без модели, либо объяснить conflict.

Обычный successful Create/Update/Complete/Cancel/Reopen получает текст без кнопок. Кнопки: неоднозначная цель, два DST offsets, проверяемые конечные альтернативы critical transcript/intent. Нет универсальных «ОК / Исправить / Отменить» и глобального capture-next-voice режима из Telegram.

## 9. PostgreSQL и lifetime

Additive migrations0027–0036 после26; старые checksums не редактировать. Плановые номера при конфликте с новым migration head перенумеровать последовательно и записать ruling. Каждая content migration сразу подключает narrow erasure/counts/retention своего owner; не откладывать cleanup до финального checkpoint. Разделить schema chunks по владельцам:

- Agent: assistant_turns, turn_inputs, agent_runs, accepted_decisions, turn_groups, tool_calls, turn_response_intents; per-tenant composite FKs, source/decision revisions/digests, stable labels/keys, status/generation/deadlines. Accepted decision и executed command payload immutable.
- Context: delivered_message_anchors и list/task references с certainty/sourceVersion, не копия Task state.
- Privacy: run_token_maps (encrypted, scope/TTL), provider_admissions metadata/version без credentials, privacy_routes с outcome/counts без raw snippets.
- Media: media_jobs, transcripts и cleanup metadata; bytes только private ephemeral storage, encrypted, не PostgreSQL bytea/bucket с публичными URL.
- Choices: pending_choices/options и immutable consumption receipts; unique token hash, unique(group,revision), one active revision per unresolved component.
- Delivery/Intake owner: versioned rich text+inline choices draft contract, callback message binding; processing result `assistant_turn_v1` с turn/response refs. Сохранять foundation/task_commands_v1 validators и composite tenant guarantees.

Все content tables FORCE RLS/app.user_id и composite FKs. Worker имеет узкие собственные writes, Tasks SQL остаётся у Tasks adapter. Scheduler получает только narrow claim/cleanup/erase functions; runtime не получает migrator grants. Technical retention не удаляет Task/history/keys; privacy erase удаляет все Stage3 source/transcripts/decisions/maps/choices/media and keys. Anonymous audit хранит counts/outcomes без цитат/Task/actor IDs.

Source/validated semantic content retention30days после final outcome (не удалять активные unresolved/recoverable turns); maps30min/hard2h, choices24h, raw audio≤30min. Task/domain receipts продолжают Stage2 lifetime. Приватный минимальный completed-turn dedup tombstone остаётся до account erasure: user + HMAC normalized provider event key/keyVersion + stable turnId/outcome marker, **без текста/аудио/decision**. Composite uniqueness и проверка до provider call не дают повторно понимать/создавать Tasks после технического удаления inbound. Existing turn-input FK допускает unlink при technical retention, не каскадное удаление этого marker. Key rotation сохраняет lookup предыдущих key versions до миграции tombstones; plaintext event key не требуется в marker.

Для turns Source.kind=turn использует stable assistantTurnId. Stage2 bridge, который сейчас доказывает source через event.id, расширяется только infrastructure binding: validated turn принадлежит locked inbound/head/user; typed Task contract не принимает provider-supplied source IDs. Публичный Tasks bound composition получает trusted source DTO, не читает Agent tables и не вводит второго SQL writer. Effect keys стабильны `(turnId, acceptedDecisionRevision, canonicalGroupLabel)`; immutable accepted revisions нельзя заменять после первого эффекта. Reply and choice anchors сохраняют версии, не ambient «последний Task».

Restore: global fence закрывает все new staging/apply/choice/media/AI claims; network already started не даёт дальнейших writes после authority loss. Restore reconcile инвалидирует leases/runs, не повторяет external calls/old responses/expired choices автоматически; surviving decisions/receipts продолжают только после явного reopen и source/versions check. Lost work beyond RPO не реконструируется из модели/старых replies. Privacy erase races с любой фазой deny commit и удаляют временные bytes; не держать user row lock во время provider I/O.

## 10. Качество, задержка и доказательства

Корпус C001–C101 — **регрессионный**: он доступен разработчику и используется для разработки/настройки. C081–C100 больше не объявляются holdout. Modes R/V/F/P не смешиваются в знаменателях. Отдельная независимая контрольная выборка H001–H020 замораживается до настройки и не используется в prompt examples, выборе модели, диагностике или подборе порогов. Её примеры готовятся независимо от настройки (владельцем либо из неиспользованных обезличенных сценариев), приватный manifest фиксирует источник, hash и oracle; результаты открываются только в финальном gate. До готовности такой выборки нельзя заявлять независимую проверку качества. Раскрытые для исправления случаи становятся регрессионными; повторная независимая проверка требует новой выборки и согласованного бюджета.

**Ранний probe53 до основного конвейера:** фиксированный набор12 C003/C024/C025/C013/C015/C016/C034/C020/C041/C043/C005/C064. Только синтетические pack/Task labels/transcripts-as-text; не обращения к настоящим Tasks/MAX и не аудио. Все12 fixtures/oracles/prompt/model/privacy versions хешируются до вызовов. Один semantic request на case, максимум12 dispatches, auto retries off, максимум12000 input и2000 output tokens/request, общий потолок **USD2**. Перед отправкой сверяются актуальные официальные цены выбранного профиля, верхняя оценка всех12 запросов и доступность; бюджет не увеличивается автоматически. Прогноз превышаетUSD2 — не запускать; профиль/объём менять только до заморозки с явным отражением изменения. Ключ существующий, чтение в памяти. Реальные пользовательские данные, аудио и deployment не разрешены.

Probe проходит при100% safety assertions (нет mutation→Create, отрицание/цитата не исполняются, правильные цели, количество действий, старое уточнение не захватывает новый ввод, «к девяти» именно deadline) и≥11/12 полностью верных решений. Это ранняя проверка жизнеспособности, **не статистическое доказательство90%** и не приёмка Stage3. Обычный валидный case не требует второго AI. Все output аудируются; invalid/error counts видны, collector failure не PASS. При провале сохранить отчёт и остановиться перед основной реализацией: без скрытых повторов/подбора лучших ответов. Повтор/дополнительные внешние эксперименты — отдельное согласование.

На frozen финальном OpenAI/model/prompt/privacy profile — один полный real-text проход R-регрессий плюс один проход H-контроля на checkpoint70, с отдельным заранее согласованным бюджетом. Audio gate также требует отдельного разрешения и записей. Fake tests доказывают исполнение/recovery, OpenAI eval — наблюдаемое понимание, контроль — качество на неиспользованных случаях. Ни один из этих видов доказательств не заменяет остальные.

Метрики exact/precision/recall ниже относятся к поддержанным R-регрессиям; query, negative/quote, unsupported, denied и failures имеют явные отдельные знаменатели. Query-family exact также≥90%. H-контроль: safety100%, exact≥18/20, отдельный отчёт; per-family counts публикуются без статистического обобщения малой выборки. Audio WER исключает policy-denied/corrupt записи, latency≤120s исключает long clips; refusal/call counts этих случаев обязательны.

|Metric|Stage3 gate|
|---|---|
|Safety corpus|100% critical assertions;0 wrong target/cross-tenant/mutation from quote/negation;0 update→Create;0 old-choice capture;0 false committed-success|
|Supported first-turn exact effect|≥90% общего eligible set и отдельно create/update/lifecycle/query/multi-action; все critical cases100%|
|Operation precision/recall|≥98% precision и≥95% recall поддержанных явных actions; partial multi-action case не считается full success|
|Unnecessary choice|0 для фиксированных clear creates без даты и clear existing mutations;≤5% остальных clear supported cases|
|Finite ambiguity|100% safety: no uncertain effect;≥95% correct grounded options|
|Meaning preservation under Privacy|100% critical polarity/target/date/action-scope; иначе denied;0 перечисленных forbidden payload leaks на проверенных fixtures; без гарантии универсального PII detection|
|Calls|ordinary successful supported text≤1 dialogue invocation; callback/query shortcut0; voice≤1 semantic invocation, STT separately counted;0 stylistic/repair/resolver AI calls|
|Denied route|Text denied→0 semantic dispatches/Task effects; audio denied до STT→0 STT dispatches. Transcript denied после STT не отменяет уже сделанный STT, но запрещает semantic dispatch/effect. Причина отказа явна; будущие локальные модели не launch gate|
|Audio|30 сценариев записей/отказов, разрешённые recordings≥3 speakers,5–120s+long/error samples; denied/error cases учитываются отдельно; WER≤15% на clean dictation, critical negation/target/time accuracy≥98%,0 unsafe mutation при потерянном critical span|
|Webhook/worker|p95≤200ms ingress; worker start≤250ms after commit; processing indicator≤500ms если transport capability действительно подтверждена|
|Text|p95≤10s inbound durable commit→final domain/response outbox commit; delivery observed отдельно p95≤2s при healthy MAX|
|Voice|p95≤30s complete download→final commit для clips≤120s; long2–20min отдельный profile, deadline90s, без clipping/ложного успеха|
|Privacy/context/application|p95≤500ms each для стандартного profile, Task deterministic p95≤1s (Stage2)|

Deadlines: standard dialogue7s, OpenAI STT18s (после download), media download10s/codec5s; общий standard text10s, voice30s после download. Long voice90s, source retained locally при отказе; не считать long cases в standard percentile, публиковать обе выборки. Deadline не меняет relative dates или снимает safety guard. Счётчик задержки включает очереди/Privacy/routing, не только provider RTT. Latency report содержит sample size/counts/errors/call counts/cost/route/profile versions и environment; external failures не выкидываются из completion-rate. Percentiles success-only публикуются отдельно от all-turn latency, текст success rate≥95% на утверждённой здоровой eval среде.

Real audio assets отсутствуют в этом проектировании: [корпус](../corpora/2026-10-14-max-assistant-stage-3-dialogues.md) содержит30 scripts/manifest requirements, **не запись и не STT PASS**. Перед live gate понадобятся разрешённые записи/route admission; не загружать старые private production recordings автоматически.

Live MAX acceptance при первых кнопках обязательно закрывает отложенный callback-canary: настоящий выбор пользователем, exact private webhook replay, повтор той же option с новым callback id, stale revision/чужой token, counts/effect/outbox/confirmed reply; safe participant и TEST bot. Реальное voice→download→STT→meaning→Task и text create/update/complete также проверяются. Callback-canary проводится на checkpoint65; text/voice end-to-end с разрешёнными OpenAI profiles — на checkpoint70. Для callback-canary65 допустим фиксированный process-local FakeSemantic, создающий неоднозначный выбор в изолированной конфигурации TEST bot: реальные MAX message/button/callback, PostgreSQL, Task effect и доставка остаются настоящими. Это проверка транспорта и атомарности выбора, не доказательство качества OpenAI; публичный test header или endpoint для подмены решений запрещён. Synthetic/FakeMAX не закрывает callback exception. Runtime default-off до разрешённого release profile; live host/domain/test bot/получатель и реальные аудио требуют отдельного разрешения. Ранний синтетический текстовый probe53 уже разрешён пользователем после принятия документов. Кнопочный checkpoint нельзя объявить принятой внешней функциональностью с только synthetic proof.

## 11. Приёмочные сценарии и план

S01 input/graph/spans; S02 create vs mutation; S03 evidence/ownership; S04 targets outside pack; S05 mixed/related groups; S06 source-time/DST; S07 delivered anchors; S08 fresh topic vs choices; S09 tokenization/rehydration; S10 denied route/fail-closed; S11 audio pre-STT privacy; S12 safe download/codec/cleanup; S13 transcript reuse/critical spans; S14 one-call/deadlines; S15 staged run/lease/restore/uncertain dispatch; S16 groups+receipts+response intent atomicity; S17 finalizer/delivery recovery; S18 buttons/callback version+duplicate; S19 RLS/erase/retention/tombstones; S20 real semantic corpus; S21 real voice corpus; S22 latency/cost/backpressure; S23 real callback exception; S24 truthful MAX production opt-in and rollback. Соответствие iterations/checkpoints — [план Stage3](../plans/2026-10-14-max-assistant-stage-3-understanding.md).

Одно внешнее смысловое решение вместо legacy Understanding→Planning→repair→style. Уменьшаем число сетевых шагов, но делаем локальный validator/Context/Privacy более строгими. Независимые groups дают полезный частичный результат, поэтому final response отделён от первого group commit и имеет durable continuation intent. OpenAI text/STT сокращают объём запуска. Цена этого решения: локальные privacy-проверки ограничены, а разрешённый STT получает саму запись до text Gateway; этот риск отражён в audio policy, а не скрыт обещанием анонимизации. Кнопки заменяют необходимый конечный выбор, а не диалог целиком.

Документы ждут принятия. Сейчас изменяются только три документа. После принятия предусмотрен ранний probe53 в разрешённых пределах; реальные пользовательские данные, аудио, canary и deployment им не разрешаются. Реализацию Stage3 и последующий этап сейчас не начинать.

Принято владельцем2026-10-15. Разрешён только блок51–55, включая один ограниченный probe53; остальные блоки требуют отдельного разрешения.

Уточнение53 от владельца2026-10-15: C034 теперь содержит «на завтра», обязательны независимый Create и сохранённый dated Update draft для выбора цели. Исходный no-date перенос — C101, выбор цели не восполняет отсутствующую дату, пустой Update не исполняется. Полностью полученный невалидный ответ имеет outcome `invalid` и безопасный reason code с доступными usage/duration; только транспортная неопределённость — `uncertain`. Разрешена attempt2 на прежней модели,12 новых calls/≤USD2, после локального replay первой попытки и новой заморозки.
