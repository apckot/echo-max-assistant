# Stage3 — локальная подготовка67/70 завершена,2026-10-17

**Локальный кандидат готов к внешней приёмке (`codeReady=true`). Stage3 не завершён (`stageComplete=false`).** Открыты реальный callback-canary с повтором, sandbox-кодек, независимый H-контроль и разрешённые записи, реальные quality/latency и MAX-сценарии. Stage4 не начат.

Проверенный code SHA: **b1d30d6deca1e0743a6b4619df42ca06081a5db4**. Публикация после него меняет только документы и evidence. [Машиночитаемый отчёт](stage-3-local-preparation-verification.json), [frozen profile](stage-3-final-profile.json). Прежние неуспешные gate/load/scan сохранены в [историческом checkpoint70](stage-3-checkpoint-70.md) и не переименованы в PASS.

## Все78 публичных R-сценариев

[Материализованный корпус](../../tests/fixtures/stage3/r-application.json): исходный ввод, время/часовой пояс, начальные задачи со всеми полями и версиями, delivered/list/reply/pending-choice контекст, ожидаемые эффекты, финальные и неизменяемые поля, конечные варианты выбора и результаты чтения. Точные78ID и provenance сверяются со старым регрессионным инвентарём. C011 сохраняет чужую атрибуцию; C099/C101 без даты не выдумывают перенос; C045 использует дату явно отвеченного компонента, не старого фонового уточнения. Альтернативные локальные формулировки C064/C067 сохранены как варианты, не дополнительные live dispatches.

[Collector](../../tests/semantic/application-collector.ts) подключён к настоящим application/Tasks/PostgreSQL: событиям и истории, receipts, финальным задачам, pending options, processing receipt и outbox. Сверяются возвращённые строки списка и history snapshots/versions, неизменяемые поля/identity/timestamps, количество эффектов, committed outcome wording, точные refs кнопок и отсутствие второго ответа после finalizer replay. Ошибочные дата, сохранённое имя, лишнее создание, устаревший status строки и ложное сообщение об успехе обнаруживаются автоматически. Нормализация эфемерных create labels допустима только по точному полному совпадению содержимого; смысл/даты/цели не исправляются.

**78/78 механизмов PASS** в финальном gate: [полные наблюдения](stage-3-final-r-mechanism.json). По умолчанию доверенный typed-plan adapter входит в durable group execution/finalizer и настоящий Tasks; это не проверка понимания модели/grounding/resolver/normalizer. Отдельный provider-port путь проходит настоящий coordinator/Privacy/grounding/validator/resolver/normalizer; положительный FakeProvider и ошибочная дата проверены локально. `modelEligible=0`, `qualityQualified=false`, external calls0. Ни новый AI-тест, ни78-model PASS не заявляются.

## Нагрузка и причина прежнего зависания

[Диагноз](stage-3-load-timeout-diagnosis.json): прежний запуск начался18:41:11MSK; журнал питания фиксирует Sleep18:41:52 на269s и DarkWake18:46:21. Сам сон превышает неизменный лимит240s; прежних phase metrics нет, поэтому точное число прежних эффектов неизвестно и все возможные дополнительные bottlenecks не исключаются.

Новый журнал начинается до контейнера и сохраняет подготовку, seed, приём/обработку, очередь, вызовы/ошибки и cleanup; heartbeat и последний прогресс сохраняются при тайм-ауте. Диагностический SQL имеет отдельный read-only pool: server statement500ms/lock250ms, connection500ms/client750ms; ошибочный client уничтожается, probe завершается до cleanup. Обычное падение не переименовывается в timeout и не стирает причину/подтверждённый cleanup. `pg_sleep(30)` отменяется с57014, heartbeat/ограниченный cleanup проверены. Старый hook воспроизведён RED на утрате LOAD_PROCESSING_FAILED/cleanup, исправленный — GREEN.

После успешного малого smoke выполнен **ровно один разрешённый повтор полного исходного профиля** под Node22.23.3 и временным caffeinate. Системные настройки и sandbox не менялись; профиль/тайм-аут не сокращались и не увеличивались.

