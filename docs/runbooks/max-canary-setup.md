# Подготовка реального MAX canary

Статус: внешний canary ожидает инфраструктуру и credentials. Эта инструкция ничего не создаёт и не отправляет автоматически. Реальные токены, webhook secret, provider IDs и приватные события остаются в локальном защищённом окружении; не отправляйте их в чат, отчёт или Git.

1. **Создайте отдельного тестового бота.** На [MAX для партнёров](https://business.max.ru) войдите в верифицированный профиль организации, ИП или самозанятого: «Чат-боты → Создать». Заполните карточку и дождитесь модерации. После неё: карточка бота → ⋮ → Настройки → скопировать токен в защищённый secret store. Оставьте запрет добавления в групповые чаты и не распространяйте ссылку на тестового бота. Официальные инструкции: [создание](https://dev.max.ru/docs/chatbots/bots-create/create), [настройки и токен](https://dev.max.ru/docs/chatbots/bots-create/manage). Если подходящего профиля нет, его подключение/верификация — действие владельца; обычный личный профиль не заменяет его.

2. **Подготовьте тестовый endpoint.** На одобренном тестовом сервере/домене разверните PostgreSQL17, миграции, gateway и nginx/TLS по [operations runbook](backup-restore.md). В `MAX_WEBHOOK_URL` укажите `https://<ваш-тестовый-домен>/webhooks/max`, без токена, query-параметров и явного порта. Это публичный адрес gateway, не адрес MAX API; nginx принимает HTTPS/443 и проксирует на gateway8080. Нужны доверенный сертификат с полной цепочкой, совпадающий домен и доступность из MAX. Самоподписанный сертификат/localhost не подходит. См. [требования к webhook](https://dev.max.ru/docs-api/methods/POST/subscriptions). Worker/delivery пока остановлены.

3. **Настройте приватные env-файлы.** На сервере используйте `/etc/echo-max/ROLE.env` и отдельный `canary.env`, права0600; локально допустим игнорируемый `.env`. Значения секретов вводите непосредственно в secret store/защищённый редактор, без вывода в terminal history/logs. Каждый runtime получает только URL своей DB-роли; migration URL остаётся у offline migrator.

| Переменная | Что настроить |
|---|---|
|`MAX_BOT_TOKEN`|Токен только отдельного тестового бота|
|`MAX_WEBHOOK_SECRET`|Отдельный случайный secret; например32 случайных байта в hex, допустимы латиница/цифры/underscore/дефис, длина5–256; не bot token|
|`MAX_WEBHOOK_SECRET_VERSION`|Метка версии, например `v1`|
|`MAX_WEBHOOK_URL`|HTTPS URL из шага2|
|`DATABASE_URL_GATEWAY`, `DATABASE_URL_WORKER`, `DATABASE_URL_DELIVERY`, `DATABASE_URL_SCHEDULER`|URL отдельной тестовой БД с соответствующим echo_ROLE; один URL на runtime|
|`DATABASE_URL_MIGRATIONS`|Только offline миграции: echo_migrator; не передавать runtime|
|`OPS_HEALTH_TOKEN`|Отдельный secret для приватного ops endpoint|
|`FOUNDATION_ECHO_ENABLED`|`true` для тестового Stage1 runtime в production mode|
|`RESTORE_FENCE`|Сначала `on`; `off` только после проверки схемы/checksums и DB fence. Restored DB проходит restore runbook перед reopen|
|`MAX_CANARY_TEST_USER_ID`|ID своего согласованного тестового аккаунта, см. шаг4; не chat_id и не ID бота|
|`MAX_CANARY_TEST_CONFIRMED`|`true` только после подтверждения, что аккаунт выбран безопасно и согласен получать тестовые ответы|

4. **Выберите безопасного получателя.** Используйте свой MAX-аккаунт или отдельный аккаунт добровольного тестировщика, в личном диалоге с новым тестовым ботом. Для получения ID запустите только gateway и scheduler на проверенной тестовой БД, сняв fences по runbook; worker/delivery оставьте остановленными. Scheduler создаёт подписку с тем же secret на четыре события: message_created, message_callback, bot_started, bot_stopped. Затем тестовый участник открывает бота и нажимает «Старт». В приватном аутентифицированном webhook `bot_started` возьмите `user.user_id` (для text — `message.sender.user_id`); после приёма он хранится как `channel_accounts.external_user_id` в тестовой БД. Проверяйте событие/ID только локально, без публичного логирования body/headers; временный приватный capture удалите. Сохраните ID в `canary.env`, затем выставьте подтверждение. Флаги canary — preflight-проверка оператора, **не runtime allowlist**: не давайте бот другим людям; при неизвестном участнике остановите запуск и очистите тестовую очередь перед включением delivery. Описание событий: [Update](https://dev.max.ru/docs-api/objects/Update).

5. **Проверьте подготовку и выполните canary.** Из checkout с Node22 выполните `node --env-file=/etc/echo-max/canary.env ops/canary/preflight.mjs`. Он выводит только readiness/названия отсутствующих переменных, не значения, и не обращается в сеть. После успешного preflight, проверки subscription/health и состава очереди включите worker/delivery и выполните [canary checklist](foundation-canary.md): настоящий text, duplicate replay, stop/start, restart worker, voice с сохранённым capability_unavailable. Сохраняйте только case outcome, время и SHA. Успех этих внешних сценариев требуется отдельно для завершения Stage1; gate/FakeMAX его не заменяют.

Требуется от владельца: доступ к подходящему MAX partner profile/тестовому боту, приватно установленные credentials, одобренный доступный HTTPS endpoint и согласованный тестовый аккаунт. Следующий этап автоматически не начинается.
