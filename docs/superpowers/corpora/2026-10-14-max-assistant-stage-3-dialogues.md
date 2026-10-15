# Stage3 — корпус диалогов и голосовой manifest

Дата2026-10-14. Это обезличенные oracle-сценарии для реализации/eval, **не результаты проверок**. Нет private production payloads или audio files. C001–C100 — регрессионные сценарии, доступные разработчику и допускаемые для настройки. C081–C100 также регрессионные: прежнее название holdout снято. Независимая контрольная выборка H001–H020 хранится отдельно от regression/prompt fixtures; её примеры и результаты не используются для настройки, порядок определён ниже. Fixtures в будущем материализуются из этих описаний в изолированной PG, с hash/version manifest. Исходные natural-language cases отдельно от injected provider/fault/privacy assertions; знаменатели не смешивать.

## Источники и адаптация

- B1: [старый mandatory regression pack](../../../../echo-secretary/docs/quality/mandatory-regression-pack.md), §§1,2,8,10: copied completion, completion artifacts, CTA, voice.
- B2: [real-AI eval20260919](../../../../echo-secretary/docs/quality/conversation-v2-real-ai-eval-20260919.md), c01–c12. Старый запуск failed и не является semantic PASS. Legacy universal confirmation, merge/recurrence/calendar не переносим.
- B3: [intake improvement spec](../../../../echo-secretary/docs/specs/natural-language-intake-improvement-spec.md), incident141, §§5,7,8,11: весь utterance, scope/time, negatives, next-topic, privacy/faults.
- B4: [sanitized voice temporal fixture](../../../../echo-secretary/tests/fixtures/voice-temporal-intake-incident.json): source2026-09-11T12:48:33Z/Moscow, exact/date-only смешение.
- N: новые MAX/Privacy/Task-domain boundary случаи, выведенные из архитектуры/Stage2; не выдаются за production-инциденты.

Общее: user A, conversation A; source2026-09-11T12:48:33Z, Europe/Moscow (local15:48 Friday), unless overridden. T1/T2 — fixture aliases для разных Task UUID, open/v1 по умолчанию. «Создать N» означает ровно N Tasks/create events; «изменить Ti» — только тот UUID,+1/event; no_change/replay —0 events. Остальные Tasks неизменны. B=число choice components (не кнопок); если B не указан, B=0. Любой ответ о применении строится из committed receipts. Многошаговая строка проверяется после **каждой** реплики; не только итог.

Режимы: R — реальный OpenAI semantic provider (no injected result); V — fake validated provider output/validator adversary; F — fault/concurrency integration; P — local privacy assertion. Real-text full corpus проходит R cases, остальные фиксированные guards идут default tests без внешних calls. Полный corpus manifest содержит все100; отсутствие обязательного guard означает corpus gate incomplete. Precision/recall/first-turn score считается только по R supported task cases; unsupported/quote/query имеют отдельные знаменатели. Safety assertions обязательны во всех режимах.

