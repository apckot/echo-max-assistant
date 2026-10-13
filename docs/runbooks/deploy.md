# Развёртывание Echo MAX на новом сервере

Единая точка входа — `ops/deploy/deploy.sh`. Она выполняется **на новом целевом сервере**, не подключается по SSH и не меняет текущий `nwc-kz`. Используются существующие Dockerfile, четыре systemd-шаблона, nginx locations, bootstrap ролей и migration runner. Это установка с новой БД; перенос данных описан в [backup/restore](backup-restore.md).

## До запуска

1. Подготовьте Ubuntu24.04 LTS, root/sudo-доступ, минимум2 vCPU,2 ГБ RAM и20 ГБ свободного диска. Размер диска увеличивайте с учётом данных и резервных копий. Для checkout нужны `git` и `python3`; остальные зависимости устанавливает скрипт. Docker должен поддерживать архитектуру сервера. По SSH используйте отдельного sudo-пользователя `deploy` и согласованный alias нового сервера; имя alias не передаётся установщику.
2. Настройте DNS `A` домена на публичный IPv4 нового сервера. `AAAA` добавляйте только при работающем IPv6 до nginx. Откройте входящие TCP22,80,443 и исходящий HTTPS/DNS к registries, Ubuntu mirrors, Let's Encrypt, MAX и источнику MAX CA. TCP80 нужен также для продления TLS. PostgreSQL наружу не публикуется; gateway привязывается к `127.0.0.1:18080`. Скрипт не меняет firewall, DNS или VPN. На80/443 должен работать nginx либо порты должны быть свободны; чужой nginx vhost этого домена — конфликт, а не разрешение перезаписать его.
3. Создайте чистый checkout согласованного коммита в `/opt/echo-max-assistant`. Новый SHA считается новой версией установки: повторный запуск с другой версией намеренно отклоняется. Обновления существующей установки требуют отдельного согласованного rollout.
4. Подготовьте токен отдельного тестового MAX-бота, доступного только согласованному тестировщику. Не используйте токен занятого рабочего бота: обнаруженная подписка на другой URL вызывает отказ. Runtime Stage1 не содержит allowlist получателей; доступ к тестовому боту ограничивает владелец. Флаг `foundation_echo_enabled` явно разрешает ответы Stage1.

## Приватная конфигурация

В защищённом редакторе создайте `/root/echo-max-token.txt` (только токен либо строка `max-bot-token=...`) и `/root/echo-max-deploy.json`. Оба файла должны принадлежать root и иметь права0600. Секреты не передавайте через shell arguments, чат или Git; не включайте `set -x`. JSON содержит путь к токену, а не сам токен:

```json
{
  "domain": "your-domain.example",
  "email": "owner@example.org",
  "token_file": "/root/echo-max-token.txt",
  "gateway_port": 18080,
  "foundation_echo_enabled": true
}
```

Кириллический домен допустим: скрипт преобразует его в IDNA. Email используется для сертификата Let's Encrypt. `gateway_port` должен быть свободным локальным портом1024–65535.

```sh
sudo chmod 600 /root/echo-max-token.txt /root/echo-max-deploy.json
cd /opt/echo-max-assistant
sudo ./ops/deploy/deploy.sh --config /root/echo-max-deploy.json --plan
sudo ./ops/deploy/deploy.sh --config /root/echo-max-deploy.json
```

`--plan` проверяет формат и права конфигурации, выводит только домен/локальный порт/этапы. Он не устанавливает пакеты, не проверяет сеть и не меняет сервер. Запуск без `--plan` изменяет только выбранный сервер. Его вывод — названия этапов и безопасные коды ошибок; вывода дочерних команд и секретов нет. Последний этап `ready` означает успешные автоматические проверки установки, а не результат реального canary.

## Что создаёт скрипт

