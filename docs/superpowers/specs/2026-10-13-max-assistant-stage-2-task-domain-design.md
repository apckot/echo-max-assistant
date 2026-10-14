# Echo MAX — Stage 2: домен задач

Дата: 2026-10-13. Статус: **принято владельцем 2026-10-13; checkpoint40 принят2026-10-14, блок41–45 выполнен, checkpoint45 проверен2026-10-14; остановлено перед46 до принятия владельцем**.

## 1. Результат и источники решений

Stage 2 даёт один проверяемый Task Domain: типизированное создание, изменение, перенос,
завершение, отмена, восстановление, чтение и история задач. PostgreSQL — источник истины.
Будущие MAX-диалоги, AI tools и Mini App вызывают один application API. Домен не понимает
свободный текст, не отправляет сообщения и не знает канал или AI-провайдера.

Приоритет источников:

1. [Архитектура нового MAX-ядра](/Users/epictetus/Documents/MW/echo-secretary/docs/superpowers/specs/2026-09-30-max-assistant-core-architecture-design.md), особенно §§5–6, 8.3–8.4, 10–11, 21–22.
2. [Реализованный foundation](../../architecture/foundation.md), [принятый checkpoint 35](../../progress/checkpoint-35.md), актуальные глобальные и проектные AGENTS.md.
3. [Старая продуктовая спецификация](/Users/epictetus/Documents/MW/echo-secretary/docs/product/mvp-product-spec.md) и [контракт ценности](/Users/epictetus/Documents/MW/echo-secretary/docs/product/product-value-and-ai-contract.md): только совместимые правила и сценарии.

Исходный Git: `a4543b7` (`docs: accept Stage 1 and track project agent instructions`),
рабочее дерево до проектирования чистое; 23 миграции. Stage 1 завершён 2026-10-13.
Реальный callback и его точный повтор остаются **не проверены**, с принятой оговоркой;
их обязателен живой canary на этапе появления кнопок (предположительно Stage 3).
Stage 2 кнопок не вводит и эту оговорку не закрывает.

Из старого продукта сохраняются: создание без даты; явное намерение владельца; отсутствие
мутации из отрицания, цитаты или чужого текста; раздельные дата/срок/напоминание;
recoverable отмена; append-only история; локальная timezone; результат только по committed данным.
Не переносятся semantic types, waiting/parked/review_needed, люди, сферы, группы, day focus,
автоматический carry-forward, Rich reconciliation, продолжение draft обычным текстом,
Telegram IDs и entitlement. Они противоречат простому MAX MVP либо выходят за Stage 2.

Не входят: NLP/Resolver, AI/STT, кнопочные choices, reminders/jobs и их доставка, дневные
сводки/attention ranking, платежи, Mini App/API/auth нового клиента, календарь, импорт,
операторский CLI для изменения задач. Реальные MAX text/voice сохраняют foundation-поведение.
Typed test harness — средство проверки application API, не новый пользовательский канал.

## 2. Выбранный подход и компромиссы

Выбран current-state aggregate + неизменяемые события + неизменяемые receipts команд.
Это проще event sourcing: чтение не требует воспроизведения журнала, но история и доказательство
повтора сохраняются. Один Tasks application service владеет правилами и единственным SQL adapter.
Отдельные writers для chat/API/AI запрещены. Общий SQL role сам по себе не доказывает владение:
его дополняют architecture guard и проверки привилегий.

Альтернативы отклонены: перенос старого WorkItem добавил бы неутверждённую сложность;
полный event sourcing добавил бы rebuild/snapshot/migration protocol без пользы для MVP.
Read models строятся SQL-запросами по текущим строкам, без cache/materialized views.
Нет второй копии состояния и механизма invalidation, пока он не нужен.

В архитектуре есть локальная коллизия: §10.1 упоминает outbox в Task Domain, а §8.4
запрещает конкурирующие подтверждения и назначает один финализатор. Здесь принят §8.4:
Tasks возвращает receipt/events, application orchestration ставит подтверждение через
существующий outbox в той же транзакции. Tasks не форматирует пользовательский текст.
Stage 3 сохранит decision до групп и финализирует общий ответ отдельно; Stage 2 не строит
этот AI pipeline заранее.

## 3. Агрегат Task и поля

Публичное имя — `Task`, таблица — `work_items` для согласованности с принятой архитектурой.
Все идентификаторы — внутренние UUID; версия в TypeScript — положительное safe integer,
в PostgreSQL `integer`, максимум 2147483647. Переполнение — `version_exhausted` без эффекта.