|ID|Источник/режим|Предусловие и последовательность|Точный oracle|
|---|---|---|---|
|C001|B2c01/R|«Приготовить обед, забрать ребёнка из садика в три часа дня, отвезти его на кружок»|Create3; pickup15:00 local (past допустим); время не переносится на остальные|
|C002|B1/R|«Купить молоко»|Create1 без дат; никаких choice|
|C003|B2/R|T1 «Молоко»; «Создай ещё задачу купить молоко»|Create1 distinct UUID; T1 unchanged; no semantic dedup choice|
|C004|B3/R|«Завтра отчёт, сегодня позвонить бухгалтеру, в воскресенье парикмахер в19»|Create3 с11/12/13 сентября согласно собственным scopes;19:00 только у парикмахера|
|C005|B3/R|«В10 встреча, нет, в11»|Create1 scheduled11:00, не2 Tasks|
|C006|B4/R|«Сегодня в16 часов сдать отчёт, в течение завтра сдать показания счётчиков, в воскресенье на19 записался к парикмахеру. Зафиксируй»|Create3: scheduled13:00Z/target11; date-only12; scheduled16:00Z/target13; no missing-hour choice|
|C007|B3/R|«Вчера встреча закончилась; сегодня в10 интервью и в19 вокал; основные задачи напишу позже»; T1 «Встреча» yesterday|CompleteT1; Create2 с собственными times; meta fragment не Task|
|C008|B3/R|«Сейчас9:30, задачи напишу позже»|0 Tasks/choices, короткий context acknowledgement|
|C009|B3/R|«Фокус пока не определил»|0 Tasks; не назначать focus|
|C010|B3/R|«Может, схожу на вокал; пока не планируй»|0 Tasks; не inferred schedule|
|C011|B1/R|«Если принял — ставь сердечко» (чужая цитата)|0 Tasks; CTA не command|
|C012|B3/R|«Идею сохрани, делать пока не надо»|0 Tasks; source retained, честно без memory-item обещания|
|C013|B3/R|«Не создавай задачу про отчёт»|0 Tasks|
|C014|B3/R|«Не могу подтвердить, что договор готов»; T1 договор|T1 unchanged; no complete|
|C015|B3/R|«Менеджер написал: “закрой договор”, но я его ещё не закончил»; T1 договор|T1 unchanged; чужая цитата/отрицание не mutation|
|C016|B3/R|«Сделал первое, второе перенеси на завтра»; delivered anchor[T1 отчёт,T2 звонок]|CompleteT1; moveT2 date12, own instant если есть переносится с сохранёнными local hours; чужой порядок не пересчитывать|
|C017|B1/R|delivered text «1. Отчёт;2. Счётчики» mapsT1/T2; user копирует и добавляет «сделано»|Complete2existing;0 Creates|
|C018|B1/V|current «Отчёт сделан»; fake Create «Отчёт — пометить выполнено»|Validator rejects completion artifact;0 Tasks/effects|
|C019|B3/R|«Всё сделано»;10 несвязанных открытыхTasks без bounded anchor|0 complete; объяснить отсутствие ограниченной цели, не10 choices|
|C020|B3/R|delivered anchor толькоT1; «Её заверши»|CompleteT1; no confirmation|
|C021|B3/R|previous outboxT1 pending/not_sent; «Её перенеси»|Не использовать недоставленный anchor;0 mutation при отсутствии другого basis|
|C022|B3/R|delivered previous[T1,T2]; «Её перенеси на завтра»|B=1, optionsT1/T2;0 mutations|
|C023|B2c03/R|T1 «Вокал» exact reply; «Перенеси вокал сегодня на19:30»|UpdateT1 to16:30Z/source-day;0 Create|
|C024|B2c12/R|T1 «Заказ лотков» существует; «Лотки заказать завтра в9» без mutation/ref|Create1 scheduledAt2026-09-12T06:00:00Z/targetDate12; deadline отсутствует; T1 unchanged; legacy auto-update не переносить|
|C025|B2/R|T1 «Лотки»; «Перенеси заказ лотков на завтра в9»|UpdateT1 scheduled06:00Z/12 сентября;0 Create|
|C026|B2/R|T1/T2 «Звонок» с разными адресатами; «Перенеси звонок на понедельник»|B=1 options2withqualifiers, no guessed target|
|C027|B3/R|«Перенеси встречу с архитектором»;0matches|not_found explanation;0 Create/choice|
|C028|B3/R|Task outside initial50 pack, title+date exact query; «Заверши договор за10 сентября»|Bounded resolver finds exactTi, Complete;1AI max|
|C029|B3/R|«Отмени звонок»; T1 cancelled/v2|no_changeT1;0 event; no Create|
|C030|B3/R|«Верни отменённый созвон»; T1 cancelled/v2 single|ReopenT1/v3 sameUUID/dates|
|C031|B3/R|T1 completed/v2; «Исправь название завершённого отчёта»|invalid_transition, no silent Reopen|
|C032|B3/R|T1 completed/v2; «Верни отчёт и переименуй в Финальный»|One atomic Reopen+UpdateT1 ->v4/2events|
|C033|B3/R|«Создай подготовку вопросов и переименуй её в Вопросы интервью»|One Create+local Update ->oneTaskv2|
|C034|B3/R|«Купи молоко и перенеси звонок»;2 звонка|Create молоко;B=1 звонки;no partial move/rollback milk|
|C035|B3/R|«Заверши отчёт и создай отправку документа»; exactT1|CompleteT1+Create1 independent groups; truthful both outcomes|
|C036|N/V|sameTask Update+Cancel split into allegedly independent groups|Combine related component or reject before writes;no half-effect|
|C037|N/V|Create+unknown created label/cycle in samegroup|Reject component, no earlier Create|
|C038|N/V|invalid overall JSON/unknown node label, one apparently valid Create|0 domain effects;no salvage/repairAI|
|C039|N/V|valid frame: independentCreate plus uncertain mutation|Create persists; uncertaincomponentno effect/B iffinite|
|C040|N/V|21 actions in input/model frame|bounded limit refusal; no first20 apply or silent truncation|
|C041|B3/R|pendingChoice звонок; new «Купить хлеб»|Create хлеб independently; old choice not consumed|
|C042|B3/R|pendingChoice звонок; new voice transcript «В19 вокал»|Create vocal; old choice unchanged|
|C043|B3/R|pendingChoice2; new unbound «Да»|0 mutation; not accept old choice|
|C044|B3/R|pendingChoice2; new unbound «Второй»|0 mutation; not choose old option|
|C045|B3/R|pendingChoice2; explicit reply to choice «Нет, перенеси только звонок Илье»|New turn explicit mutation/groundedtarget; supersede old component after commit; no ambient capture|
|C046|N/F|Choice revision1 superseded by2; callbacktokenrev1|0 effect, stale choice response|
|C047|N/F|callbacksamebody replay after successfuloption|same consumption outcome,0newTaskevent/outboxbusinessintent|
|C048|N/F|sameoption token clicked with newcallbackId|0second effect, bound already-consumed receipt|
|C049|N/F|B user/conversation submitsA token|deny,0cross-tenant read/mutation|
|C050|N/F|choiceTask changed version beforeclick|version_conflict;no latest-version overwrite|
|C051|N/F|expired24h choice|no effect;clear expiry answer|
|C052|N/R|«Покажи открытые задачи»|TaskQueries.open actualstate/read only, deterministic reply|
|C053|N/R|«Что у меня сегодня?»|Stage2 day source-local date, open default;no Task/AI style call|
|C054|B2c08/R|«Привет, что ты умеешь?»|Capabilities,0 Tasks;no forced clarification|
|C055|N/R|«Какая завтра погода?»|capability_unavailable;0 Tasks/buttons|
|C056|B2c10/R|«Напоминай каждый вторник в18»|reminders unavailable, noTask/recurrence promise|
|C057|N/R|«Создай звонок завтра и напомни зачас»|Create звонок; separate unavailable reminder; answer distinguishes|
|C058|B2c07/R|«Объедини два звонка и перенеси»|merge unsupported;dependent move blocked;0 guessing/delete|
|C059|N/R|«Перенеси всё из календаря»|calendar unsupported;0 Tasks|
|C060|B2c11/R|foreign quoted assignment+table/subpoints, no owner command|0 owner mutations; not extract all imperatives|
|C061|B3/R|Friday source «Во вторник в10 интервью»|nextTuesday15 сентября07:00Z, no exact-date guessing fromretry|
|C062|N/F|source23:59 local11сентября; retry12сентября; «Завтра звонок»|targetDate12, same accepteddecision replay; not13|
|C063|N/R|«До16 сентября сдать отчёт»|Create dueDate16;no scheduledAt23:59|
|C064|N/R|«Завтра к девяти отправить отчёт»; равнозначный вариант «завтра к9»|Create deadline.at2026-09-12T06:00:00Z (09:00 Moscow); scheduledAt отсутствует, targetDate12 из явного завтра; B=0|
|C065|N/R|sourceBerlin2026-03-28; «Завтра встреча в2:30»|nonexistent local time;0 instant effect;not3:30silent|
|C066|N/R|sourceBerlin2026-10-24; «Завтра встреча в2:30»|B=1 twovalid offsets;0 guessed time|
|C067|N/R|«29 февраля2028 позвонить»|Create validdate;«31 февраля2028» variant rejected0effect|
|C068|N/R|T1 scheduled10:00 today; «Поменяй только дату списка на завтра, время встречи не трогай»|targetDate12 only, scheduledAt unchanged|
|C069|B3/R|«Встреча была вчера, не переноси»; exactT1|No schedule mutation/automatic rollover|
|C070|N/R|«Купить хлеб завтра; отчёт до пятницы»|Shared scope not borrowed: bread12; dueDate nearestFriday11 by sourceweekdayrule|
|C071|N/P|known local profile name «Анна»; owner «Позвонить Анне по+70000000000»|Names/phone tokenized before external; actual local Task restored;0mapping/IDleaks|
|C072|N/P|Task candidate contains email user@example.test; currentquery neutral|Classify/minimizecandidate too, not only current input|
|C073|N/P|Current source явно помечен sensitive/health policy либо содержит запрещённый configured marker|denied до OpenAI;0dispatch/0effect, понятный отказ; не универсальный detector здоровья|
|C074|N/P|Два snippets содержат известные локально person/employer/address identifiers; policy запрещает передачу сочетания|Общий pack минимизируется/known values заменяются метками либо denied; raw сочетание не передаётся. Для неизвестной косвенной реидентификации гарантия detection не заявляется|
|C075|N/P|Детерминированная проверка/SourceMap падает либо policy требует отсутствующего полного content analysis|denied/безопасный отказ;0network classify/semantic effect; отсутствие локальной модели не блокирует другие разрешённые маршруты|
|C076|N/V|provider returnsunknownTOKEN/tasklabel orpreviousrunlabel|reject rehydration;0effect;no raw errorfeedbacksecondcall|
|C077|N/P|Proper names masked; negation/date/reference relationship lost duringminimization|denied,0AI/effect, не weakmaskedmutation|
|C078|N/P|Нет audio opt-in/разрешённого profile, metadata looks harmless; вариант declared prohibited content|denied до STT;0externalSTT; текстовое разрешение/codec не заменяют audio policy|
|C079|N/F|alreadydurable transcript, workerrestart|reuseexacttranscript;0secondSTT;oneeffect|
|C080|N/F|precommitdisconnect, postcommitlostACK, finalizercrash three variants|rollback/replayoriginal/groupcontinuation;no duplicateeffects/finaloutbox|
|C081|B3/R regression|«Подготовить смету, договор не закрывай, а у звонка завтра поменяй время на11»;T1договор/T2звонок|Createсмета;T1unchanged;UpdateT2explicit11;negative span notlost|
|C082|B3/R regression|delivered replyT1 счёт;«Тот, что прислал, оплачен; теперь нужно скачать чек»|CompleteT1+Createчек;notmoneytransfer/billingoperation|
|C083|B3/R regression|«Пока не нужно ничего заводить. Я думаю между выставкой и поездкой»|0Tasks/buttons;notfinitechoicebecause noaction intent|
|C084|N/R regression|«Создай: анализ рынка и звонок. Если звонок нельзя перенести, анализ всё равно сохрани»;existing2звонка|Whole utterance conflicting create/move звонок => unresolved звонок component;Createанализ1, no guessed secondCreate/move|
|C085|B3/R regression|exactreplyT1;«На следующую среду, а название оставь»|UpdateT1schedule/date2026-09-16;titleunchanged;noCreate|
|C086|B3/R regression|Deliveredlist[T1,T2], thennewTaskT3changescurrentSQLsort; «Закрой второй из присланного списка»|CompleteT2 fromfrozenanchor;T1/T3unchanged|
|C087|N/R regression|«Встречу с инженером отменяем, на вторник новую с дизайнером»;T1engineer|CancelT1+Createindependentdesigner15сентября; preservedifferent participants|
|C088|B3/R regression|T1cancelled;«Эту отмену пока не откатывай; скажи, когда мы её отменили»|ReadhistoryT1;noReopen|
|C089|N/R regression|«Оба отчёта готовы»;qualified deliveredanchorT1/T2twoownedreports|Completeboth;no genericconfirmation|
|C090|N/R regression|«Встреча не закончена, закончена только подготовка»;T1meeting/T2prep|CompleteT2;T1unchanged|
|C091|N/R regression|T1deadline14;«Убери срок, само дело оставь»|Clear deadline only, sameUUID/title/status|
|C092|N/R regression|«Завтра дел не добавляй, покажи уже назначенные»|Queryday12 only;noCreate|
|C093|N/R regression|«Не напоминай — просто запиши купить батарейки»|Create1;no reminder cap message/choice unless asked|
|C094|N/R regression|«Удалить задачу Звонок клиенту»;exactT1|Cancel recoverable, not hardDELETE|
|C095|N/R regression|«Покажи завершённые дела, назначенные на сегодня»|ReadDay/statuscompleted/source-day predicates;0 mutations|
|C096|N/R regression|«В четверг нужно сдать акт, а встреча в четверг уже состоялась»;T1sameentitydatepriorThursday|Createact nearest17; CompleteT1pastThursday10 fromassertedexistingmeeting result; scopes notborrowed|
|C097|N/R regression|exactTasktitle contains«не закрывать отчёт»;user«Отмени задачу “не закрывать отчёт”»|Cancel exactTask;negation insidequotedtitle notnegationofownercommand|
|C098|N/R regression|«Позвонить завтра. Нет, это я цитирую старое сообщение, ничего не сохраняй»|0Tasks;finalselfcorrection applieswholequotedaction|
|C099|N/R regression|«Перенеси встречу из ответа неделю назад»; exactreplyTaskT1outside48h|ResolveexactreplyT1;no broadhistorydump/secondAI|
|C100|N/R regression|pending3choices;user«Сохрани отдельно поездку; со старыми вариантами позже разберёмся»|Createпоездка1;noneof3choicesconsumed;normalreplywithoutbuttons|

