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
    await migrator.query('CREATE TABLE public.deadline_probe (id int)');
    await migrator.query('GRANT INSERT ON public.deadline_probe TO echo_gateway, echo_worker');
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

  test('classifies PostgreSQL invalid UTF-8 text input as typed invalid input', async () => {
    await expect(database.systemTransaction('worker', (tx) => tx.query('SELECT $1::text', ['key\u0000'])))
      .rejects.toMatchObject({ code: 'DB_INVALID_INPUT', message: 'Database input invalid' });
  });

  test('gateway deadline covers cumulative statements and rolls back prior effects', async () => {
    const started = performance.now();
    await expect(database.systemTransaction('gateway', async (tx) => {
      await tx.query('INSERT INTO public.deadline_probe VALUES (1)');
      await tx.query('SELECT pg_sleep(0.09)');
      await tx.query('SELECT pg_sleep(0.09)');
    })).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(500);
    expect((await migrator.query('SELECT * FROM public.deadline_probe')).rows).toEqual([]);
    expect(await database.systemTransaction('gateway', (tx) => tx.query('SELECT 1 AS healthy')))
      .toEqual([{ healthy: 1 }]);
  });

  test('suspended callback expires, releases the only connection, and cannot write or commit later', async () => {
    let resume!: () => void;
    let entered!: () => void;
    const suspended = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let lateQuery: Promise<unknown> | undefined;
    const pending = database.systemTransaction('gateway', async (tx) => {
      await tx.query('INSERT INTO public.deadline_probe VALUES (2)');
      entered();
      await suspended;
      lateQuery = tx.query('INSERT INTO public.deadline_probe VALUES (3)');
      await lateQuery;
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    await ready;
    // Release after a fixed delay so the pre-deadline implementation fails cleanly too.
    const release = setTimeout(resume, 250);
    await rejected;
    expect(await database.systemTransaction('gateway', (tx) => tx.query('SELECT 1 AS healthy')))
      .toEqual([{ healthy: 1 }]);
    clearTimeout(release);
    resume();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(lateQuery).rejects.toMatchObject({ code: 'DB_CLOSED' });
    expect((await migrator.query('SELECT * FROM public.deadline_probe')).rows).toEqual([]);
  });

  test('queued pool acquisition consumes the same gateway deadline and never starts expired work', async () => {
    const originalConnect = Pool.prototype.connect;
    let releaseConnection!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { releaseConnection = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    // Hold the real, checked-out client before handing it to the transaction.
    const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementationOnce(async function (this: Pool) {
      const client = await originalConnect.call(this);
      acquired();
      await held;
      return client;
    });
    let callbackRan = false;
    const first = database.systemTransaction('gateway', async () => { callbackRan = true; });
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    await ready;
    const second = database.systemTransaction('gateway', async () => { callbackRan = true; });
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    const release = setTimeout(releaseConnection, 250);
    try {
      await Promise.all([firstRejected, secondRejected]);
      expect(callbackRan).toBe(false);
    } finally {
      clearTimeout(release);
      releaseConnection();
      connect.mockRestore();
      await Promise.allSettled([first, second]);
    }
    expect(await database.systemTransaction('gateway', (tx) => tx.query('SELECT 1 AS healthy')))
      .toEqual([{ healthy: 1 }]);
  });

  test('gateway-only database needs no other role credentials and closes after expiring suspended work', async () => {
    const gatewayOnly = createDatabase({ gateway: urls.gateway, poolSize: 1 });
    let resume!: () => void;
    let entered!: () => void;
    const suspended = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pending = gatewayOnly.systemTransaction('gateway', async (tx) => {
      await tx.query('INSERT INTO public.deadline_probe VALUES (4)');
      entered();
      await suspended;
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    await ready;
    const started = performance.now();
    try {
      await gatewayOnly.close();
      expect(performance.now() - started).toBeLessThan(500);
      await rejected;
      await expect(gatewayOnly.systemTransaction('gateway', (tx) => tx.query('SELECT 1')))
        .rejects.toMatchObject({ code: 'DB_CLOSED' });
    } finally { resume(); }
    expect((await migrator.query('SELECT * FROM public.deadline_probe')).rows).toEqual([]);
  });

  test('elapsed gateway deadline prevents commit even when a callback blocks timer delivery', async () => {
    await expect(database.systemTransaction('gateway', async (tx) => {
      await tx.query('INSERT INTO public.deadline_probe VALUES (5)');
      const until = performance.now() + 170;
      while (performance.now() < until) { /* Deliberately block the event loop. */ }
    })).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    expect((await migrator.query('SELECT * FROM public.deadline_probe')).rows).toEqual([]);
  });

  test('non-gateway callbacks retain their existing transaction lifetime', async () => {
    expect(await database.systemTransaction('worker', async (tx) => {
      await tx.query('SELECT pg_sleep(0.18)');
      return tx.query('SELECT 1 AS healthy');
    })).toEqual([{ healthy: 1 }]);
  });

  test('rejects invalid worker deadlines before opening a pool', () => {
    for (const workerTransactionTimeoutMs of [0, -1, 1.5, NaN, Infinity, 300_001]) {
      expect(() => createDatabase({ worker: urls.worker, workerTransactionTimeoutMs }))
        .toThrowError(expect.objectContaining({ code: 'DB_INVALID_INPUT' }));
    }
  });

  test('opt-in worker deadline covers cumulative SQL without changing statement and lock limits', async () => {
    const bounded = createDatabase({ worker: urls.worker, workerTransactionTimeoutMs: 150 });
    try {
      expect(await bounded.systemTransaction('worker', (tx) => tx.query(
        `SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`)))
        .toEqual([{ statement: '5s', lock: '1s' }]);
      await expect(bounded.systemTransaction('worker', async (tx) => {
        await tx.query('INSERT INTO public.deadline_probe VALUES (6)');
        await tx.query('SELECT pg_sleep(0.09)');
        await tx.query('SELECT pg_sleep(0.09)');
      })).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    } finally { await bounded.close(); }
    expect((await migrator.query('SELECT * FROM public.deadline_probe WHERE id = 6')).rows).toEqual([]);
  });

  test('worker close waits only to the callback deadline and late work cannot write or commit', async () => {
    const bounded = createDatabase({ worker: urls.worker, poolSize: 1, workerTransactionTimeoutMs: 100 });
    let resume!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let lateQuery: Promise<unknown> | undefined;
    const pending = bounded.tenantTransaction('worker', userId, async (tx) => {
      await tx.query('INSERT INTO public.deadline_probe VALUES (7)');
      entered();
      await held;
      lateQuery = tx.query('INSERT INTO public.deadline_probe VALUES (8)');
      await lateQuery;
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    await ready;
    const fallback = setTimeout(resume, 250);
    try {
      const started = performance.now();
      await Promise.all([bounded.close(), rejected]);
      expect(performance.now() - started).toBeLessThan(500);
      resume();
      await new Promise((resolve) => setImmediate(resolve));
      await expect(lateQuery).rejects.toMatchObject({ code: 'DB_CLOSED' });
      await expect(bounded.systemTransaction('worker', (tx) => tx.query('SELECT 1')))
        .rejects.toMatchObject({ code: 'DB_CLOSED' });
    } finally { clearTimeout(fallback); resume(); }
    expect((await migrator.query('SELECT * FROM public.deadline_probe WHERE id IN (7, 8)')).rows).toEqual([]);
  });

  test('worker queued acquisition expires and neither queued nor late-acquired work can begin', async () => {
    const bounded = createDatabase({ worker: urls.worker, poolSize: 1, workerTransactionTimeoutMs: 100 });
    const originalConnect = Pool.prototype.connect;
    let releaseConnection!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { releaseConnection = resolve; });
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    let queuedAcquisitionSettled = false;
    let calls = 0;
    let began = false;
    const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation(async function (this: Pool) {
      if (++calls === 1) {
        const client = await originalConnect.call(this);
        const query = client.query.bind(client);
        client.query = ((...args: Parameters<typeof client.query>) => {
          if (args[0] === 'BEGIN') began = true;
          return query(...args);
        }) as typeof client.query;
        acquired(); await held; return client;
      }
      try { return await originalConnect.call(this); }
      finally { queuedAcquisitionSettled = true; }
    });
    let callbackRan = false;
    const first = bounded.systemTransaction('worker', async () => { callbackRan = true; });
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    await ready;
    const second = bounded.systemTransaction('worker', async () => { callbackRan = true; });
    const secondRejected = expect(second).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
    const fallback = setTimeout(releaseConnection, 250);
    try {
      await Promise.all([firstRejected, secondRejected]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(queuedAcquisitionSettled).toBe(true);
      expect(callbackRan).toBe(false);
    } finally {
      clearTimeout(fallback); releaseConnection(); connect.mockRestore();
      await bounded.close();
    }
    expect(callbackRan).toBe(false);
    expect(began).toBe(false);
  });

  test('worker delayed COMMIT acknowledgement remains uncertain and discards the timed-out session', async () => {
    const bounded = createDatabase({ worker: urls.worker, poolSize: 1, workerTransactionTimeoutMs: 100 });
    const originalConnect = Pool.prototype.connect;
    let acknowledge!: () => void;
    const heldAck = new Promise<void>((resolve) => { acknowledge = resolve; });
    const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementationOnce(async function (this: Pool) {
      const client = await originalConnect.call(this);
      const query = client.query.bind(client);
      client.query = (async (...args: Parameters<typeof client.query>) => {
        const result = await query(...args);
        if (args[0] === 'COMMIT') await heldAck;
        return result;
      }) as typeof client.query;
      return client;
    });
    let previousPid: number | undefined;
    const pending = bounded.systemTransaction('worker', async (tx) => {
      previousPid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid;
      await tx.query('INSERT INTO public.deadline_probe VALUES (9)');
    });
    const fallback = setTimeout(acknowledge, 250);
    try {
      await expect(pending).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
      expect((await migrator.query('SELECT * FROM public.deadline_probe WHERE id = 9')).rows).toEqual([{ id: 9 }]);
      const next = await bounded.systemTransaction('worker', (tx) => tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'));
      expect(next[0]?.pid).not.toBe(previousPid);
    } finally {
      clearTimeout(fallback); acknowledge(); connect.mockRestore(); await bounded.close();
      await migrator.query('DELETE FROM public.deadline_probe WHERE id = 9');
    }
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