| Поле TypeScript / SQL | Тип и правило |
|---|---|
| `id` / `id` | UUID; назначается приложением при первой committed CreateTask; повтор возвращает тот же UUID |
| `userId` / `user_id` | UUID из проверенного tenant context; никогда из результата модели |
| `title` / `title` | строка, trim, 1–500 Unicode code points; переводы строк и управляющие символы запрещены |
| `description` / `description` | null либо строка до 10000 code points; trim, пустая превращается в null; LF/TAB разрешены, прочие управляющие символы запрещены |
| `status` / `status` | `open`, `completed`, `cancelled` |
| `targetDate` / `target_date` | null либо Gregorian `YYYY-MM-DD`: день, на который пользователь планирует дело |
| `scheduledAt` / `scheduled_at` | null либо UTC instant с точностью миллисекунд: точное начало; не длительность |
| `dueDate` / `due_date` | null либо календарный крайний день; не время 23:59 |
| `dueAt` / `due_at` | null либо точный UTC instant крайнего срока |
| `timezone` / `timezone` | обязательный валидный IANA timezone snapshot задачи |
| `version` / `version` | Create=1; каждый реальный command effect +1 |
| `createdAt`, `updatedAt` | DB clock; unchanged при no_change/replay |
| `completedAt`, `cancelledAt` | DB clock текущего terminal transition; только соответствующее статусу поле непустое |

`dueDate` — небольшое уточнение минимальной схемы архитектуры: крайний срок «до пятницы»
должен храниться без выдуманного часа. `dueDate` и `dueAt` взаимоисключающие. Нет duration,
priority, category, deleted flag, reminder offsets или AI confidence. Источник и actor живут
в событиях/receipts, а не дублируются в текущей строке.

Все nullable поля при Create по умолчанию null. Timezone по умолчанию берётся из snapshot
trusted command context, а не из mutable профиля на retry. Одинаковые названия допустимы:
две разные явные команды создания — две задачи; смысловая похожесть не дедупликация.

## 4. Время, дата и перенос

Диапазон календарных дат — 0001-01-01…9999-12-31; корректность проверяется без нормализации
несуществующего 31 февраля. Instant — RFC3339 с явным `Z` или offset, тот же диапазон,
не более трёх знаков дробной секунды; в публичном результате канонический UTC `Z`.
Никаких server-local Date parsers. База запрещает infinity/-infinity и лишнюю точность.

`targetDate` и `dueDate` — даты календаря задачи в её timezone, не UTC-полуночь.
`scheduledAt` и `dueAt` — абсолютные instants. Если оба точных времени заданы,
`scheduledAt <= dueAt`. Если задан `dueDate` и scheduledAt, локальная дата scheduledAt
в timezone задачи не позже dueDate. TargetDate может отличаться от этих дат: планировать
работу раньше срока нормально. Даты в прошлом разрешены — без автоматического переноса.

Relative time («завтра») и свободный текст разрешает последующий application temporal adapter
по immutable sourceOccurredAt + timezone snapshot. Stage 2 принимает уже разрешённые даты
или структурированный `LocalDateTime {date,time,timezone,offset?}` через публичный
`resolveLocalTime`: 0 подходящих instants → `nonexistent_local_time`; 2 и нет выбранного
валидного offset → `ambiguous_local_time`; неверный offset → `invalid_time`.
Для DST нельзя молча выбирать ранний/поздний час. Использовать Intl/IANA через изолированный
локальный infrastructure adapter и передавать результат чистому домену; не ставить новую
библиотеку без отдельного обоснования. При retry использовать сохранённый instant,
а не пересчитывать его по новой версии timezone database.

Перенос — `UpdateTask`, отдельный `MoveTask` writer не нужен:

- patch targetDate меняет только день плана;
- patch scheduledAt меняет только точное начало;
- patch deadline заменяет весь union: null / `{kind:'date',date}` / `{kind:'instant',at}`;
- patch timezone сохраняет instants и буквальные даты, меняет их календарное представление;
  проверяется новый итоговый schedule; никакого скрытого wall-clock пересчёта;
- чтобы сохранить локальные часы при переносе, caller явно разрешает новое LocalDateTime
  и передаёт итоговые instants вместе с нужными датами в одном UpdateTask;
- absent patch field = оставить; null = убрать; пустой patch = invalid_command;
  явный patch с уже такими же нормализованными значениями = no_change.

Смена timezone в Identity не переписывает задачи. Запрос локального дня использует timezone
запроса; date-only поля сравниваются как буквальные даты и возвращаются с timezone задачи,
точные времена входят по границам дня timezone запроса. Это сохраняет дни без точного часа
и позволяет показывать поездку без изменения хранимого расписания. Не вводится rollover.

