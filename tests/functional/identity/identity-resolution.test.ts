import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { createDatabase } from '../../../src/infrastructure/postgres/database.js';
import { PostgresIdentityGateway } from '../../../src/infrastructure/postgres/postgres-identity-gateway.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const migrations = fileURLToPath(new URL('../../../migrations', import.meta.url));
type IdentityRow = {
  user_id: string;
  channel_account_id: string;
  conversation_id: string;
  state: 'active' | 'stopped';
};

describe('MAX identity resolution', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let gateway: Pool;
  let worker: Pool;
  let roleUrls: Record<'gateway' | 'worker' | 'delivery' | 'scheduler', string>;

  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    const adminUrl = new URL(postgres.pool.options.connectionString!);
    for (const role of ['migrator', 'gateway', 'worker', 'delivery', 'scheduler']) {
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    }
    const url = (role: string) => {
      const result = new URL(adminUrl);
      result.username = `echo_${role}`;
      result.password = 'isolated-test-password';
      return result.toString();
    };
    migrator = new Pool({ connectionString: url('migrator') });
    await runMigrations(migrator, migrations);
    gateway = new Pool({ connectionString: url('gateway') });
    worker = new Pool({ connectionString: url('worker') });
    roleUrls = {
      gateway: url('gateway'), worker: url('worker'),
      delivery: url('delivery'), scheduler: url('scheduler'),
    };
  }, 120_000);

  beforeEach(async () => {
    await postgres.pool.query('TRUNCATE public.conversations, public.channel_accounts, public.users CASCADE');
  });

  afterAll(async () => {
    await worker?.end();
    await gateway?.end();
    await migrator?.end();
    await postgres?.stop();
  });

  async function resolve(user = '123', chat = '456', event = 'message_created'): Promise<IdentityRow> {
    const result = await gateway.query<IdentityRow>(
      'SELECT * FROM public.resolve_or_create_max_identity($1, $2, $3)', [user, chat, event],
    );
    return result.rows[0]!;
  }

  test('concurrent calls and retries return one internal identity', async () => {
    const [first, second] = await Promise.all([resolve(), resolve()]);
    expect(first).toEqual(second);
    expect(await resolve()).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(['channel_account_id', 'conversation_id', 'state', 'user_id']);
    expect(first.state).toBe('active');
    const counts = await postgres.pool.query(`SELECT
      (SELECT count(*)::int FROM public.users) AS users,
      (SELECT count(*)::int FROM public.channel_accounts) AS accounts,
      (SELECT count(*)::int FROM public.conversations) AS conversations`);
    expect(counts.rows).toEqual([{ users: 1, accounts: 1, conversations: 1 }]);
  });

  test('stop persists through messages and callbacks, and only bot_started reactivates', async () => {
    const first = await resolve();
    const stopped = await resolve('123', '456', 'bot_stopped');
    expect(stopped).toEqual({ ...first, state: 'stopped' });
    expect(await resolve()).toEqual(stopped);
    expect(await resolve('123', '456', 'message_callback')).toEqual(stopped);
    expect(await resolve('123', '456', 'bot_started')).toEqual(first);
    const states = await postgres.pool.query(`SELECT
      (SELECT state FROM public.channel_accounts WHERE id = $1) AS account,
      (SELECT state FROM public.conversations WHERE id = $2) AS conversation`,
    [first.channel_account_id, first.conversation_id]);
    expect(states.rows).toEqual([{ account: 'active', conversation: 'active' }]);
  });

  test('rejects cross-account chat collision without changing either identity', async () => {
    const owner = await resolve('123', '456');
    await expect(resolve('789', '456')).rejects.toMatchObject({ code: 'P0001' });
    expect(await resolve('123', '456')).toEqual(owner);
    const counts = await postgres.pool.query(`SELECT
      (SELECT count(*)::int FROM public.users) AS users,
      (SELECT count(*)::int FROM public.channel_accounts) AS accounts,
      (SELECT count(*)::int FROM public.conversations) AS conversations`);
    expect(counts.rows).toEqual([{ users: 1, accounts: 1, conversations: 1 }]);
  });

  test.each([
    ['', '456', 'message_created'],
    ['-0', '456', 'message_created'],
    ['01', '456', 'message_created'],
    ['-01', '456', 'message_created'],
    ['+1', '456', 'message_created'],
    [' 123', '456', 'message_created'],
    ['9223372036854775808', '456', 'message_created'],
    ['-9223372036854775809', '456', 'message_created'],
    ['123', '', 'message_created'],
    ['123', '456', 'unknown'],
  ])('rejects malformed MAX identity input %#', async (user, chat, event) => {
    await expect(resolve(user, chat, event)).rejects.toMatchObject({ code: '22023' });
    const counts = await postgres.pool.query('SELECT count(*)::int AS count FROM public.users');
    expect(counts.rows).toEqual([{ count: 0 }]);
  });

  test('accepts canonical signed int64 boundaries without rounding', async () => {
    const low = await resolve('-9223372036854775808', '-1');
    const high = await resolve('9223372036854775807', '9223372036854775807');
    const zero = await resolve('0', '0');
    expect(new Set([low.user_id, high.user_id, zero.user_id]).size).toBe(3);
    const stored = await postgres.pool.query(`SELECT external_user_id FROM public.channel_accounts
      ORDER BY external_user_id::numeric`);
    expect(stored.rows).toEqual([
      { external_user_id: '-9223372036854775808' },
      { external_user_id: '0' },
      { external_user_id: '9223372036854775807' },
    ]);
  });

  test('only gateway can execute and gateway has no general identity table access', async () => {
    expect((await gateway.query('SELECT current_user AS role')).rows[0]?.role).toBe('echo_gateway');
    expect((await worker.query('SELECT current_user AS role')).rows[0]?.role).toBe('echo_worker');
    await expect(worker.query('SELECT * FROM public.resolve_or_create_max_identity($1,$2,$3)',
      ['123', '456', 'bot_started'])).rejects.toMatchObject({ code: '42501' });
    await expect(migrator.query('SELECT * FROM public.resolve_or_create_max_identity($1,$2,$3)',
      ['123', '456', 'bot_started'])).rejects.toMatchObject({ code: '42501' });
    await expect(gateway.query('SELECT * FROM public.channel_accounts')).rejects.toMatchObject({ code: '42501' });
    await expect(gateway.query(`UPDATE public.channel_accounts SET state = 'active'`))
      .rejects.toMatchObject({ code: '42501' });
  });

  test('adapter returns only provider-neutral internal identity and state', async () => {
    const database = createDatabase(roleUrls);
    try {
      const adapter = new PostgresIdentityGateway(database);
      const identity = await adapter.resolvePrivateDialog({
        externalUserId: '123', externalConversationId: '456', eventType: 'bot_started',
      });
      expect(Object.keys(identity).sort()).toEqual(['channelAccountId', 'conversationId', 'state', 'userId']);
      expect(identity.state).toBe('active');
      expect(identity.userId).toMatch(/^[0-9a-f-]{36}$/);
      expect(identity.channelAccountId).toMatch(/^[0-9a-f-]{36}$/);
      expect(identity.conversationId).toMatch(/^[0-9a-f-]{36}$/);
      const stopped = await adapter.resolvePrivateDialog({
        externalUserId: '123', externalConversationId: '456', eventType: 'bot_stopped',
      });
      expect(stopped).toEqual({ ...identity, state: 'stopped' });
    } finally {
      await database.close();
    }
  });
});
