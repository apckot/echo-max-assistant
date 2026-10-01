import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabase } from '../../../src/infrastructure/postgres/database.js';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import type { UserId } from '../../../src/shared/types/identity.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const migrations = fileURLToPath(new URL('../../../migrations', import.meta.url));
type Identity = { user_id: UserId; channel_account_id: string; conversation_id: string };

describe('runtime identity RLS', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let gateway: Pool;
  let worker: Pool;
  let database: ReturnType<typeof createDatabase>;
  let a: Identity;
  let b: Identity;

  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    const adminUrl = new URL(postgres.pool.options.connectionString!);
    const roleUrl = (role: string) => {
      const url = new URL(adminUrl);
      url.username = `echo_${role}`;
      url.password = 'isolated-test-password';
      return url.toString();
    };
    for (const role of ['migrator', 'gateway', 'worker', 'delivery', 'scheduler']) {
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    }
    migrator = new Pool({ connectionString: roleUrl('migrator') });
    await runMigrations(migrator, migrations);
    gateway = new Pool({ connectionString: roleUrl('gateway') });
    worker = new Pool({ connectionString: roleUrl('worker') });
    database = createDatabase({
      gateway: roleUrl('gateway'), worker: roleUrl('worker'),
      delivery: roleUrl('delivery'), scheduler: roleUrl('scheduler'), poolSize: 1,
    });
    a = (await gateway.query<Identity>(
      "SELECT * FROM public.resolve_or_create_max_identity('101', '201', 'bot_started')",
    )).rows[0]!;
    b = (await gateway.query<Identity>(
      "SELECT * FROM public.resolve_or_create_max_identity('102', '202', 'bot_started')",
    )).rows[0]!;
  }, 120_000);

  afterAll(async () => {
    await database?.close();
    await worker?.end();
    await gateway?.end();
    await migrator?.end();
    await postgres?.stop();
  });

  test.each([
    ['users', 'id', 'timezone', 'Europe/Moscow'],
    ['channel_accounts', 'id', 'state', 'active'],
    ['conversations', 'id', 'state', 'active'],
  ] as const)('%s exposes only the current tenant for reads and updates', async (table, key, column, original) => {
    const idA = table === 'users' ? a.user_id : table === 'channel_accounts' ? a.channel_account_id : a.conversation_id;
    const idB = table === 'users' ? b.user_id : table === 'channel_accounts' ? b.channel_account_id : b.conversation_id;
    const changed = table === 'users' ? 'UTC' : 'stopped';
    const visible = await database.tenantTransaction('worker', a.user_id, (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM public.${table} ORDER BY id`));
    expect(visible).toEqual([{ id: idA }]);
    const foreignUpdate = await database.tenantTransaction('worker', a.user_id, (tx) =>
      tx.query(`UPDATE public.${table} SET ${column} = $1 WHERE ${key} = $2 RETURNING id`, [changed, idB]));
    expect(foreignUpdate).toEqual([]);
    const ownUpdate = await database.tenantTransaction('worker', a.user_id, (tx) =>
      tx.query(`UPDATE public.${table} SET ${column} = $1 WHERE ${key} = $2 RETURNING id`, [changed, idA]));
    expect(ownUpdate).toEqual([{ id: idA }]);
    const foreignValue = await database.tenantTransaction('worker', b.user_id, (tx) =>
      tx.query(`SELECT ${column} AS value FROM public.${table} WHERE ${key} = $1`, [idB]));
    expect(foreignValue).toEqual([{ value: original }]);
  });

  test('WITH CHECK prevents moving an owned account or conversation to another tenant', async () => {
    for (const [table, id] of [
      ['channel_accounts', a.channel_account_id], ['conversations', a.conversation_id],
    ] as const) {
      const client = await worker.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.user_id', $1, true)", [a.user_id]);
        await expect(client.query(`UPDATE public.${table} SET user_id = $1 WHERE id = $2`, [b.user_id, id]))
          .rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      const rows = await database.tenantTransaction('worker', a.user_id, (tx) =>
        tx.query<{ user_id: string }>(`SELECT user_id FROM public.${table} WHERE id = $1`, [id]));
      expect(rows).toEqual([{ user_id: a.user_id }]);
    }
  });

  test('worker without tenant context sees no identity rows and pooled context does not leak', async () => {
    for (const table of ['users', 'channel_accounts', 'conversations']) {
      const within = await database.tenantTransaction('worker', a.user_id, (tx) =>
        tx.query(`SELECT id FROM public.${table}`));
      expect(within).toHaveLength(1);
      const without = await database.systemTransaction('worker', (tx) =>
        tx.query(`SELECT id FROM public.${table}`));
      expect(without).toEqual([]);
      const other = await database.tenantTransaction('worker', b.user_id, (tx) =>
        tx.query(`SELECT id FROM public.${table}`));
      expect(other).toHaveLength(1);
      expect(other).not.toEqual(within);
    }
  });

  test('runtime INSERT and gateway general reads stay denied while gateway resolve works', async () => {
    await expect(database.tenantTransaction('worker', a.user_id, (tx) =>
      tx.query('INSERT INTO public.users (id) VALUES ($1)', [b.user_id])))
      .rejects.toMatchObject({ code: 'DB_FAILURE' });
    for (const table of ['users', 'channel_accounts', 'conversations']) {
      await expect(database.tenantTransaction('gateway', a.user_id, (tx) =>
        tx.query(`SELECT id FROM public.${table}`))).rejects.toMatchObject({ code: 'DB_FAILURE' });
    }
    const resolved = await gateway.query<Identity>(
      "SELECT * FROM public.resolve_or_create_max_identity('101', '201', 'message_created')",
    );
    expect(resolved.rows[0]).toMatchObject({
      user_id: a.user_id, channel_account_id: a.channel_account_id,
      conversation_id: a.conversation_id,
    });
  });

  test('application roles cannot own identity tables or bypass RLS', async () => {
    expect((await worker.query('SELECT current_user AS role')).rows).toEqual([{ role: 'echo_worker' }]);
    expect((await gateway.query('SELECT current_user AS role')).rows).toEqual([{ role: 'echo_gateway' }]);
    const roles = await postgres.pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
       WHERE rolname IN ('echo_gateway', 'echo_worker', 'echo_delivery', 'echo_scheduler') ORDER BY rolname`,
    );
    expect(roles.rows).toHaveLength(4);
    expect(roles.rows.every((role) => !role.rolsuper && !role.rolbypassrls)).toBe(true);
    const owners = await postgres.pool.query<{ owner: string }>(
      `SELECT relowner::regrole::text AS owner FROM pg_class
       WHERE oid IN ('public.users'::regclass, 'public.channel_accounts'::regclass, 'public.conversations'::regclass)`,
    );
    expect(owners.rows).toEqual([{ owner: 'echo_migrator' }, { owner: 'echo_migrator' }, { owner: 'echo_migrator' }]);
  });
});