Пример: scheduled=2026-10-14T12:00Z, timezone=Europe/Moscow, targetDate=2026-10-14.
Update targetDate=2026-10-15 оставляет scheduled=12:00Z 14 октября. Для переноса встречи
на 15 октября в 15:00 нужен явный scheduled=2026-10-15T12:00Z. Receipt показывает оба поля.
Date-only due=2026-10-14 просрочен с начала 15 октября в timezone задачи, точный dueAt —
строго при `now > dueAt`; отсутствие deadline не считается просроченным сроком.

## 5. Команды и переходы

`TaskCommand` — закрытый discriminated union:

- `CreateTask {kind:'create', localId, title, description?, targetDate?, scheduledAt?, deadline?, timezone?}`;
- `UpdateTask {kind:'update', target, expectedVersion, patch}`;
- `CompleteTask {kind:'complete', target, expectedVersion}`;
- `CancelTask {kind:'cancel', target, expectedVersion}`;
- `ReopenTask {kind:'reopen', target, expectedVersion}`.

`target = {taskId: UUID} | {created: localId}`. Локальная ссылка разрешена только на более
ранний Create в этой группе, уникальные localId 1–64 ASCII `[A-Za-z0-9_-]`; циклы,
forward refs, unknown refs запрещены. Existing target всегда точный UUID, поиск отдельно.
Update patch разрешает только title, description, targetDate, scheduledAt, deadline,
timezone. Status, tenant, version и timestamps через patch недоступны.

| Команда | open | completed | cancelled |
|---|---|---|---|
| Update | applied / no_change | invalid_transition | invalid_transition |
| Complete | completed, +1 | no_change | invalid_transition |
| Cancel | cancelled, +1 | invalid_transition | no_change |
| Reopen | no_change | open, +1 | open, +1 |

Create всегда open/version1; terminal timestamps null. Complete/Cancel сохраняют все даты,
пишут только свой terminal timestamp. Reopen сохраняет даты, очищает оба terminal timestamp.
Восстановление не возвращает старую revision и не переносит просроченную дату. Закрытую
задачу редактируют через Reopen + Update в одной группе с последовательными expectedVersion.
Удалить в обычной поверхности означает Cancel, физическое удаление — только privacy erasure.

Порядок проверки: tenant/account authority → shape/evidence → receipt replay → существование
целей → expectedVersion → transition → итоговые значения. Даже «уже выполнено» со старой
версией — version_conflict. Исключение только точный replay receipt, он возвращается до
проверки нынешней версии задачи. Новая команда no_change возвращает актуальную task snapshot,
но не событие и не увеличение версии.

## 6. Авторизация и evidence boundary

`TaskExecutionContext` строит trusted application caller: userId, actor=`owner|operator|import`,
source=`{kind:'typed',operationId}` или `{kind:'turn',turnId}`, sourceOccurredAt,
timezoneSnapshot и capability=`task_write` (read context — `task_read`). Stage 2 реализует только owner/typed и тестовый turn bridge;
operator/import зарезервированы и отклоняются `unsupported_actor` до отдельного этапа.
В доменном контексте нет MAX message/chat ID, prompt или provider payload.

Stage 2 application validator требует `ExplicitTaskIntent` для каждой команды:
operation kind, affirmative=true, asserted=true, ownerAuthored=true и binding target UUID
или local create label. Typed caller формирует это из явно выбранной операции авторизованного
владельца. Context tenant и evidence target должны совпадать с командой. У пользователя
нет возможности переопределить trusted actor/tenant сериализованным JSON.

Будущий conversation adapter дополнительно обязан доказать literal intent span текущего
immutable source и основание target: точная reference/context link либо выбранная сохранённая
кнопочная операция. Поисковая похожесть не является основанием. Отрицание, гипотеза, цитата,
forwarded чужой текст не авторизуют update/complete/cancel/reopen; никакого auto-create при
неудачном изменении. Create из переданного чужого контекста потребует отдельного explicit
owner adoption в Stage 3. Resolver, span extraction и проверка исходного текста — Stage 3.

Структурированное evidence не доказывает качество NLP. Stage 2 проверяет отказ на absent,
negative, quoted, uncertain, non-owner и target-mismatch evidence в typed fixtures; не
объявляет это реальным semantic eval. Public API получает context из authenticated composition,
не принимает флаг «trusted=true» от будущего AI/HTTP. Создание контекста находится только
на application boundary; pure transition functions не являются production writer.

## 7. Группы, receipts, повторы и гонки