C084 deliberately ambiguous, correct unresolved component is the oracle; first-turn success denominator excludes its ambiguous component but requires saving independent analysis. C085 absolute date is2026-09-16. C095 refers to assigned Task dates, not completion timestamp: use existing Stage2 day/status query, never foreign SQL.

Privacy suite expands C071–C078 детерминированными проверками известных identifiers/secrets/policy flags; не доказывает обнаружение всех PII/categories; all expansion cases are versioned separately, not inflated natural-language score. Fault suite expands C046–C051/C062/C079–C080 with lease/restore/erasure/outbox cases. Unsupported calendar/merge/reminder cases explicitly remain no-effect; legacy branch acceptance requirements are not imported as Stage3 features.

## Ранний OpenAI probe53: фиксированные12 регрессий

Набор до основной реализации: **C003/C024/C025/C013/C015/C016/C034/C020/C041/C043/C005/C064**. Он проверяет Create vs Update (включая одинаковое название), отрицания/чужие цитаты, несколько действий, delivered references, новое сообщение/«да» при old choice, self-correction и «к девяти» как deadline. Context/candidates/anchors/pending choices полностью синтетические; voice transcripts здесь лишь текст, аудио не отправляется. Эти случаи регрессионные, не независимый контроль.

Перед запуском51–53: зафиксировать exact source/Task aliases/versions, expected unchanged/operations/choices, prompt/schema/privacy/model hashes, current official pricing и manifest. **Максимум12 semantic dispatches,1/case, USD2 всего,12000input/2000output tokens/request**, retriesoff. Если worst-case оценка не укладывается — не запускать/не повышать потолок автоматически. Existing API key читается из разрешённого файла секретов только в памяти transport adapter; значение не выводится/не копируется/не создаётся заново. Публичный отчёт содержит case IDs, исходы, call counts/latency/usage/cost, без credentials.