|Показатель|Фактический результат|
|---|---|
|Профиль|1000tenants×5Tasks;2workers×4slots;160events,1RPS60s+10RPS10s;25%voice;FakeAI1s/FakeSTT5s|
|Результат|160/160processed;143semantic/created;40STT/transcripts;17local queries|
|Ошибки|0processing failures/failed turns/blocked groups|
|Время|prep29774ms;total128093ms при лимите240000ms|
|Слоты|maxAI3/maxSTT2 на worker; лимиты4/2|
|Cleanup/evidence|complete;754snapshots;maxheartbeatgap1001ms|
|Mixed orchestration p95|20259ms, включая burst/queue; это не live text/voice latency|
|Внешние вызовы|0|

[Метрики и промежуточные фазы](stage-3-final-load-evidence.json), [полный фазовый журнал](stage-3-final-load-phases.jsonl). Дополнительного полного load не было.

## Одно подтверждение review, один финальный gate и scan

Тот же `/root/checkpoint70_review` проверил только согласованные доработки, затем подтвердил закрытие4P2: поля query rows/history, outcome wording, ограниченная SQL-проба, сохранение причин ошибок/cleanup. Новый общий аудит/reviewer/исполнитель не запускались.

Один финальный чистый clone: npm ci, typecheck, architecture guard, build, один image build и один npm test — **115файлов/849тестов PASS**,0failed/0pending,277.31s. Functional/e2e/image smoke/physical restore вошли один раз; отдельных functional/review-focus/restore команд не было. Clone чист до/после, whitespace/TODO проверки PASS. Один случайно начатый дублирующий целевой Node22 запуск был немедленно отменён после появления результата исходного targeted run; как дополнительное evidence он не используется. Полные прогоны сверх разрешённых не запускались.

[Restore](stage-3-final-restore.json): accepted decision/group receipt/transcript переиспользованы, expired choice retired;0новыхAI/STT/вторых эффектов. RPO0ms/RTO11174ms в изолированном локальном fixture; production-storage qualification не заявляется.

**Финальный Gitleaks PASS:** вся история153commits и tracked archive,0findings, на docs/evidence SHA81042ad; source после проверенного code SHA не менялся. Сохраняется default generic-api-key rule; исключение требует точное синтетическое значение И конкретный тестовый path. Нет глобального path allowlist, исключённых коммитов/истории или отключённых правил; inline ignores отключены. Невыданный ключ похожей формы в том же файле и исходное synthetic значение в другом файле по-прежнему обнаруживаются. Настоящий ключ для проверки не читался. Конфигурация [.gitleaks.toml](../../.gitleaks.toml); hashes/exit codes в [verification](stage-3-local-preparation-verification.json).

## Отдельно отсутствуют независимые примеры и разрешённые записи

- **H001–H020:** независимые, не использованные для настройки private source/provenance, frozen initial tasks/context/typed expected effects/unchanged fields/choices, timestamps/timezones, hashes и non-tuning declaration. R не переименовывается в H; разработчик не подменяет независимый контроль собственными регрессиями.
- **A01–A30:** private manifest/разрешённые assets (A30 повторно использует A01),≥3согласившихся speaker aliases, ручные транскрипции и critical negation/target/time spans, checksum/duration/codec и разрешение processor/route/category/retention для каждой записи. A26 — отказ до отправки, A28 — повреждение/локальный отказ, A30 — saved transcript/0новых вызовов. Записей и разрешения на них сейчас нет; production recordings не читались.

[Единый конкретный внешний запрос](../runbooks/stage-3-acceptance.md) отдельно перечисляет существующий TEST bot/host/domain/recipient для подтверждения, процедуру изолированного настоящего кодека и запрос125semantic/27STT/USD10 с доказанным пределом расходов. Это не разрешение. Старый namespace-policy блокер кодека открыт; голос не готов к выпуску до успешного sandbox-декодирования. Реальный MAX callback и точный повтор остаются обязательными. Полные live R/H/audio quality/latency и MAX text/voice сценарии не выполнены.

В этом цикле:0реальныхAI/STT/MAX,0пользовательских записей,0серверных изменений/развёртываний. Посторонний untracked network diagnostic не изменён, SHA256 d596baa6203db961ea83317b09ad60e1a6cf1bbd71388db3a9e3369d08963ade. Остановка для внешней приёмки Stage3; Stage4 не начинать.