- Docker, nginx и certbot; приватную сеть `echo-max`, volume `echo-max-pgdata` и отдельный контейнер PostgreSQL17 `echo-max-postgres17`. PostgreSQL ограничен256 MiB RAM; runtime —128 MiB каждый. БД и Docker-ресурсы помечены владельцем установщика; неизвестные существующие ресурсы не усыновляются.
- Отдельные пароли admin, migrator и четырёх runtime; bootstrap ролей без superuser/bypassRLS и checksum-проверенные миграции. Подготовка начинается с закрытых runtime fences. Чистая новая БД открывается только после проверки схемы; восстановленная БД и ручной fence требуют оператора.
- Образ `echo-max:<первые12символов-SHA>` из whitelist файлов **коммита**, без `secrets.txt`, `.env`, приватных каталогов или полного рабочего дерева. Четыре unit `echo-max-{gateway,worker,delivery,scheduler}.service` используют один образ, собственный DB URL, read-only filesystem и существующие ограничения systemd/Docker.
- Защищённый каталог `/etc/echo-max` (0700), `install-state.json`, env-файлы и `passwords.json` (0600). Состояние содержит секреты: не выводите его в отчёт. Сохраняйте его вместе с БД в защищённой процедуре резервирования; потеря файла не разрешает сброс паролей или пересоздание volume.
- Отдельный nginx vhost `/etc/nginx/conf.d/echo-max.conf`, сертификат `/etc/letsencrypt/live/echo-max`, certbot timer и ограниченный renewal hook. Временный HTTP challenge подтверждает, что DNS ведёт к этому серверу; затем проверяется публичный TLS. Публичный `/ops` не открывается. MAX CA добавляется только контейнерам Echo MAX, без изменения глобального trust store.
- Scheduler регистрирует `https://<domain>/webhooks/max` с отдельным webhook secret и четырьмя типами событий. Проверяются локальная schema/readiness, статус subscription и фактический список подписок MAX. Secrets передаются через защищённые файлы и заголовки, не URL/argv.

## Повторный запуск и ошибки

Повторите ту же команду с тем же SHA, доменом, портом и ботом. Существующие данные, пароли и сертификаты сохраняются; миграции повторно не применяются. Runtime перезапускаются для согласованной конфигурации, поэтому повторный запуск не обещает нулевой downtime. Токен можно перевыпустить для **того же** бота в приватном файле. Третий полный gate для этого не нужен: скрипт не запускает project gate.

Скрипт отказывается менять чужие units/drop-ins, env-каталог, сертификат, Docker-ресурсы и vhost домена. На ошибке nginx возвращается предыдущий файл конфигурации. После начала активации runtime ошибка возвращает их env-fence в `on` и останавливает только четыре принадлежащих установщику units. Уже созданные Docker-ресурсы, установленное ПО и данные сохраняются для диагностики; это не транзакционный rollback всей ОС. Повторное открытие ручного/restore-fence запрещено.

При ошибке сохраните только `phase` и `code`, проверьте соответствующий prerequisite. Не публикуйте полный journal, env или MAX response. Резервирование/WAL, off-host storage, мониторинг и перенос существующей БД остаются в [operations runbook](backup-restore.md); установка не доказывает их готовность.

После `ready` выполните отдельный [реальный MAX canary](foundation-canary.md): владелец открывает тестового бота, нажимает «Старт» и отправляет согласованное тестовое сообщение. Настройка HTTPS/webhook не заменяет этот сценарий. Callback остаётся условием приёмки этапа с кнопками.

## Локальные проверки установщика

```sh
python3 -m unittest discover -s tests/deploy -p test_deploy.py -v
git archive HEAD package.json package-lock.json tsconfig.json src migrations deploy/Dockerfile | docker build -f deploy/Dockerfile -t echo-max:deploy-test -
ECHO_MAX_TEST_IMAGE=echo-max:deploy-test python3 -m unittest discover -s tests/deploy -p test_database.py -v
npm run typecheck
npm run lint:architecture
```

Node22 требуется только для проектных npm-проверок; серверный app build использует Dockerfile. Docker-тест создаёт отдельную временную сеть/контейнер, проверяет роли, миграции, сохранение данных и отказ при restore-fence/checksum conflict, затем удаляет только свои тестовые ресурсы. Без `ECHO_MAX_TEST_IMAGE` этот тест пропускается — такой запуск не является доказательством PostgreSQL-проверки. Реальные DNS, certbot и MAX в локальных тестах не вызываются.

Локальное подтверждение реализации,2026-10-13:13/13 deployment-тестов прошли, включая отдельный PostgreSQL17; Docker build из committed application files, shell entrypoint `--plan`, typecheck под Node22 и architecture guard прошли. Начальный RED: отсутствующий installer; отдельный регрессионный RED/GREEN: ручной runtime-fence при повторном запуске. Текущий сервер не изменялся, новые агенты и полный project gate не запускались. Реальный выпуск TLS, регистрация webhook и canary на новом хосте остаются внешней проверкой после согласования его параметров.