`TaskCommandGroup {contractVersion:1, effectKey, commands}`: 1–20 команд, один tenant;
effectKey 1–200 ASCII `[A-Za-z0-9:_-]`, стабильный для одного принятого эффекта.
Одна группа атомарна, разные независимые группы независимы. Stage 2 реализует execute одной
группы; планирование независимости нескольких AI-групп и их финализатор остаются Stage 3.
Все команды по одной цели в группе выполняются в порядке массива; каждая expectedVersion
указывает версию после предыдущей команды (no_change её не меняет).

Receipt содержит receiptId, contractVersion, effectKey, исход `applied|no_change|rejected`,
упорядоченные command results `{index,kind,taskId,beforeVersion,afterVersion,outcome}`,
map localId→taskId, итоговые snapshots затронутых задач и error `{code,index?}`.
Для rejected applied results пусты: нельзя выдавать предварительный эффект за сохранённый.
Replay возвращает тот же receipt, включая исходные snapshots; актуальное состояние — GetTask.
`replayed` — transient envelope flag, не изменение immutable receipt.

Перед эффектами берётся transaction advisory lock по tenant+effectKey (hash collision только
сериализует). UNIQUE(user_id,effect_key) — окончательная защита. Канонический SHA-256 payload
включает contractVersion, команды после нормализации, actor/source, evidence и временной
snapshot; порядок массива значим, объектные ключи сортируются; исключены trace/deadline/
время retry и генерируемые DB timestamps/UUID. Канонизацию делает инфраструктура через порт.
Payload хранится локально в receipt для точного сравнения, не только hash.

Тот же key/тот же payload → тот же receipt. Тот же key/другой payload →
idempotency_conflict, существующий receipt не меняется. При application отказе с валидным
конвертом сохраняется rejected receipt; повтор с исправленными данными требует нового key.
Невалидный конверт/неавторизованный context не сохраняется. Infrastructure timeout,
lease/fence loss и DB error не создают terminal receipt: rollback и безопасный повтор
с тем же key. Lost COMMIT acknowledgement также разрешается только таким повтором.

Существующие task rows блокируются FOR UPDATE в UUID-порядке один раз на группу;
вся группа сначала вычисляется в памяти поверх locked snapshots. После полной валидации
пишутся current state, по одному событию на реальный command effect и один receipt.
CAS `WHERE user_id/id/version=expected` остаётся дополнительной проверкой, 0 updated rows
после lock — infrastructure invariant failure, rollback. Две команды разных клиентов
с одной expectedVersion: одна applied, вторая version_conflict; обе не могут победить.
Изоляции READ COMMITTED + locks + CAS достаточно, SERIALIZABLE не требуется.

Ошибки закрыты: invalid_command, invalid_title, invalid_description, invalid_time,
invalid_timezone, ambiguous_local_time, nonexistent_local_time, invalid_schedule,
invalid_evidence, unsupported_actor, task_not_found, version_conflict, invalid_transition,
idempotency_conflict, invalid_local_reference, group_limit_exceeded, version_exhausted,
account_unavailable. Чужой и отсутствующий UUID одинаково task_not_found без утечки.
DB failures возвращает infrastructure boundary как retryable failure, не user success.

## 8. PostgreSQL и изоляция

Новые миграции 0024–0026; старые применённые файлы не редактировать. На каждом шаге обновить
system_state.schema_version, runtime readiness expected version и проверки migrations.
Schema24 — tables/RLS; schema25 — task privacy erasure; schema26 — typed processing result.

| Таблица | Ключи, столбцы и ограничения |
|---|---|
| work_items | id PK, user_id FK users(id), UNIQUE(id,user_id); поля §3; CHECK status/version/text/calendar/time и terminal timestamps; timestamps NOT NULL |
| task_command_receipts | id UUID PK, user_id FK users, UNIQUE(id,user_id), UNIQUE(user_id,effect_key); contract_version=1, effect_key, payload_hash char(64), canonical_payload jsonb, result jsonb, source_kind, source_id UUID, actor, source_occurred_at timestamptz, timezone_snapshot, recorded_at DB clock |
| work_item_events | id UUID PK, user_id FK users, task_id UUID, receipt_id UUID, command_index integer 0..19, effect_kind=create/update/complete/cancel/reopen; before_version nullable только create, after_version; before_state jsonb nullable только create, after_state jsonb; recorded_at; UNIQUE(user_id,task_id,after_version), UNIQUE(user_id,receipt_id,command_index) |