Приёмка probe: safety100% (no mutation→Create/negative/quote effect/wrong target/old-choice capture, корректное количество действий, C064 deadline), full oracle≥11/12. Один проход, все результаты учитываются. Это feasibility proof на малой выборке, не90% statistical quality gate. Fail/collector failure/uncertain call — отчёт и stop до54, дополнительный внешний probe только после согласования. Текущее разрешение пользователя применяется на53 **после принятия документов**, не к сегодняшней правке.

## Независимая контрольная выборка H001–H020

Контроль не составляется из переименованных C001–C100, их перефразирования после просмотра ошибок или probe outputs. До настройки на51 фиксируется отдельный приватный manifest20 случаев независимого источника (владелец или заранее неиспользованные обезличенные диалоги), hash/input/oracle/source timestamp/context fixtures и provenance; snippets не входят в prompt examples/development fixtures. Реальных private production payloads в OpenAI control быть не должно. Состав:4create,4update,4lifecycle,4query/negative/quote и4multi-action; среди них есть previous-task reference и new input/old choice. Categories overlap для safety flags, но основной знаменатель20 unique cases.

Executor не использует H inputs/outputs для настройки модели/prompt/Privacy/порогов. Corpus runner открывает их только на финальном checkpoint70 после freeze, один запрос/case, сохраняет report отдельно от регрессий. Safety100%, exact-effect≥90% (≥18/20); малый размер и category counts публикуются, это не precision estimate с высокой статистической достоверностью. Если независимые fixtures отсутствуют, отметить quality evidence incomplete, не считать C081–C100 заменой. Результаты не используются для выбора лучшего из нескольких профилей. После раскрытия ошибки для ремонта случай становится регрессионным; повторный независимый gate требует новой контрольной выборки и согласованного бюджета.

