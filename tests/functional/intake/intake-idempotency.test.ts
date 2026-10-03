import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { createDatabase, type Database } from '../../../src/infrastructure/postgres/database.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = 'a'.repeat(64);
const sql = 'SELECT inbound_event_id AS id, status FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)';
const args = (key = 'message:one', payload: object = { kind: 'text', text: 'hello' }, user = '123', chat = '456') =>
  [user, chat, key, '2026-10-01T00:00:00.123Z', JSON.stringify(payload), sha];

describe('atomic inbound intake', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let gateway: Pool;
  let database: Database;
  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    const url = (role: string) => {
      const value = new URL(postgres.pool.options.connectionString!);
      value.username = `echo_${role}`;
      value.password = 'isolated-test-password';
      return value.toString();
    };
    for (const role of ['migrator', 'gateway', 'worker', 'delivery', 'scheduler']) {
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    }
    migrator = new Pool({ connectionString: url('migrator') });
    gateway = new Pool({ connectionString: url('gateway') });
    database = createDatabase({ gateway: url('gateway'), worker: url('worker'), delivery: url('delivery'), scheduler: url('scheduler') });
    await runMigrations(migrator, `${root}migrations`);
  }, 120_000);
  beforeEach(async () => { await postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => {
    await database?.close();
    await gateway?.end();
    await migrator?.end();
    await postgres?.stop();
  });
  const accept = async (values = args()) => (await gateway.query(sql, values)).rows[0].id as string;
  const snapshot = async () => (await postgres.pool.query(`SELECT
    (SELECT count(*)::int FROM public.users) AS users,
    (SELECT count(*)::int FROM public.channel_accounts) AS accounts,
    (SELECT count(*)::int FROM public.conversations) AS conversations,
    (SELECT count(*)::int FROM public.inbound_events) AS events,
    (SELECT max(next_inbound_sequence)::text FROM public.conversations) AS next`)).rows[0];

  test.each([
    ['message:one', { kind: 'text', text: 'hello' }],
    ['callback:one', { kind: 'button', callbackPayload: 'go' }],
  ])('sequential and concurrent duplicates retain one ID and sequence: %s', async (key, payload) => {
    const ids = await Promise.all([accept(args(key, payload)), accept(args(key, payload))]);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    // This replay also models a lost response after the first COMMIT.
    expect(await accept(args(key, payload))).toBe(ids[0]);
    expect(await snapshot()).toEqual({ users: 1, accounts: 1, conversations: 1, events: 1, next: '2' });
  });

  test('reports creation versus replay for the webhook boundary', async () => {
    expect((await gateway.query(sql, args())).rows[0].status).toBe('created');
    expect((await gateway.query(sql, args())).rows[0].status).toBe('duplicate');
  });

  test('different concurrent events share ordered sequences and timezone snapshots', async () => {
    await Promise.all([accept(), accept(args('message:two'))]);
    await postgres.pool.query("UPDATE public.users SET timezone = 'UTC'");
    await accept(args('message:three'));
    const rows = (await postgres.pool.query('SELECT sequence, timezone_snapshot, occurred_at FROM public.inbound_events ORDER BY sequence')).rows;
    expect(rows.map(({ sequence, timezone_snapshot }) => [sequence, timezone_snapshot]))
      .toEqual([['1', 'Europe/Moscow'], ['2', 'Europe/Moscow'], ['3', 'UTC']]);
    expect(rows[0].occurred_at.toISOString()).toBe('2026-10-01T00:00:00.123Z');
  });

  test('rollback before commit discards new identity, event and counter', async () => {
    await expect(database.systemTransaction('gateway', async (tx) => {
      await tx.query(sql, args());
      throw new Error('simulated interruption');
    })).rejects.toThrow('simulated interruption');
    expect(await snapshot()).toEqual({ users: 0, accounts: 0, conversations: 0, events: 0, next: null });
    await accept();
    expect((await snapshot()).next).toBe('2');
  });

  test('sequence overflow rolls back lifecycle effects and event insertion', async () => {
    await accept(args('lifecycle:stop', { kind: 'lifecycle', lifecycleType: 'stopped' }));
    await postgres.pool.query("UPDATE public.conversations SET next_inbound_sequence = 9223372036854775807");
    await expect(accept(args('lifecycle:start', { kind: 'lifecycle', lifecycleType: 'started' })))
      .rejects.toMatchObject({ code: '22003' });
    expect((await postgres.pool.query('SELECT state, next_inbound_sequence FROM public.conversations')).rows)
      .toEqual([{ state: 'stopped', next_inbound_sequence: '9223372036854775807' }]);
    expect((await snapshot()).events).toBe(1);
    expect((await postgres.pool.query('SELECT state FROM public.channel_accounts')).rows).toEqual([{ state: 'stopped' }]);
  });

  test('replayed start cannot reactivate a stopped account', async () => {
    const start = args('lifecycle:start', { kind: 'lifecycle', lifecycleType: 'started' });
    const id = await accept(start);
    await accept(args('lifecycle:stop', { kind: 'lifecycle', lifecycleType: 'stopped' }));
    expect(await accept(start)).toBe(id);
    expect((await postgres.pool.query('SELECT state FROM public.conversations')).rows).toEqual([{ state: 'stopped' }]);
    expect((await postgres.pool.query('SELECT state FROM public.channel_accounts')).rows).toEqual([{ state: 'stopped' }]);
    expect((await snapshot()).next).toBe('3');
  });

  test.each([['789', '456'], ['789', '999'], ['123', '999']])('rejects altered owner/chat on duplicate without creating identity: %s/%s', async (user, chat) => {
    await accept();
    await expect(accept(args('message:one', { kind: 'text', text: 'hello' }, user, chat)))
      .rejects.toMatchObject({ code: 'P0001' });
    expect(await snapshot()).toEqual({ users: 1, accounts: 1, conversations: 1, events: 1, next: '2' });
  });

  test('deleting identity rejects new events and duplicates', async () => {
    await accept();
    await postgres.pool.query("UPDATE public.users SET status = 'deleting'");
    for (const key of ['message:one', 'message:two']) await expect(accept(args(key))).rejects.toMatchObject({ code: 'P0001' });
    expect((await snapshot()).events).toBe(1);
  });

  test('MAX bridge persists neutral voice, lifecycle and reply metadata with epoch milliseconds', async () => {
    const { acceptMaxInbound } = await import('../../../src/infrastructure/postgres/postgres-intake-store.js');
    const base = { status: 'normalized' as const, providerUserId: '123', providerChatId: '456', occurredAt: '1790812800123' };
    const voice = { ...base, providerEventKey: 'message:voice', kind: 'voice' as const,
      voice: { url: 'https://example.test/audio', token: 'private-token' }, replyToMessageId: 'reply' };
    const first = await acceptMaxInbound(database, voice, sha);
    expect(first.status).toBe('created');
    expect(await acceptMaxInbound(database, voice, sha)).toEqual({ ...first, status: 'duplicate' });
    await acceptMaxInbound(database, { ...base, providerEventKey: 'lifecycle:stop', kind: 'lifecycle', lifecycleType: 'bot_stopped' }, sha);
    const rows = (await postgres.pool.query('SELECT id, payload, occurred_at FROM public.inbound_events ORDER BY sequence')).rows;
    expect(rows[0].id).toBe(first.inboundEventId);
    expect(rows[0].payload).toEqual({ kind: 'voice', media: voice.voice, replyToMessageId: 'reply' });
    expect(rows[0].occurred_at.toISOString()).toBe('2026-10-01T00:00:00.123Z');
    expect(rows[1].payload).toEqual({ kind: 'lifecycle', lifecycleType: 'stopped' });
  });

  test('invalid inputs fail closed before persistent identity or event effects', async () => {
    const { acceptMaxInbound } = await import('../../../src/infrastructure/postgres/postgres-intake-store.js');
    const unavailable = { systemTransaction: () => { throw new Error('database must not be called'); } };
    const base = { status: 'normalized' as const, providerUserId: '123', providerChatId: '456',
      providerEventKey: 'message:bad', occurredAt: '1790812800123', kind: 'text' as const, text: 'hello' };
    for (const occurredAt of ['not-time', '1.5', '9223372036854775807', '9007199254740991', 'Infinity']) {
      await expect(acceptMaxInbound(unavailable, { ...base, occurredAt }, sha)).rejects.toThrow('invalid_inbound_event');
    }
    await expect(acceptMaxInbound(unavailable, { ...base, text: 'a'.repeat(16_001) }, sha)).rejects.toThrow('invalid_inbound_event');
    await expect(acceptMaxInbound(database, { ...base, occurredAt: '-8640000000000000' }, sha)).rejects.toThrow('invalid_inbound_event');
    expect(await snapshot()).toEqual({ users: 0, accounts: 0, conversations: 0, events: 0, next: null });
  });

  test('adapter rollback before commit leaves no separately committed identity', async () => {
    const { acceptMaxInbound } = await import('../../../src/infrastructure/postgres/postgres-intake-store.js');
    const interrupted: Pick<Database, 'systemTransaction'> = {
      systemTransaction: (role, fn) => database.systemTransaction(role, async (tx) => {
        await fn(tx);
        throw new Error('interrupted before commit');
      }),
    };
    await expect(acceptMaxInbound(interrupted, { status: 'normalized', providerUserId: '123', providerChatId: '456',
      providerEventKey: 'message:crash', occurredAt: '1790812800123', kind: 'text', text: 'hello' }, sha))
      .rejects.toThrow('interrupted before commit');
    expect(await snapshot()).toEqual({ users: 0, accounts: 0, conversations: 0, events: 0, next: null });
  });

  test('long canonical key is retained and deduplicated', async () => {
    const key = `message:${'abcdef0123456789'.repeat(1024)}`;
    const id = await accept(args(key));
    expect(await accept(args(key))).toBe(id);
    expect((await postgres.pool.query('SELECT provider_event_key FROM public.inbound_events')).rows).toEqual([{ provider_event_key: key }]);
  });

  test('runtime privileges remain narrow and public resolver remains gateway-only', async () => {
    expect((await gateway.query('SELECT current_user AS role')).rows[0].role).toBe('echo_gateway');
    await expect(gateway.query('SELECT * FROM public.inbound_events')).rejects.toMatchObject({ code: '42501' });
    await expect(gateway.query("SELECT * FROM public.resolve_max_identity_internal('123','456','message_created')"))
      .rejects.toMatchObject({ code: '42501' });
    await expect(migrator.query("SELECT * FROM public.resolve_or_create_max_identity('123','456','message_created')"))
      .rejects.toMatchObject({ code: '42501' });
    const acl = (await postgres.pool.query(`SELECT r.rolname, has_function_privilege(r.oid,
      'public.accept_max_inbound(text,text,text,timestamp with time zone,jsonb,text)', 'EXECUTE') AS execute, has_function_privilege(r.oid,
      'public.resolve_max_identity_internal(text,text,text)', 'EXECUTE') AS internal,
      has_function_privilege(r.oid, 'public.resolve_or_create_max_identity(text,text,text)', 'EXECUTE') AS resolver
      FROM pg_roles r WHERE r.rolname LIKE 'echo_%' ORDER BY r.rolname`)).rows;
    expect(acl).toEqual([
      { rolname: 'echo_delivery', execute: false, internal: false, resolver: false },
      { rolname: 'echo_gateway', execute: true, internal: false, resolver: true },
      { rolname: 'echo_migrator', execute: false, internal: true, resolver: false },
      { rolname: 'echo_scheduler', execute: false, internal: false, resolver: false },
      { rolname: 'echo_worker', execute: false, internal: false, resolver: false },
    ]);
    const security = (await postgres.pool.query(`SELECT p.proname, p.prosecdef, p.proconfig, r.rolname, r.rolbypassrls
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid IN ('public.accept_max_inbound(text,text,text,timestamptz,jsonb,text)'::regprocedure,
        'public.resolve_max_identity_internal(text,text,text)'::regprocedure,
        'public.resolve_or_create_max_identity(text,text,text)'::regprocedure)`)).rows;
    expect(security).toHaveLength(3);
    for (const row of security) expect(row).toMatchObject({ prosecdef: true,
      proconfig: ['search_path=pg_catalog'], rolname: 'echo_migrator', rolbypassrls: false });
  });
});