FK (task_id,user_id) → work_items(id,user_id), (receipt_id,user_id) → receipts(id,user_id).
Snapshots содержат только полную модель §3, без свободного JSON provider metadata.
Event create: before=null, afterVersion=1; остальные after=before+1. JSON receipt/event
проверяется строгими versioned schemas application и SQL validator на ключи/типы/исходы.
Deferred constraint trigger проверяет на commit связь current version с последним event,
непрерывность новых версий, task/receipt tenant и соответствие command result; только runtime
Tasks adapter пишет согласованные наборы. JSON не заменяет FK и реляционные ограничения.
Source ID — opaque внутренний operation/turn UUID, без FK на technical inbound/будущие turns:
history не исчезает из-за технической retention. При turn bridge принадлежность source
проверяется orchestration в текущем guarded tenant transaction. Нет межканального external ID.

Индексы: `(user_id,status,created_at DESC,id DESC)`; partial open
`(user_id,target_date,id)`, `(user_id,scheduled_at,id)`, `(user_id,due_at,id)` и
`(user_id,due_date,id)`; events `(user_id,task_id,after_version DESC)` и
`(user_id,recorded_at DESC,id DESC)`. Search пока bounded substring, без pg_trgm/векторов.

На всех трёх таблицах ENABLE + FORCE RLS; SELECT/INSERT/UPDATE policies echo_worker:
user_id = NULLIF(current_setting('app.user_id',true),'')::uuid, USING и WITH CHECK.
UPDATE только work_items; receipt/events только SELECT/INSERT, UPDATE/DELETE запрещены
привилегиями и immutable triggers. Нет tenant setting → чтение пусто, запись запрещена;
malformed UUID → закрытый отказ. Gateway/delivery/scheduler не получают прямой доступ.
Migrator NOSUPERUSER/NOBYPASSRLS получает явные schema/erasure policies по принятому шаблону.
Проверять RLS на настоящих runtime roles, не только superuser test connection.

Immutable DELETE разрешён только внутри narrow SECURITY DEFINER privacy procedure, current_user
=echo_migrator + app.privacy_erasure=on; spoof GUC worker-ом не обходит запрет. PUBLIC EXECUTE
отозван, search_path=pg_catalog, имена полностью квалифицированы. Existing erase_account
расширяется новой migration: preview counts включает tasks/events/taskReceipts; finish удаляет
сначала events, потом receipts, потом tasks до users. Completed анонимный audit содержит только
счётчики; без текста, UUID задач и source. Техническая retention не удаляет ни одну из трёх
таблиц, включая закрытые задачи; до отдельной policy история живёт до удаления аккаунта. Snapshot restore не гарантирует сохранность команд после
точки snapshot/RPO: этот интервал остаётся explicit restore incident, не автоматический replay.

## 9. Транзакции и подключение к foundation

Domain: `src/modules/tasks/domain/` — Task, commands, normalize/validate/transition.
Application: `src/modules/tasks/application/` — TaskCommands, TaskQueries, evidence validator,
ports, group planner. Infrastructure: единственный Tasks PostgreSQL adapter в
`src/infrastructure/postgres/tasks/`; использует existing DbTx, но DbTx не пересекает domain/
application boundary. Runtime/test composition связывает adapter с владельцем Tasks.

Публичные signatures (DTO readonly, без pg/HTTP types):

- `TaskCommands.execute(context: TaskExecutionContext, group: TaskCommandGroup): Promise<TaskExecutionResult>`;
- `TaskQueries.get(context: TaskReadContext, taskId: TaskId): Promise<Task | null>`;
- `TaskQueries.list(context, query: ListTasksQuery): Promise<TaskPage>`;
- `TaskQueries.history(context, query: TaskHistoryQuery): Promise<TaskEventPage>`;
- `TaskQueries.changes(context, query: TaskChangesQuery): Promise<TaskEventPage>`;
- `resolveLocalTime(input: LocalDateTime): TemporalResult` через port (успех `{at,timezone}`, отказ `{error: TaskError}`);
- `TaskEffectsPolicy.apply(change: TaskChange): Promise<void>` через session-bound port.

TaskSession port предоставляет lockReceipt/readReceipt, lockTasks, persistChanges/persistReceipt,
read queries и effects policy; application не управляет SQL/BEGIN. Infrastructure composition
создаёт session на уже открытой транзакции либо оборачивает вызов в новую guarded tenant
transaction. Два режима вызывают один application executor; никаких nested transactions.
Receipt считается committed только после успешного outer commit. Callback не уносит session
наружу и не запускает fire-and-forget writes.

