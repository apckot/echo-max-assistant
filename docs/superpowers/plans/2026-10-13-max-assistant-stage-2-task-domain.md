# Echo MAX Stage 2 — Task Domain Implementation Plan

> **For agentic workers:** Использовать superpowers:executing-plans. Один исполнитель последовательно выполняет один разрешённый блок из пяти итераций, без делегирования. Один commit на итерацию; одно накопительное независимое ревью на checkpoint. Не применять старую цепочку новых агентов на каждую итерацию. Шаги отмечаются checkbox.

**Goal:** Единый независимый от MAX/AI домен задач с typed-командами, PostgreSQL, историей, чтением и безопасными повторами.

**Architecture:** Чистый Task aggregate, один application executor и один PostgreSQL writer. Tenant session связывает задачи с существующей guarded transaction; receipt/events/current state фиксируются атомарно. Read models читают текущие таблицы, delivery остаётся отдельным владельцем.

**Tech Stack:** TypeScript ESM, Node22, PostgreSQL17, pg, Zod4, Vitest4, existing testcontainers. Использовать установленные версии package-lock; без новых зависимостей и редактирования старых migrations.

**Spec:** [Stage 2 design](../specs/2026-10-13-max-assistant-stage-2-task-domain-design.md).

**Status:** Принято владельцем 2026-10-13. Отдельно разрешён только блок36–40, одно checkpoint40 review/gate, progress ledger и push с проверкой SHA. Checkpoint40 принят2026-10-14; теперь отдельно разрешён блок41–45 с review/gate/push, Блок41–45 выполнен и checkpoint45 проверен2026-10-14; Checkpoint45 принят; разрешён блок46–50, выполнен с review/gate/restore, A24 пока не завершён. См. [отчёт](../../progress/stage-2-checkpoint-45.md).

## Global Constraints

- Актуальные global/project AGENTS.md и spec обязательны. Основа `a4543b7`, Stage1 accepted с реальным callback exception.
- Состояния только open/completed/cancelled. Create без дат допустим. Cancel recoverable, hard delete только account privacy erasure.
- UUID/internal userId; expectedVersion для существующих targets; effectKey для группы; максимум20 commands, version≤2147483647.
- Title1–500, description≤10000 Unicode code points; search1–200; page20/max100; effectKey1–200 ASCII; localId1–64 ASCII.
- Date-only сохраняется датой, instants UTC milliseconds, IANA timezone snapshot; никакого automatic rollover, времени23:59 или live relative-time пересчёта retry.
- Домен/application не импортируют pg, MAX/AI/STT/HTTP/provider DTO. Единственный Tasks adapter пишет task tables.
- Stage2 не включает real conversational Tasks, reminders/jobs/delivery, AI, кнопки, Mini App, billing, calendar и новый operator CLI.
- Existing production FoundationInboundHandler остаётся выбранным. Transaction-bound typed bridge доступен только test injection.
- У Tasks нет sender/outbox formatter. Truthful receipt и event — business result, не подтверждение доставки.
- Schema24/25/26 последовательно; readiness/migration checks обновляются с каждой новой migration.

## Review Focus

1. Lost COMMIT acknowledgement и другой payload со старым key не должны повторить эффект — тесты40/47.
2. Cursor asOf не меняется с часами; календарные boundaries в gap/fold/skipped day не подменяют строгую встречу или date-only deadline — тесты37/43/49.
3. User erasure против разных conversation/standalone writers не должна оставить данные или deadlock — тесты45/46/47.
4. Rejected последняя команда группы и failure policy/outbox не должны оставить ранний effect — тесты42/46/47.
5. Чужой UUID, wildcard search, spoofed privacy GUC и чужой SQL writer не должны обойти authority — тесты39/43/45/48.

## Карта файлов и интерфейсов

Пути ниже относительны корню `/Users/epictetus/Documents/MW/echo-max-assistant`.
План закрепляет ответственности, а не требует разрастающегося общего tasks.ts.