Регрессионный real-text gate70 запускает R cases C отдельно от локальных V/F/P guards; H — отдельный report. Знаменатели supported exact effect/unsupported/negative/query/denied/errors прозрачны, partial multi-action не full success. Финальное разрешение/бюджет не наследуются от probe: плановый потолок≤150semantic dispatches и≤30STT, денежный предел согласуется до70.

## Голос:30 сценариев записей/отказов, реальные записи ещё нужны

Audio manifest (private outside Git): opaque Axxx ID, recording consent/allowed processing route, speaker alias≥3 distinct, duration/codec/checksum, source timestamp/timezone, manual transcript, critical spans (negation/task target/date/time), expected C oracle. Raw sound/имена/consents не публикуются в Git; evidence содержит только aliases/counts/hash/outcome/latency. Не использовать production voice без отдельного разрешения. Transcript-only replay не считается STT success.

|IDs|Текст/сценарий записи и oracle|
|---|---|
|A01–A03|C001 три дела; три разных диктора,5–30s, pickup15:00 не потерять|
|A04–A06|C006 mixed exact/date-only, три диктора, до60s|
|A07–A09|C016 completion+move, три диктора, delivered orderedanchor|
|A10–A12|C005 self-correction10→11, три диктора|
|A13–A15|C014/C015 negative completion и чужая цитата; разные дикторы|
|A16–A18|C042 новый голос при oldchoice; разные дикторы|
|A19–A21|C063/C064 deadline vs scheduledAt, разные дикторы|
|A22|C032 Reopen+Update, sameTasktwoeffects|
|A23|C081 long mixed utterance>120s; сохранены всеunits/negative|
|A24|C066 ambiguous DST; no guessed offset|
|A25|C071 synthetic names/phone, только qualifiedaudio route; literalidentity preservedlocal|
|A26|C073 declared sensitive-health audio: policy denied,0STT/semantic calls; проверка refusal, не WER sample|
|A27|Noise obscures critical«не»; no unsafecompletion, honestcriticaluncertainty|
|A28|Truncated recording/unreadable codec; safe failure/source status/cleanup|
|A29|Long2–20min dictation withclear supportedunits, no truncation; separatelatencyprofile|
|A30|Sameallowedrecording replay/restart aftertranscriptcommit;0secondSTT/effect|

Clean STT WER denominator excludes deliberately corrupted A27/A28 и policy-denied A26; A23/A29 не входят в standard≤120s latency percentile; critical-span safety включает их. Разрешённые записи идут в OpenAI STT без предварительного local ASR; audio policy/consent проверяются до передачи файла. Собственное содержание и голоса не гарантированно классифицируются до отправки. Затем common text Privacy/semantic/Tasks pipeline. Неразрешённая запись не отправляется даже для теста; автоматического повторного голосового уточнения нет. Успешный external transcript не отменяет local text Privacy Gateway.

Принято владельцем2026-10-15. Разрешён только блок51–55, включая один ограниченный probe53; остальные блоки требуют отдельного разрешения.