Порядок authority locks: system_state restore guard → users row FOR SHARE и status=active →
для inbound существующие conversation/work/head locks → effectKey lock → task UUID locks →
effects/receipt/outbox → финальный existing lease guard → COMMIT. Для standalone typed вызова
conversation locks нет. Users lock удерживается до commit, чтобы erase begin/finish не обошли
новый writer. Сейчас PostgresFencedConversation начинает с conversation, поэтому при подключении
Tasks добавить users lock **до** conversation; не брать user lock внутри handler после work.
Проверить соответствие identity ingress/erasure порядку, не вводить обратный user→MAX advisory
lock. Test fixture без пользователя, deleting/deleted и restore fence не получает TaskSession.

Existing FoundationInboundHandler чистый, знает только payload и sequence; receiptType сейчас
foundation_echo. Нельзя добавить Tasks writes в Promise.race pure handler — late continuation
может продолжить работу. Stage 2 вводит отдельный transaction-bound typed processing executor,
вызываемый и полностью await-нутый PostgresAtomicProcessing после pure preparation; timeout
управляется existing DB session lifetime. Production runtime пока использует foundation executor.
Typed executor включается только тестовой injection, с готовой typed группой из fixture,
не парсит обычный MAX text и не добавляет test webhook/header/backdoor.

Миграция 0026 расширяет valid_processing_result и TypeScript union с `task_commands_v1`:
receiptVersion=1, taskReceiptId, messages; foundation_echo остаётся прежним. Bound executor
вызывает Tasks, finalizer строит один deterministic text из committed-result candidate;
затем existing complete пишет processing_receipt, outbox, event terminal state и sequence.
Commit фиксирует всё либо ничего. Один source с повтором не получает второй outbox.
Ни Tasks, ни test harness не вызывают sender. Delivery failure/retry не исполняет команду.
Это integration proof, не доказательство NLP или живого task-canary MAX.

## 10. Задел для Reminders

TaskChange содержит eventId/taskId/userId, before/after snapshots, kind и версии.
TaskEffectsPolicy получает его в той же транзакции после полной валидации группы; отказ policy
откатывает задачи, events, receipt и outbox. В Stage 2 зарегистрирована только NoopTaskEffectsPolicy:
таблиц reminders/jobs и отправки нет. Contract test с fake policy доказывает rollback и отсутствие
вызова при replay/no_change/rejection.

Stage 4 подключит единственного владельца Reminders через этот порт: terminal task отменяет
будущие активные reminders/jobs; schedule change перестраивает policy reminders, сохраняя explicit
без явной команды отмены. Reopen допускает пересчёт будущих policy reminders, не воспроизводит
старые sent/expired explicit reminders. Конкретные offsets, send/cancel race и пропущенное время
после простоя решает Stage 4. Snapshot и version уже позволяют проверить актуальность перед send.
Событие не объявляется доставленным уведомлением.

## 11. Чтение, список и поиск

TaskReadContext содержит trusted userId и query timezone. Для первой страницы без cursor
`asOf` один раз берётся из DB и сохраняется в ответе и cursor. Последующие страницы используют
**только asOf первой страницы из cursor** для overdue и остальных зависящих от времени
предикатов, fingerprint и ответа. Текущее время новой DB-транзакции (`transactionNow`) служит
только техническим проверкам authority/deadline и не заменяет asOf. Новый запрос без cursor
начинает новую последовательность страниц с новым asOf. Invalid timezone отвергается. Все запросы tenant-scoped;
Get чужой/несуществующей task → null, history → task_not_found без чужих данных.
ListTasksQuery: view=`all|open|day|overdue`, statuses?, day?, timezone?, text?, limit?, cursor?.
По умолчанию view=open, limit=20; максимум 100. Для day обязателен day и явная query timezone,
для overdue используется timezone каждой task. statuses фильтр допустим только all/day,
по умолчанию all=все статусы, day=open; open/overdue всегда open.

Search text: trim 1–200 code points, Unicode lowercase; буквальная case-insensitive substring
по title OR description; `%`, `_`, backslash экранируются и не являются SQL wildcard.
Без text поиск не применяется. SQL parameterization обязательна. Похожие строки возвращаются
кандидатами с id/version; запрос никогда не авторизует изменение и не создаёт задачу.

