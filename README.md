# Echo MAX Assistant foundation

This checkpoint uses PostgreSQL 17 and Node 22. From a clean checkout:

```sh
npm exec --yes --package=node@22 --package=npm@11.16.0 -- npm ci
npm exec --yes --package=node@22 --package=npm@11.16.0 -- npm run verify
```

The functional tests start an isolated PostgreSQL 17 container. Docker must be available. They create synthetic role passwords inside that disposable database and verify real role-specific connections, migration permissions, transaction rollback, and pooled context reset.

## Database setup

The first step is a **one-time DBA bootstrap**, run against a fresh, dedicated database on an isolated PostgreSQL 17 cluster. Set `DATABASE_URL_DBA` in your shell or secret manager to a DBA connection for that database, then run:

```sh
psql "$DATABASE_URL_DBA" -v ON_ERROR_STOP=1 -f bootstrap/roles.sql
```

The bootstrap creates the five login roles, makes `echo_migrator` the database owner, removes public database access, and grants application roles `CONNECT` only. It intentionally has no passwords. Provision five distinct passwords through your secret manager or `psql`'s interactive `\password echo_migrator`, `\password echo_gateway`, `\password echo_worker`, `\password echo_delivery`, and `\password echo_scheduler` commands. Do not use the DBA connection in the application.

Set `DATABASE_URL_MIGRATIONS` to the `echo_migrator` connection. Run routine migrations with that credential:

```sh
npm exec --yes --package=node@22 --package=npm@11.16.0 -- npm run build
npm exec --yes --package=node@22 -- node --input-type=module -e 'import {Pool} from "pg"; import {runMigrations} from "./dist/infrastructure/postgres/migrations.js"; const pool = new Pool({connectionString: process.env.DATABASE_URL_MIGRATIONS}); try { await runMigrations(pool, "migrations"); } finally { await pool.end(); }'
```

Finally set the four separate `DATABASE_URL_GATEWAY`, `DATABASE_URL_WORKER`, `DATABASE_URL_DELIVERY`, and `DATABASE_URL_SCHEDULER` credentials from the corresponding roles. The application transaction API checks each URL's role name and keeps its pools private. Only the migrator owns schema changes; application roles have no schema `CREATE` privilege and no general RLS bypass. Later migrations grant narrow table and function permissions as those objects are introduced.

Gateway transactions currently set a 150 ms PostgreSQL `statement_timeout` for each statement. This is not a deadline for the whole transaction; the total gateway transaction deadline belongs to gateway integration in iteration 15.