| Файлы | Ответственность |
|---|---|
| src/modules/tasks/domain/task.ts, commands.ts, validation.ts, transitions.ts | модель, закрытые DTO, нормализация, pure transitions |
| src/modules/tasks/application/context.ts, evidence.ts, ports.ts | trusted context/evidence и session-bound ports |
| src/modules/tasks/application/task-commands.ts, group-planner.ts | один execute и pure планирование атомарной группы |
| src/modules/tasks/application/task-queries.ts, query-types.ts | get/list/history/changes и bounded query contracts |
| src/modules/tasks/application/task-effects-policy.ts | публичный transactional policy port + Noop |
| src/infrastructure/time/iana-time-resolver.ts | Intl/IANA local-time resolution, strict offsets |
| src/infrastructure/postgres/tasks/task-row.ts, task-session.ts, task-store.ts | mapping, session factory, единственный task SQL writer |
| src/infrastructure/postgres/tasks/task-receipts.ts, task-read-model.ts | canonical payload/receipts, bounded read SQL; части того же adapter |
| src/infrastructure/postgres/postgres-typed-task-processing.ts | test-injectable bound processing bridge/finalization |
| migrations/0024_task_domain.sql, 0025_task_privacy_erasure.sql, 0026_task_processing_result.sql | additive schema/RLS/privacy/result contracts |
| tests/support/task-fixture.ts, task-command-fixtures.ts | runtime-role PostgreSQL sessions и typed cases, без нового публичного transport |
| tests/unit/tasks/*.test.ts, tests/functional/tasks/*.test.ts | доменные правила, SQL guarantees, rollback/race cases |
| tests/e2e/task-domain-flow.test.ts, tests/performance/task-domain.run.ts | финальный typed integration/измеримый профиль |

Из существующих файлов затрагиваются только необходимые точки: migrations/readiness expected
schema (найти через `rg 'schemaVersion|schema_version|23' src tests`), database.ts при необходимости
ограниченных transaction ports; postgres-fenced-conversation.ts для user-before-conversation lock;
postgres-atomic-processing.ts и application inbound-handler.ts для bound continuation/result union;
scripts/check-architecture.mjs и tests/architecture/dependency-boundaries.test.ts;
операционные erasure/restore tests, foundation.md и runbooks. Не переписывать worker loop или delivery.

DTO signatures определены в spec §§5,7,9,11. В ports.ts закрепить:

- `TaskCommandSession`: `findReceipt(effectKey)`, `lockEffect(effectKey)`, `lockTasks(ids)`,
  `persistChanges(changes)`, `persistReceipt(receipt)`, `effectsPolicy`;
  все Promise, DTO-only, без SQL transaction handles.
- `TaskSessionRunner.run<T>(context, fn: (session: TaskCommandSession) => Promise<T>): Promise<T>`:
  standalone adapter управляет guarded transaction; bound adapter использует уже открытый DbTx.
- `TaskCommands.execute(context: TaskExecutionContext, group: TaskCommandGroup): Promise<TaskExecutionResult>`.
- `TaskExecutionResult = {receipt: TaskReceipt, replayed: boolean} | {error: TaskError}`;
  applied/no_change/rejected живут внутри receipt; invalid envelope/authority/key mismatch — error.
- `planGroup(context, group, lockedTasks, newIds, recordedAt, temporalFacts): TaskGroupPlan | TaskError`:
  не пишет и не генерирует UUID/clock самостоятельно. Inputs приходят через ports.
- `TaskQueries.get/list/history/changes` как spec §9; `TaskReadSession` DTO-only.
- `TaskEffectsPolicy.apply(change: TaskChange): Promise<void>` на transaction-bound session;
  `NoopTaskEffectsPolicy` — единственная production реализация Stage2.

В group-planner.ts `TaskGroupPlan` содержит finalTasks, ordered TaskChange[], commandResults
и localIdMap; отказ не содержит частичных результатов. В task.ts определить TransitionFacts
с recordedAt и resolved local dates для temporal checks; transitions.ts возвращает
`{outcome,task,change?}` либо TaskError. Пустой `change` допустим только no_change.

TaskSession — внутренний application port, repository не является публичным API другим модулям.
Идентификаторы/fingerprint генерируются infrastructure; raw context не приходит от модели.
Домен transition принимает уже нормализованные Task/Command и вычисленные temporal facts.

## Протокол исполнения и evidence

Внутри каждой итерации:

- [ ] Прочитать spec, интерфейсы и последний принятый checkpoint; проверить Git, не затирать чужие изменения.
- [ ] Написать указанный failing test, запустить ровно его; подтвердить ожидаемую RED-причину.
- [ ] Реализовать только результат итерации.
- [ ] Запустить указанные targeted tests, `npm run typecheck`, `npm run lint:architecture`; GREEN обязателен.
- [ ] Сделать отдельный commit с указанным сообщением; записать полный SHA и доказательство в ledger блока.

План не разрешает full npm test/verify на каждой итерации. Существующий функциональный тест,
непосредственно затронутый изменением, входит в targeted набор; broad scans только checkpoint.
Независимого per-iteration reviewer нет. Если итерация требует >7 содержательных файлов или
~400 строк без migration/generated/lockfile, >2ч либо нескольких независимых результатов,
сначала уменьшить её внутренние шаги; дополнительные numbered commits/расширение блока согласовать.
После двух диагностических/repair cycles без прогресса — blocker note и остановка.

Checkpoint40/45/50:

- [ ] Один reviewer на cumulative diff от предыдущего accepted SHA, spec и Review Focus.
  Перед запуском прочитать model-routing; компактный assignment, явно запретить дальнейшее делегирование.
- [ ] Тот же executor делает отдельный fix commit для подтверждённых findings; не скрывать их amend/rebase.
  Scoped rereview относится только к исправлениям, дополнительный reviewer требует разрешения.
- [ ] Зафиксировать final implementation SHA. Создать clean clone этого SHA, выполнить полный gate ниже
  **один раз**; не дублировать его в исходном checkout.
- [ ] Опубликовать docs/progress/stage-2-checkpoint-N.md: base/final SHA, iteration ledger, targeted
  RED/GREEN, review findings/fixes, команды и фактические gate результаты, ограничения.
- [ ] Остановиться до принятия владельцем следующего блока. Green gate сам по себе не acceptance.

Full gate (Docker доступен; отсутствующий Docker = blocked functional evidence, не PASS):

```bash
npm ci
npm run typecheck
npm run lint:architecture
npm test
npm run build
docker build -f deploy/Dockerfile .
```

`npm test` выполняет default suite, включая functional и обычные e2e tests, один раз.
Отдельный `npm run test:functional` и повтор через review-focus config в этот gate не входят.
Evidence выделяет functional/e2e результаты из общего отчёта без повторного запуска.
Если конфигурация набора изменится, gate должен охватывать каждый файл ровно один раз,
с непересекающимися наборами вместо повторов. Gate и clean-clone verification — один запуск в чистом checkout.
На этом SHA однократно Gitleaks8.30.1 по reachable history и tracked archive по принятому
checkpoint35 шаблону; широкая проверка TODO/forbidden dependencies/SQL writers. Не запускать
ещё один независимый audit. Только checkpoint50 дополнительно включает e2e typed flow,
новый профиль A24 и isolated backup/restore tasks fixture. Не делать новый реальный MAX canary
или production deploy в рамках Stage2 acceptance. Source change после gate требует повтор
затронутой проверки; full gate повторяется только при relevant change/failure/uncertain run,
с соблюдением правил согласования дополнительных прогонов.

Progress публикация после gate может быть documentation-only descendant проверенного SHA;
явно указать это, не утверждать что новый SHA прошёл gate. Никакого push/merge/deploy без
разрешения. Проверяемость плана не требует предварительного запуска будущих тестов сейчас.

## Блок 1 — итерации36–40, checkpoint40

### 36. Типизированный контракт и явное намерение

**Files:** create domain/task.ts, commands.ts, validation.ts; application/context.ts, evidence.ts;
unit/tasks/command-contract.test.ts. **Commit:** `feat(tasks): define typed task command contract`.

**Produces:** Task, TaskCommand, TaskCommandGroup, TaskError, TaskExecutionContext/ExplicitTaskIntent;
`normalizeCommand(command: unknown): TaskCommand | TaskError`, `validateEvidence(context,command): TaskError | null`.

- [ ] RED `create_without_dates_is_valid`: normalized dates null; `title='  Позвонить  '` → `Позвонить`.
  Table tests boundary500/501 Unicode code points, surrogate pair, empty title, invalid controls,
  unknown field, null clearing vs absent; taskId/tenant не переопределяется patch.
- [ ] RED `non_owner_or_nonaffirmative_intent_rejected`: missing/quoted/negative/uncertain/target mismatch
  → invalid_evidence; operator/import → unsupported_actor; rejected update никогда не превращается Create.
- [ ] Implement закрытые DTO, normalizer и trusted context boundary по spec §§3,5–6.
- [ ] GREEN `npx vitest run tests/unit/tasks/command-contract.test.ts`; static checks; commit.

### 37. Даты и точное локальное время

**Files:** create infrastructure/time/iana-time-resolver.ts, unit/tasks/time.test.ts;
modify domain/validation.ts, application/ports.ts. **Commit:** `feat(tasks): define dates deadlines and timezone resolution`.

**Produces:** `resolveLocalTime(input: LocalDateTime): TemporalResult`, validation temporal facts;
deadline union date/instant/null; strict UTC result и stable timezone snapshot.

- [ ] RED A08–A10: leap2028-02-29 pass, 2026-02-29/31-Feb fail; no-offset instant fail;
  dueDate/dueAt union cannot coexist; milliseconds roundtrip; unsupported/infinite dates fail.
- [ ] RED Berlin gap/fold из A09, выбранный неверный offset fail; schedule after deadline fail;
  смена profile timezone не изменяет уже разрешённую команду.
- [ ] Implement strict date/instant parsing, IANA resolver и projection local-date facts;
  duration/relative NLP не добавлять.
- [ ] GREEN `npx vitest run tests/unit/tasks/time.test.ts tests/unit/tasks/command-contract.test.ts`; static; commit.

### 38. Чистый lifecycle и перенос

**Files:** create domain/transitions.ts, unit/tasks/transitions.test.ts;
application/task-effects-policy.ts. **Commit:** `feat(tasks): implement task lifecycle transitions`.

**Produces:** `transition(task: Task,command: ExistingTaskCommand,facts: TransitionFacts): TransitionResult`;
TaskChange, NoopTaskEffectsPolicy. Create construction принимает назначенный UUID/DB timestamp.

- [ ] RED таблица всех15 status/command combinations, same-version no-op, stale-version conflict,
  terminal timestamp rules, reopen same UUID/dates, version_exhausted.
- [ ] RED targetDate-only move preserves scheduledAt; clear deadline independent of schedule;
  timezone-only change сохраняет instant и проверяет итоговый schedule.
- [ ] Implement spec §§4–5; applied +1/event candidate, no_change без event candidate.
- [ ] GREEN `npx vitest run tests/unit/tasks/transitions.test.ts`; static; commit.

### 39. PostgreSQL schema и FORCE RLS

**Files:** create migrations/0024_task_domain.sql, support/task-fixture.ts,
functional/tasks/schema-rls.test.ts; targeted existing readiness/migration assertions.
**Commit:** `feat(tasks): add task storage history and tenant policies`.

**Produces:** schema24, три таблицы/индексы/FK/validators/immutable/deferred triggers spec §8;
runtime-role fixture, без временного writer другого модуля.

- [ ] RED fresh migration, composite cross-tenant FK deny; no tenant yields empty/denied;
  worker A не видит B, gateway/delivery/scheduler denied; invalid row/calendar/snapshot deny;
  UPDATE/DELETE history/receipt deny включая spoof GUC.
- [ ] Implement migration with explicit grants/policies and current/version event consistency;
  deferred trigger позволяет атомарно state+event+receipt, не отдельный несогласованный commit.
- [ ] GREEN `npx vitest run tests/functional/tasks/schema-rls.test.ts tests/functional/postgres/migrations.test.ts`;
  targeted readiness tests по найденным версиям; static; commit.

### 40. Надёжное создание через единственный executor

**Files:** create application/task-commands.ts, group-planner.ts; infrastructure/postgres/tasks/
 task-row.ts, task-session.ts, task-store.ts, task-receipts.ts; functional/tasks/create-idempotency.test.ts.
Разделить файлы по ответственности; не расширять количество независимых behaviors.
**Commit:** `feat(tasks): persist idempotent task creation`.

**Consumes:** contracts36–39. **Produces:** public execute, standalone guarded session и create receipts;
на этом checkpoint составляется только create test harness; остальные persistent writes
не публикуются вызывающим поверхностям до41, pure правила уже готовы. До45 только изолированная
тестовая БД: privacy erasure для новых таблиц пока не подключён.

- [ ] RED A01–A03: same key same payload same UUID/receipt; distinct keys identical title create2;
  changed payload/source conflicts; concurrent same key only1 task/event/receipt.
- [ ] RED failure после create event до receipt всё rollback; ключ включает actor/evidence/time snapshot;
  exact canonical comparison; deleting user/fence не создаёт task.
- [ ] Implement canonical payload port, receipt lock/replay и CREATE persistence; generated UUID
  присутствует только committed receipt; user lock до task rows; no nested transactions.
- [ ] GREEN `npx vitest run tests/functional/tasks/create-idempotency.test.ts`; static; commit.
- [ ] Провести checkpoint40 по общему протоколу; demo typed Create и replay, данные/event/receipt.

## Блок 2 — итерации41–45, checkpoint45

### 41. Persistent Update/Complete/Cancel/Reopen и optimistic locking

**Files:** modify task-commands.ts/group-planner.ts/task-store.ts;
create functional/tasks/mutations.test.ts, concurrency.test.ts.
**Commit:** `feat(tasks): persist versioned task mutations`.

**Produces:** весь набор commands для одной existing target, row lock + CAS + history.

- [x] RED A04–A07/A11: clear, equal patch, все status переходы, conflict до no-op;
  две sessions с version1 → exactly1 applied,1 conflict; чужая цель not_found.
- [x] Implement pure transition results persistence + receipt и rollback invariants.
  Rejected valid request сохраняет receipt, invalid context не сохраняет.
- [x] GREEN `npx vitest run tests/functional/tasks/mutations.test.ts tests/functional/tasks/concurrency.test.ts`;
  static; commit.

### 42. Атомарные группы и локальные ссылки

**Files:** modify group-planner.ts/task-commands.ts/task-store.ts;
create functional/tasks/atomic-groups.test.ts, unit/tasks/group-planner.test.ts.
**Commit:** `feat(tasks): execute atomic task command groups`.

**Produces:** 1–20 commands, sorted target locks, localId map, multiple effects same target
with sequential expected versions, per-command results и final snapshots.

- [x] RED A12–A13: Create(a)+Update(created a,v1) → v2,2 events; Reopen(v2)+Update(v3);
  final invalid/stale target → no ранние effects, только rejected receipt; unknown/cyclic ref fail.
- [x] RED 20 pass/21 fail, duplicate localId fail, same-task no_change сохраняет следующую expectedVersion;
  reverse target order two sessions не deadlock; fake policy throw rolls back whole group.
- [x] Implement staged in-memory plan перед writes; task locks UUID order; policy только applied effects.
- [x] GREEN `npx vitest run tests/unit/tasks/group-planner.test.ts tests/functional/tasks/atomic-groups.test.ts`;
  static; commit.

### 43. Get/list/search/day/overdue без второго состояния

**Files:** create application/query-types.ts/task-queries.ts, postgres/tasks/task-read-model.ts,
functional/tasks/queries.test.ts. **Commit:** `feat(tasks): add bounded task queries and search`.

**Produces:** TaskReadSession, TaskPage, ListTasksQuery и get/list signatures spec §§9,11.

- [x] RED A18–A19: open/default20/max100, explicit statuses, four day predicates OR без дублей;
  undated exclusion; dueDate task-zone overdue vs dueAt exact; start inclusive/end exclusive.
- [x] RED literal `%`/`_`/backslash, Cyrillic mixed case, description match, чужой tenant null;
  keyset pages on equal timestamps/ids; changed filters/cursor deny; invalid timezone deny.
- [x] RED pagination_keeps_first_page_as_of: после первой overdue страницы часы новой DB-транзакции
  проходят dueAt и конец dueDate без изменения строк; cursor страницы2/3 и ответы сохраняют первый
  asOf, membership/order и fingerprint, без новых overdue/пропусков/дублей. Новый запрос без cursor
  получает новое asOf и включает ставшие просроченными задачи. Отдельно проверить отсутствие
  version/time подмены: transactionNow участвует в authority, но не временных фильтрах.
- [x] Implement parameterized queries, stable sorting и fingerprinted typed cursors;
  first-page asOf из DB, continuation asOf из валидированного cursor; no cache/full scan export.
- [x] GREEN `npx vitest run tests/functional/tasks/queries.test.ts`; static; commit.

### 44. История и последние committed изменения

**Files:** modify task-queries.ts/query-types.ts/task-read-model.ts;
create functional/tasks/history.test.ts. **Commit:** `feat(tasks): expose immutable task history and changes`.

**Produces:** history/changes signatures, TaskEventPage; useful future Context Pack read API.

- [x] RED create/update/complete/reopen версии непрерывны, before/after и actor/source правильны;
  no_change/replay/rejected не добавляют событий; terminal task доступна в changes/history.
- [x] RED pagination version DESC и changes recordedAt/id DESC, equal clock, tenant isolation;
  recordedAt не подменяется sourceOccurredAt; cap100 и since filter.
- [x] Implement SQL reads существующего журнала, не второй журнал и не delivery history.
- [x] GREEN `npx vitest run tests/functional/tasks/history.test.ts`; static; commit.

### 45. Privacy erasure и retention нового домена

**Files:** create migrations/0025_task_privacy_erasure.sql, functional/tasks/privacy.test.ts;
modify targeted account-deletion/retention schema assertions и runbooks/account-deletion.md.
**Commit:** `feat(tasks): include task domain in account erasure`.

**Produces:** schema25; updated narrow erasure function/counts, owner-only immutable deletion.

- [x] RED A16/A22: preview counts tasks/events/receipts, begin блокирует new writer, finish removes all;
  finish replay safe; anonymous audit не содержит title/task/source IDs; ordinary worker GUC deny.
- [x] RED technical retention оставляет completed/cancelled tasks, историю и effect keys;
  deleted account key не позволяет resurrect данные; migrating FK deletion order correct.
- [x] Implement additive function replacement и privilege/trigger exception; readiness bump.
- [x] GREEN `npx vitest run tests/functional/tasks/privacy.test.ts tests/functional/identity/account-deletion.test.ts tests/functional/operations/retention.test.ts`;
  targeted migration readiness; static; commit.
- [x] Checkpoint45: demo typed lifecycle/date/search/history/erase, cumulative review и один full gate.

## Блок 3 — итерации46–50, checkpoint50

### 46. Bound integration: Task effect + receipt + outbox

**Files:** create postgres-typed-task-processing.ts, migrations/0026_task_processing_result.sql,
functional/tasks/processing-transaction.test.ts; modify postgres-atomic-processing.ts,
postgres-fenced-conversation.ts и inbound-handler.ts result union (без нового parser).
**Commit:** `feat(tasks): integrate typed commands with guarded processing`.

**Produces:** schema26; awaited transaction continuation, task_commands_v1 processing result,
one deterministic integration confirmation; production foundation behavior unchanged.

- [x] RED A20/A21: valid leased typed fixture commits task/event/taskReceipt/processingReceipt/outbox/sequence
  together; injected outbox failure → все rollback; production text echo не создаёт task.
- [x] RED user lock acquired before conversation; erasure begin vs bound/standalone writes завершает
  без deadlock; deleting user denied; stale lease denies domain commit.
- [x] Implement session bound to existing DbTx; no DB writes inside pure handler Promise.race,
  no duplicate transaction or sender; existing final lease guard remains last business check.
- [x] GREEN `npx vitest run tests/functional/tasks/processing-transaction.test.ts tests/functional/intake/processing-result.test.ts tests/functional/intake/queue-fencing.test.ts tests/functional/identity/account-deletion.test.ts`;
  targeted worker foundation test; static; commit.

### 47. Crash, lease loss, restore fence и неопределённый commit

**Files:** create functional/tasks/recovery.test.ts, authority-races.test.ts;
modify только подтверждённые defects в bound/session adapters.
**Commit:** `test(tasks): prove recovery and authority fencing`.

**Produces:** restart/rollback proof A14/A20–A23, а не только mock green.

- [x] RED disconnect настоящей PG session до commit после state/event/receipt/outbox;
  new session retry → exactly1 effect и outbox. После COMMIT drop acknowledgment proxy/fixture
  возвращает failure, retry возвращает тот же receipt; raw DB state доказывает original commit.
- [x] RED expired lease/fence-on before commit, independent renew session, erasure race;
  два conversation одной task с expectedVersion1; no resurrection после erase.
- [x] Implement минимальные найденные fixes; fake policy rollback всех writes. Не изменять delivery certainty.
- [x] GREEN `npx vitest run tests/functional/tasks/recovery.test.ts tests/functional/tasks/authority-races.test.ts`;
  relevant foundation fence/stop-races только если код затронут; static; commit.

### 48. Architecture guard: единственный владелец SQL и API

**Files:** modify scripts/check-architecture.mjs, tests/architecture/dependency-boundaries.test.ts;
create unit/tasks/ownership-guard.test.ts; adjust exports only if proven necessary.
**Commit:** `test(tasks): enforce task ownership boundaries`.

**Produces:** запрет foreign repository imports и task table SQL writes вне adapter/migrations;
application/domain нейтральны, public API не отдаёт session.

- [x] RED synthetic violating module imports tasks adapter/session or provider; чужой SQL
  INSERT/UPDATE/DELETE work_items/events/receipts, dynamic/reexport cases guard fails.
- [x] Implement bounded guard со списком разрешённых Tasks adapter файлов, migrations/privacy owner,
  тестовые fixture sources вне production scan; reject nonliteral SQL bypass в foreign production writers.
  Не заявлять полноценный SQL parser/static security proof; RLS/FK/runtime grants покрыты отдельно.
- [x] GREEN `npx vitest run tests/architecture/dependency-boundaries.test.ts tests/unit/tasks/ownership-guard.test.ts`;
  static; commit.

### 49. Временные границы и воспроизводимый performance harness

**Files:** create functional/tasks/temporal-queries.test.ts, performance/task-domain.run.ts;
modify только relevant temporal/query fixes. **Commit:** `test(tasks): cover local day boundaries and command load`.

**Produces:** A08–A10/A19 PostgreSQL roundtrip доказательства, A24 harness без преждевременного broad run.

- [x] RED Berlin23/25h local-day intervals, task snapshot zone vs read zone, midnight/end boundary,
  date-only due not23:59, leap-range roundtrip, changed Identity timezone сохранённые tasks не меняет.
- [x] RED day_boundary_midnight_gap_or_fold: по IANA transition fixtures отсутствующая полночь
  даёт первое существующее время дня, двойная — первое UTC-вхождение; обе полуночи включены,
  end boundary исключена. Strict resolveLocalTime встречи на тех же wall-clock значениях
  по-прежнему возвращает nonexistent/ambiguous без явного валидного offset.
- [x] RED skipped_local_day: Pacific/Apia 2011-12-30 start=end=начало2011-12-31;
  instants не входят, targetDate/dueDate=2011-12-30 входят буквально; date-only deadline
  становится overdue на boundary следующей календарной даты. Никакого сдвига stored dates.
- [x] Implement `dayBoundary(date,timezone)` отдельно от strict meeting resolver по spec §11;
  nextCalendarDate вычислять календарно, не instant+24h. Проверить asOf из cursor на переходе
  через такую boundary, сохраняя критерий A18.
- [x] Implement missing targeted fixes; add deterministic A24 seeded profile и report без task text.
  Малый harness smoke (2 tenants, 10 ops) проверяет report schema, не full load.
- [x] GREEN `npx vitest run tests/functional/tasks/temporal-queries.test.ts` + small harness smoke;
  static; commit. Full A24 run только checkpoint50.

### 50. Сквозная typed приёмка и restore compatibility

**Files:** create tests/e2e/task-domain-flow.test.ts, tests/functional/tasks/restore-consistency.test.ts;
modify tests/e2e/review-focus.config.ts to include task-domain-flow.test.ts;
modify docs/architecture/foundation.md, docs/runbooks/backup-restore.md;
create docs/runbooks/task-domain-acceptance.md.
**Commit:** `test(tasks): complete typed task domain acceptance`.

**Produces:** acceptance mapping A01–A24, final typed flow и isolated restore fixture;
явная инструкция последующим stages о callback exception и evidence boundary.

- [x] RED e2e typed create→move→complete→reopen→search→history; restart и repeated processing/delivery
  не меняют Task effect; two owners isolation; rejected group truthful processing confirmation.
- [x] RED isolated snapshot содержит Tasks current state/events/receipts; restored fence blocks all
  writers до разрешённого reopen; replay surviving key не повторяет эффект; no automatic inbound replay
  для команд, потерянных за пределами RPO. Проверять новые таблицы, не запускать живой MAX.
- [x] Implement только integration gaps; runbook фиксирует Noop reminders, unsupported AI/voice,
  date semantics, rejected/no_change/replay и rollback; architecture описывает одного writer.
- [x] GREEN targeted e2e/restore tests и static; commit. До review не запускать полный gate отдельно.
- [ ] Checkpoint50: cumulative review46–50 плюс consistency spec A01–A24; final clean-clone full gate
  один раз, включая typed e2e и functional через `npm test`; review-focus config остаётся
  средством targeted проверки, отдельный повтор его набора на checkpoint не запускается;
  A24 по `npx vitest run --config tests/performance/vitest.config.ts tests/performance/task-domain.run.ts`,
  один isolated backup/restore drill с Tasks fixture, broad scans. Не дублировать targeted restore
  как второй полный drill: targeted test моделирует row consistency, drill проверяет реальный backup.
- [ ] Опубликовать stage-2-checkpoint-50.md с реальными результатами/ограничениями; остановиться
  для acceptance Stage2. Stage3, providers, кнопки и production deployment не начинаются автоматически.

## Самопроверка покрытия перед передачей

| Spec | Итерации |
|---|---|
| Модель, ограничения, evidence | 36,37,39,48 |
| Переходы, перенос, no_change | 38,41 |
| Повторы/конкуренция/группы | 40,41,42,47 |
| PostgreSQL, RLS, append-only, privacy | 39,44,45,48 |
| Query membership/search/pagination/timezone | 43,44,49 |
| Single transaction, outbox, lease/fence, restart | 46,47,50 |
| Reminders contract + Noop, future boundary | 38,42,47,50 |
| Performance/restore/финальная acceptance | 49,50 |

A01–A03→40; A04–A07→38/41; A08–A10→37/49; A11→40/41;
A12–A13→42; A14→42/46/47; A15→39/41/43; A16→39/45;
A17→36; A18–A19→43/44/49; A20–A21→46/47/50;
A22→45/50; A23→42/47; A24→49/50.

До execution self-review проверяет одинаковые DTO/field names, absence/clear semantics,
непротиворечивость receipt/transition/version, все A01–A24 и read-only Stage2 boundary.
Не запускать агентов или программные full gates для проверки текста этого плана.