Day membership: targetDate=day OR dueDate=day OR scheduledAt/dueAt в полуоткрытом интервале
[dayBoundary(day), dayBoundary(nextCalendarDate(day))) query timezone. Следующая дата вычисляется
календарно, не прибавлением 24 часов к instant. `dayBoundary(date, timezone)` — отдельная
операция календарного чтения: для существующего дня это самый ранний instant этого локального
дня. При отсутствующей полуночи выбирается первое существующее время внутри дня; при двойной
полуночи — её первое, более раннее UTC-вхождение, чтобы оба вхождения попали в один день.
Для полностью пропущенного локального дня boundary совпадает с началом первого следующего
существующего дня; start=end, точный временной интервал пуст. Date-only targetDate/dueDate
всё равно сравниваются буквально: задача с такой датой не исчезает и не переносится.
Эта boundary policy не применяется к пользовательской встрече: `resolveLocalTime` из §4
по-прежнему отвергает nonexistent time и требует offset при ambiguity. Конец date-only deadline
также задаёт dayBoundary следующей календарной даты в timezone задачи; просрочка наступает
при `asOf >= boundary`. DST-день может быть 23/25 часов или иметь другие исторические отклонения.
Одна task один раз, даже при совпадении всех полей. Ни undated, ни overdue из другого дня
не переносятся в day. Overdue: открытая task с просроченным deadline по §4. Пропущенный targetDate
и scheduledAt сами по себе не означают нарушенный крайний срок; Stage 4 может показать их отдельной
секцией, сохраняя причины. Full Daily View и напоминания в Stage 2 не реализуются.

All/open/overdue сортируются `(createdAt DESC,id DESC)`; day —
`(dayTime NULLS LAST,createdAt ASC,id ASC)`, dayTime=min(scheduledAt,dueAt), попавших в этот день.
Это порядок отображения, не рейтинг важности. Cursor versioned/opaque, содержит sort tuple,
query fingerprint (tenant, normalized filters, day/timezone/asOf), limit; asOf восстанавливается
из валидированного cursor до вычисления fingerprint; mismatched query →
invalid_command. Keyset pagination, нет OFFSET и неограниченной выгрузки. Cursor не даёт
полномочий: даже подделанный всегда подчиняется RLS и проверке типов/границ.

Страницы между запросами читают актуальное состояние, не один долгоживущий snapshot: concurrent
правка dayTime может переместить строку; при необходимости caller обновляет список с первой страницы.
При неизменных строках продвижение часов между страницами не меняет membership: нет
пропусков/дублей и новых overdue только из-за нового transactionNow. Это фиксация времени
фильтра, не MVCC snapshot данных. Ответ `{items,nextCursor,asOf}`; JSON transport в Stage 3.
History пагинируется по afterVersion DESC, limit20/max100. Changes — по recordedAt DESC/id DESC
с optional since; содержит все статусы, годится будущему Context Pack, не скрывает отменённые задачи.

## 12. Проверяемая приёмка

Каждая строка — обязательный автоматический сценарий с настоящим PostgreSQL для persistence;
чистые unit tests дополнительно проверяют правила. Live NLP/AI/MAX buttons сюда не подменяются.

