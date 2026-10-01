import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const migrations = fileURLToPath(new URL('../../../migrations', import.meta.url));
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const accountA = '33333333-3333-4333-8333-333333333333';
const accountB = '44444444-4444-4444-8444-444444444444';
const conversationA = '55555555-5555-4555-8555-555555555555';

describe('identity schema', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  const applicationPools: Pool[] = [];

  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    const adminUrl = new URL(postgres.pool.options.connectionString!);
    const databaseName = decodeURIComponent(adminUrl.pathname.slice(1));
    await postgres.pool.query(`ALTER DATABASE "${databaseName.replaceAll('"', '""')}" OWNER TO echo_migrator`);
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
    for (const role of ['gateway', 'worker', 'delivery', 'scheduler']) {
      applicationPools.push(new Pool({ connectionString: roleUrl(role) }));
    }
  }, 120_000);

  beforeEach(async () => {
    await postgres.pool.query('TRUNCATE public.conversations, public.channel_accounts, public.users CASCADE');
  });

  afterAll(async () => {
    await Promise.all(applicationPools.map((pool) => pool.end()));
    await migrator?.end();
    await postgres?.stop();
  });

  async function seedUsers() {
    await postgres.pool.query('INSERT INTO public.users (id) VALUES ($1), ($2)', [userA, userB]);
  }

  async function seedAccounts() {
    await seedUsers();
    await postgres.pool.query(`INSERT INTO public.channel_accounts
      (id, user_id, external_user_id) VALUES ($1, $2, 'max-user-a'), ($3, $4, 'max-user-b')`,
    [accountA, userA, accountB, userB]);
  }

  test('creates internal identities with safe defaults and tenant-keyed account linkage', async () => {
    await seedAccounts();
    await postgres.pool.query(`INSERT INTO public.conversations
      (id, user_id, channel_account_id, external_conversation_id)
      VALUES ($1, $2, $3, 'max-chat-a')`, [conversationA, userA, accountA]);
    const users = await postgres.pool.query(`SELECT timezone, locale, status,
      created_at IS NOT NULL AS created, updated_at IS NOT NULL AS updated
      FROM public.users WHERE id = $1`, [userA]);
    expect(users.rows).toEqual([{ timezone: 'Europe/Moscow', locale: 'ru', status: 'active', created: true, updated: true }]);
    const account = await postgres.pool.query(`SELECT provider, state, capabilities,
      created_at IS NOT NULL AS created, updated_at IS NOT NULL AS updated
      FROM public.channel_accounts WHERE id = $1`, [accountA]);
    expect(account.rows).toEqual([{ provider: 'max', state: 'active', capabilities: {}, created: true, updated: true }]);
    const conversation = await postgres.pool.query(`SELECT provider, state, next_inbound_sequence,
      next_apply_sequence, created_at IS NOT NULL AS created, updated_at IS NOT NULL AS updated
      FROM public.conversations WHERE id = $1`, [conversationA]);
    expect(conversation.rows).toEqual([{ provider: 'max', state: 'active', next_inbound_sequence: '1',
      next_apply_sequence: '1', created: true, updated: true }]);
  });

  test('rejects duplicate provider identities while allowing distinct external ids', async () => {
    await seedAccounts();
    await expect(postgres.pool.query(`INSERT INTO public.channel_accounts
      (user_id, external_user_id) VALUES ($1, 'max-user-a')`, [userB]))
      .rejects.toMatchObject({ code: '23505' });
    await postgres.pool.query(`INSERT INTO public.conversations
      (id, user_id, channel_account_id, external_conversation_id)
      VALUES ($1, $2, $3, 'max-chat-a')`, [conversationA, userA, accountA]);
    await expect(postgres.pool.query(`INSERT INTO public.conversations
      (user_id, channel_account_id, external_conversation_id)
      VALUES ($1, $2, 'max-chat-a')`, [userB, accountB]))
      .rejects.toMatchObject({ code: '23505' });
    await postgres.pool.query(`INSERT INTO public.conversations
      (user_id, channel_account_id, external_conversation_id)
      VALUES ($1, $2, 'max-chat-b')`, [userB, accountB]);
  });

  test('rejects orphaned and cross-user account or conversation links', async () => {
    await seedAccounts();
    await expect(postgres.pool.query(`INSERT INTO public.channel_accounts
      (user_id, external_user_id) VALUES ($1, 'orphan')`, [conversationA]))
      .rejects.toMatchObject({ code: '23503' });
    await expect(postgres.pool.query(`INSERT INTO public.conversations
      (user_id, channel_account_id, external_conversation_id)
      VALUES ($1, $2, 'orphan')`, [userA, conversationA]))
      .rejects.toMatchObject({ code: '23503' });
    await expect(postgres.pool.query(`INSERT INTO public.conversations
      (user_id, channel_account_id, external_conversation_id)
      VALUES ($1, $2, 'cross-user')`, [userA, accountB]))
      .rejects.toMatchObject({ code: '23503' });
  });

  test('accepts only specified states and safe capability values', async () => {
    await seedAccounts();
    await postgres.pool.query(`UPDATE public.users SET status = 'deleting' WHERE id = $1`, [userA]);
    await postgres.pool.query(`UPDATE public.users SET status = 'deleted' WHERE id = $1`, [userA]);
    await postgres.pool.query(`UPDATE public.channel_accounts SET state = 'stopped' WHERE id = $1`, [accountA]);
    await expect(postgres.pool.query(`UPDATE public.users SET status = 'unknown' WHERE id = $1`, [userA]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(postgres.pool.query(`UPDATE public.channel_accounts SET provider = 'telegram' WHERE id = $1`, [accountA]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(postgres.pool.query(`UPDATE public.channel_accounts SET state = 'unknown' WHERE id = $1`, [accountA]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(postgres.pool.query(`UPDATE public.channel_accounts SET capabilities = '{"unverified":true}' WHERE id = $1`, [accountA]))
      .rejects.toMatchObject({ code: '23514' });
    await postgres.pool.query(`INSERT INTO public.conversations
      (id, user_id, channel_account_id, external_conversation_id, state)
      VALUES ($1, $2, $3, 'max-chat-a', 'stopped')`, [conversationA, userA, accountA]);
    await expect(postgres.pool.query(`UPDATE public.conversations SET state = 'unknown' WHERE id = $1`, [conversationA]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(postgres.pool.query(`UPDATE public.conversations SET provider = 'telegram' WHERE id = $1`, [conversationA]))
      .rejects.toMatchObject({ code: '23514' });
  });

  test('rejects invalid sequence counters and rolls back the whole transaction', async () => {
    await seedAccounts();
    const client = await postgres.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO public.conversations
        (id, user_id, channel_account_id, external_conversation_id)
        VALUES ($1, $2, $3, 'max-chat-a')`, [conversationA, userA, accountA]);
      await expect(client.query(`UPDATE public.conversations SET next_apply_sequence = 2 WHERE id = $1`, [conversationA]))
        .rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect((await postgres.pool.query('SELECT count(*)::int AS count FROM public.conversations')).rows)
      .toEqual([{ count: 0 }]);
    await expect(postgres.pool.query(`INSERT INTO public.conversations
      (user_id, channel_account_id, external_conversation_id, next_inbound_sequence)
      VALUES ($1, $2, 'bad-sequence', 0)`, [userA, accountA]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(postgres.pool.query(`INSERT INTO public.conversations
      (user_id, channel_account_id, external_conversation_id, next_apply_sequence)
      VALUES ($1, $2, 'bad-apply', 0)`, [userA, accountA]))
      .rejects.toMatchObject({ code: '23514' });
  });

  test.each(['users', 'channel_accounts', 'conversations'] as const)(
    '%s has forced RLS and denies access without tenant context', async (table) => {
      const rls = await postgres.pool.query<{ rowsecurity: boolean; forcerowsecurity: boolean }>(
        'SELECT relrowsecurity AS rowsecurity, relforcerowsecurity AS forcerowsecurity FROM pg_class WHERE oid = $1::regclass',
        [`public.${table}`],
      );
      expect(rls.rows).toEqual([{ rowsecurity: true, forcerowsecurity: true }]);
      for (const [index, pool] of applicationPools.entries()) {
        if (index === 1) {
          expect((await pool.query(`SELECT * FROM public.${table}`)).rows).toEqual([]);
        } else {
          await expect(pool.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: '42501' });
        }
        await expect(pool.query(`INSERT INTO public.${table} DEFAULT VALUES`)).rejects.toMatchObject({ code: '42501' });
      }
    },
  );
});
