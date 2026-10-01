import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createDatabase, type UserId } from '../../../src/infrastructure/postgres/database.js';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const migrationDirectory = fileURLToPath(new URL('../../../migrations', import.meta.url));
const testPassword = 'isolated-test-password';
const roles = ['gateway', 'worker', 'delivery', 'scheduler', 'migrator'] as const;
const userId = 'c6265e38-aab8-4484-99cb-18eb7fe0f0c5' as UserId;

describe('PostgreSQL roles and transaction boundaries', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let database: ReturnType<typeof createDatabase>;
  let urls: Record<(typeof roles)[number], string>;

  beforeAll(async () => {
    postgres = await startPostgres();
    const bootstrap = await readFile(`${root}bootstrap/roles.sql`, 'utf8');
    await postgres.pool.query(bootstrap);
    const adminUrl = new URL(postgres.pool.options.connectionString!);
    urls = Object.fromEntries(roles.map((role) => {
      const url = new URL(adminUrl);
      url.username = `echo_${role}`;
      url.password = testPassword;
      return [role, url.toString()];
    })) as typeof urls;
    for (const role of roles) {
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD '${testPassword}'`);
    }
    const databaseName = decodeURIComponent(adminUrl.pathname.slice(1));
    await postgres.pool.query(`ALTER DATABASE "${databaseName.replaceAll('"', '""')}" OWNER TO echo_migrator`);
    migrator = new Pool({ connectionString: urls.migrator });
    await runMigrations(migrator, migrationDirectory);
    database = createDatabase({
      gateway: urls.gateway,
      worker: urls.worker,
      delivery: urls.delivery,
      scheduler: urls.scheduler,
      poolSize: 1,
    });
  }, 120_000);

  afterAll(async () => {
    await database?.close();
    await migrator?.end();
    await postgres?.stop();
  });

  test('fresh credentials are confined to non-bypass, non-owner roles', async () => {
    const result = await postgres.pool.query<{
      rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean;
    }>(`SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles
       WHERE rolname LIKE 'echo_%' ORDER BY rolname`);
    expect(result.rows.map((row) => row.rolname)).toEqual(roles.map((role) => `echo_${role}`).sort());
    for (const row of result.rows) {
      expect([row.rolsuper, row.rolbypassrls, row.rolcreaterole]).toEqual([false, false, false]);
    }
    for (const role of roles.filter((name) => name !== 'migrator')) {
      const pool = new Pool({ connectionString: urls[role] });
      try {
        expect((await pool.query('SELECT current_user AS role')).rows[0]?.role).toBe(`echo_${role}`);
        await expect(pool.query('CREATE TABLE public.forbidden_migration (id int)'))
          .rejects.toMatchObject({ code: '42501' });
        await expect(runMigrations(pool, migrationDirectory)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await pool.end();
      }
    }
  });

  test('rejects a migrator credential assigned to an application pool', () => {
    expect(() => createDatabase({
      gateway: urls.migrator,
      worker: urls.worker,
      delivery: urls.delivery,
      scheduler: urls.scheduler,
    })).toThrowError(expect.objectContaining({ code: 'DB_ROLE_MISMATCH' }));
  });

  test('rejects a URL whose query parameters override the application role', async () => {
    const overridden = new URL(urls.gateway);
    overridden.searchParams.set('user', 'echo_migrator');
    overridden.searchParams.set('password', testPassword);
    const probe = new Pool({ connectionString: overridden.toString() });
    try {
      expect((await probe.query('SELECT current_user AS role')).rows[0]?.role).toBe('echo_migrator');
    } finally {
      await probe.end();
    }
    expect(() => createDatabase({
      gateway: overridden.toString(),
      worker: urls.worker,
      delivery: urls.delivery,
      scheduler: urls.scheduler,
    })).toThrowError(expect.objectContaining({ code: 'DB_ROLE_MISMATCH' }));
  });

  test('accepts a correct-role URL with a query password', async () => {
    const gatewayUrl = new URL(urls.gateway);
    gatewayUrl.password = '';
    gatewayUrl.searchParams.set('password', testPassword);
    const withQueryPassword = createDatabase({
      gateway: gatewayUrl.toString(),
      worker: urls.worker,
      delivery: urls.delivery,
      scheduler: urls.scheduler,
    });
    try {
      const rows = await withQueryPassword.systemTransaction('gateway', (tx) =>
        tx.query<{ role: string }>('SELECT current_user AS role'));
      expect(rows).toEqual([{ role: 'echo_gateway' }]);
    } finally {
      await withQueryPassword.close();
    }
  });

  test('tenant transaction sets local user context and bounded timeouts, then clears it on reuse', async () => {
    const inside = await database.tenantTransaction('worker', userId, async (tx) => {
      const rows = await tx.query<{ role: string; user_id: string; statement_timeout: string; lock_timeout: string }>(
        `SELECT current_user AS role, current_setting('app.user_id', true) AS user_id,
           current_setting('statement_timeout') AS statement_timeout,
           current_setting('lock_timeout') AS lock_timeout`,
      );
      return rows[0];
    });
    expect(inside).toEqual({
      role: 'echo_worker', user_id: userId, statement_timeout: '5s', lock_timeout: '1s',
    });
    const outside = await database.systemTransaction('worker', async (tx) =>
      tx.query<{ user_id: string | null }>("SELECT current_setting('app.user_id', true) AS user_id"));
    expect(outside[0]?.user_id).toBeFalsy();
    expect('pool' in database).toBe(false);
  });

  test('gateway transaction enforces a 150 ms statement timeout', async () => {
    const rows = await database.systemTransaction('gateway', (tx) =>
      tx.query<{ statement_timeout: string }>("SHOW statement_timeout"));
    expect(rows[0]).toEqual({ statement_timeout: '150ms' });
    await expect(database.systemTransaction('gateway', (tx) => tx.query('SELECT pg_sleep(0.2)')))
      .rejects.toMatchObject({ code: 'DB_TIMEOUT' });
  });

  test('rejects missing or malformed internal user ids before invoking tenant work', async () => {
    let invoked = false;
    for (const invalid of ['', 'external-id', '00000000-0000-0000-0000-000000000000']) {
      await expect(database.tenantTransaction('worker', invalid as UserId, async () => {
        invoked = true;
      })).rejects.toMatchObject({ code: 'DB_INVALID_USER_ID' });
    }
    expect(invoked).toBe(false);
  });

  test('rolls back callback failures and hides SQL diagnostics behind closed codes', async () => {
    await migrator.query('CREATE TABLE public.transaction_probe (id int)');
    await migrator.query('GRANT INSERT, SELECT ON public.transaction_probe TO echo_worker');
    await expect(database.tenantTransaction('worker', userId, async (tx) => {
      await tx.query('INSERT INTO public.transaction_probe (id) VALUES (1)');
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect((await migrator.query('SELECT count(*)::int AS count FROM public.transaction_probe')).rows[0])
      .toEqual({ count: 0 });
    await expect(database.systemTransaction('worker', (tx) => tx.query('SELECT 1 / 0')))
      .rejects.toMatchObject({ code: 'DB_FAILURE', message: 'Database operation failed' });
    await expect(database.systemTransaction('worker', async (tx) => {
      await tx.query("SELECT set_config('statement_timeout', '10ms', true)");
      await tx.query('SELECT pg_sleep(0.1)');
    }))
      .rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    const after = await database.systemTransaction('worker', (tx) => tx.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM public.transaction_probe',
    ));
    expect(after).toEqual([{ count: 0 }]);
  });

  test('discards a still-queryable client when rollback fails', async () => {
    const originalConnect = Pool.prototype.connect;
    let failedRollback = false;
    const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation(async function (this: Pool) {
      const client = await originalConnect.call(this);
      if (!failedRollback) {
        const originalQuery = client.query.bind(client);
        client.query = ((...args: Parameters<typeof client.query>) => {
          if (args[0] === 'ROLLBACK') {
            failedRollback = true;
            return Promise.reject(new Error('injected rollback failure'));
          }
          return originalQuery(...args);
        }) as typeof client.query;
      }
      return client;
    });
    try {
      let failedPid: number | undefined;
      await expect(database.systemTransaction('worker', async (tx) => {
        failedPid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid;
        throw new Error('callback failure');
      })).rejects.toThrow('callback failure');
      expect(failedRollback).toBe(true);
      const rows = await database.systemTransaction('worker', (tx) =>
        tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'));
      expect(rows[0]?.pid).not.toBe(failedPid);
    } finally {
      connect.mockRestore();
    }
  });
});