| ID | Вход / сбой | Ожидаемые данные и результат |
|---|---|---|
| A01 | Create без необязательных полей | open/v1, даты null, snapshot timezone, 1 create event, 1 receipt |
| A02 | Два разных key с одним title | 2 tasks; одинаковый key/payload → прежний id/receipt, counts не растут |
| A03 | Тот же key с другим title/evidence/source | idempotency_conflict, прежние task/event/receipt неизменны |
| A04 | Update clear/null, одинаковый patch, invalid title/unknown field | clear applied +1/event; equal no_change без event; invalid rejected без task effect |
| A05 | Все клетки таблицы §5, stale version даже no-op | разрешённые transitions +1; no_change без event; conflict/invalid_transition без task effect |
| A06 | Cancel → Reopen → Update, Complete → Reopen | тот же UUID, сохранены даты; terminal timestamps корректны; непрерывные versions/history |
| A07 | Patch targetDate при точном времени; явный перенос обоих полей | первая команда не сдвигает instant; вторая меняет только заявленные поля |
| A08 | leap day, 31 февраля, без offset, due union, schedule>deadline | корректные принимаются; неверные закрытым кодом, без частичного эффекта |
| A09 | Europe/Berlin gap 2026-03-29 02:30 / fold 2026-10-25 02:30 | nonexistent / ambiguous; fold +02:00 → 00:30Z, +01:00 → 01:30Z |
| A10 | Retry после смены profile timezone; past due; dueDate граница | прежний snapshot/instant, прошлое не переписано; overdue меняется только на определённой границе |
| A11 | Две независимые sessions, один key; разные key и version1 | ровно один эффект для key; во второй гонке applied и version_conflict |
| A12 | Группа Create(local a) + Update(created a,v1); неверная последняя команда | success v2/2 events/1 receipt; rejected группа 0 tasks/0 events и rejected receipt |
| A13 | Две existing targets, одна stale; локальная ссылка из другой группы | обе без эффекта; invalid_local_reference; одна rejected receipt на валидный envelope |
| A14 | Inject failure после state/event/receipt/policy/outbox; lost COMMIT ACK | precommit всё rollback; retry committed key возвращает прежнее без второго эффекта |
| A15 | Tenant B UUID в A command/query/event FK; missing/spoof settings | not_found/null либо SQL deny; no cross-tenant read/write, GUC не разрешает immutable DELETE |
| A16 | UPDATE/DELETE events/receipts прямым runtime SQL | deny; privacy erase удаляет их, anonymous audit без текста/ссылок |
| A17 | absent/negative/quoted/uncertain/non-owner/target-mismatch evidence | invalid_evidence; нет task эффекта и fallback Create |
| A18 | All/open/day/overdue/search, равные даты, wildcard text, undated; часы проходят dueAt/конец dueDate между страницами без изменения строк | точный membership/order; task один раз; cursor сохраняет исходный asOf во всех ответах/fingerprint; последующие страницы имеют прежний overdue membership без пропусков/дублей; свежая первая страница использует новое время и включает новые overdue |
| A19 | Смена timezone чтения, 23/25-часовой день, отсутствующая/двойная полночь, полностью пропущенный день; history после no_change | полуоткрытые границы: первое существующее время / первое вхождение полуночи; пропущенный день имеет start=end и не включает instants, но сохраняет literal date-only membership; встреча в gap/fold остаётся strict error/explicit offset; событие после no_change не добавлено |
| A20 | Typed inbound → Tasks → processing receipt/outbox; restart/delivery retry | один committed effect/event/receipt/outbox, truthful ответ; production text всё ещё foundation |
| A21 | Restore fence, stale/expired lease, deleting user vs typed commit | no unauthorized commit; либо commit перед erasure, либо account_unavailable, без deadlock |
| A22 | Technical retention, erase preview/begin/finish/retry и restore snapshot | retention не трогает tasks/history/keys; erase counts/finish все удаляют; restore согласует state/history/receipt |
| A23 | Fake reminder policy throws; replay/terminal/reopen | full rollback на throw; event-based вызов ровно на effect; Noop не создаёт reminders/jobs |
| A24 | 1000 tenants × 100 tasks, list/search/typed update | RLS/invariants сохраняются; p95 typed command <1s в зафиксированной локальной среде, без provider I/O |

A24: фиксированный seed, 10 concurrent clients, 100 warm-up, 1000 measured operations,
read/write 80/20; в evidence CPU/RAM/PG version/indexes/dataset и query plans. Это локальный
регрессионный профиль, не подтверждение production capacity/SLO. Нельзя расширять нагрузку
foundation на каждом checkpoint; этот профиль запускается один раз на финальном checkpoint50.

До checkpoint45 домен проверяется только в изолированной тестовой БД: миграция включения
Tasks в privacy erasure ещё не завершена. Промежуточный checkpoint40 не является разрешением
развёртывать новые task tables на существующих пользовательских данных.

Checkpoint40 доказывает A01–A03/A15 на create и чистые правила A04–A10/A17.
Checkpoint45 добавляет persistent A04–A13/A16/A18–A19/A22 erasure/retention.
Checkpoint50 закрывает все A01–A24, включая real PostgreSQL transactional integration,
restart/fence/erase races и сохранение foundation behavior. Typed tests не означают успешное
понимание человеческой речи и не закрывают отложенный реальный callback.

## 13. Процесс принятия

[План Stage 2](../plans/2026-10-13-max-assistant-stage-2-task-domain.md): итерации36–50,
три блока по пять; один исполнитель в блоке, без его делегирования. Один commit на итерацию;
целевые RED/GREEN + typecheck/architecture внутри блока. Один cumulative independent review,
один полный gate в clean clone на checkpoint; каждый тестовый набор запускается в gate один раз,
functional уже входит в default suite и отдельно не повторяется; подтверждённые fixes тому же исполнителю.
Следующий блок только после принятия evidence владельцем. Дополнительные agents/review/gates
или расширение scope — по отдельному согласованию. После двух безрезультатных repair cycles —
сохранить доказательства и остановиться.

Владелец принял спецификацию и план 2026-10-13 и отдельно разрешил только блок36–40,
checkpoint40 review/gate и push с проверкой local/remote SHA. Итерация41 и следующие этапы
не разрешены; после checkpoint40 исполнитель останавливается.

Разрешение владельца2026-10-14: только41–45, одно checkpoint45 review/gate и push со сверкой SHA; остановиться перед46, без серверного развёртывания.
