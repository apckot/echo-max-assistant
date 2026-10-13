# Checkpoint40 cumulative review

One independent read-only reviewer (Sol/high), range a462564..33aeeca; no delegation, edits or full gate by reviewer.

Initial verdict: request changes, three P2 findings confirmed by narrow Node22/PG17 diagnostics:

1. valid_task_receipt accepted JSON null outcome and returned SQL NULL for rejected error.code=null; CHECK accepted NULL. Fix: scalar types checked explicitly, rejected validator returns boolean, CHECK requires IS TRUE. Regression covers outcome/effectKey/command kind/outcome/error code null and a real worker INSERT.
2. Intl accepted europe/moscow but pg_timezone_names exact match rejected it. Further fix investigation found Intl Asia/Kolkata→Asia/Calcutta, absent from PG catalogue. Fix: typed creation resolves compatible PG names before fingerprint/storage using raw case-normalised catalogue name first, Intl canonical fallback; unsupported names produce invalid_timezone. Tests cover casing/replay and US/Eastern/Asia/Kolkata aliases with actual PG storage and temporal semantics.
3. Explicit undefined patch values could clear deadline or produce undefined required title. Fix: reject undefined command values before Zod optional parsing; only null clears nullable fields. Targeted regression covers title/deadline/date/description and mixed patches.

Same executor fixed all findings in one checkpoint fix commit. Targeted RED: three new regressions fail; GREEN: five files39PASS, typecheck/architecture PASS. Scoped confirmation by the same reviewer pending; no new audit or reviewer.

Outside this checkpoint: persistent existing-target execution41; atomic groups42; queries/day boundaries43/49; history read API44; erasure45; inbound/outbox bridge46; real lost-COMMIT/races47; ownership guard48; final load/restore50; production deployment and real MAX callbacks. These are accepted deferrals, not claims of passing tests. Checkpoint40 remains isolated-test-only.

Scoped check: SQL-null and undefined closed; resolver output still renamed Kolkata to unavailable Calcutta. Same executor added resolver→create regression, preserved original timezone in TemporalResult. RED reproduced rejected meeting; GREEN create10 + time4, typecheck/architecture PASS. Only this remaining finding awaits scoped closure by the existing reviewer.

Final scoped verdict on acb8f2d: **all three original findings closed; approve reviewed fixes**. Resolver preserves input timezone in both success paths; real resolver→create regression verifies persisted Kolkata and UTC instant. No new reviewer/audit and no tests rerun by reviewer for this closure.
