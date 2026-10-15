# Stage3 — локальный контракт цитат и временных намерений

Дата2026-10-15. Разрешены только локальные изменения/целевые проверки после FAIL attempt2. **Новых API-вызовов0**, модель прежняя `gpt-4.1-2025-04-14`. Полный gate, reviewer, новый probe,54–55, real data/audio/MAX/deployment не запускались.

Внешний MeaningDraftV2: `evidence: [{sourceLabel, quote}]`; start/end запрещены. Приложение ищет точное единственное вхождение в provider source и через SourceMap восстанавливает оригинальные Unicode code-point ranges. Внутренний MeaningDecisionV1: `evidence: [{sourceLabel, quote, start, end}]` плюс SourceMap. Это grounding, а не semantic approval. Ноль/несколько (включая перекрывающиеся) совпадений, неизвестный source, несогласованный mapping/токен — закрытый отказ. Нет fuzzy/case/Unicode нормализации и выбора первого совпадения; уникальность можно получить более полной дословной цитатой. Приватное значение, которого не было в provider source, не принимается как угаданная цитата.

Три разные категории: перенос дня→targetDate, точное время встречи→scheduledAt, явный крайний срок→deadline. Проверяются grounded исходные цитаты и scope; модельный field не является authority. Ошибочный deadline не переписывается в targetDate: mismatch/неподтверждённое намерение отклоняются. Bounded temporal guard не является полным NL date parser: нормализация значений/timezone остаётся этапом55; неподдержанный случай не угадывается.

Oracle C016/C034 проверяет точный набор user-visible полей: только targetDate у date-only переноса, без rename/description/clear/scheduledAt/deadline. У Complete нет временных/переименовывающих patches; покупка не получает дату переноса. Требуются собственный unit scope, два независимых groups с правильными outcomes, отсутствие ложных межкомандных shared_time/depends_on/same_target. Проверяются targets и сохранность остальных полей черновика. Здесь нет доказательства реального изменения Task rows: владение execution и техническими version/updatedAt/completedAt сохраняет Stage2.

[Машинный локальный replay](stage-3-quote-contract-local.json) доказывает отдельно:

|Сохранённый ответ attempt2|Точные диапазоны из цитат|Смысл и усиленный oracle|
|---|---|---|
|C015|PASS|PASS: мутаций нет|
|C016|PASS|FAIL: deadline вместо targetDate, shared_time с завершением, объединённые независимые действия|
|C034|PASS|FAIL: deadline вместо targetDate; ожидаемый date-only patch отсутствует|

Offline projection удаляет только устаревшие числовые координаты и меняет внешний version tag; исходные цитаты, labels, temporal fields, scope, groups и relations не исправляются. Это не новые ответы модели и не пересмотр9/12 второго probe. Исходные отчёты/freeze/results обеих попыток сохранены неизменно. Производный файл содержит исходные ошибочные temporal drafts/relations; проверки не мутируют decision.

Целевые тесты: RED на отсутствующих QuoteGrounder/temporal oracle; затем23/23 в6файлах (контракт, FakeHTTP, budget, сохранённые ответы, Unicode/unique matching, SourceMap, source intent, changed/unchanged fields и independence). После уточнения source-temporal guard — профильные8/8 и итоговый затронутый набор23/23; полный gate не запускался. Typecheck/architecture PASS. Checks про unknown sources,0/2+matches, overlapping matches, raw-private guesses, SourceMap mismatch, неверные field/scope/rename/clear/extra schedule/deadline и merged groups проходят. Live dispatcher закрыт; никакой старый probe не переисполнялся.

Следующий probe требует отдельного согласования и новой заморозки prompt/schema/cases/runner. Сейчас профиль не объявляется квалифицированным, критерии safety12/12/exact≥11/12 не снижены; предыдущие FAIL остаются FAIL.
