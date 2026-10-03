import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { startPostgres } from '../../support/postgres.js';
import { validateInboundPayload } from '../../../src/modules/intake/domain/inbound-event.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const migrationDirectory = fileURLToPath(new URL('../../../migrations', import.meta.url));
const sha = 'a'.repeat(64);

describe('inbound event schema', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let worker: Pool;
  let gateway: Pool;
  let delivery: Pool;
  let scheduler: Pool;
  let a: { user_id: string; conversation_id: string };
  let b: { user_id: string; conversation_id: string };

  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    for (const role of ['migrator', 'gateway', 'worker', 'delivery', 'scheduler']) {
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    }
    const roleUrl = (role: string) => {
      const url = new URL(postgres.pool.options.connectionString!);
      url.username = `echo_${role}`;
      url.password = 'isolated-test-password';
      return url.toString();
    };
    migrator = new Pool({ connectionString: roleUrl('migrator') });
    worker = new Pool({ connectionString: roleUrl('worker') });
    gateway = new Pool({ connectionString: roleUrl('gateway') });
    delivery = new Pool({ connectionString: roleUrl('delivery') });
    scheduler = new Pool({ connectionString: roleUrl('scheduler') });
    await runMigrations(migrator, migrationDirectory);
    a = (await gateway.query("SELECT * FROM public.resolve_or_create_max_identity('101', '201', 'bot_started')")).rows[0];
    b = (await gateway.query("SELECT * FROM public.resolve_or_create_max_identity('102', '202', 'bot_started')")).rows[0];
  }, 120_000);

  afterAll(async () => {
    await worker?.end();
    await gateway?.end();
    await delivery?.end();
    await scheduler?.end();
    await migrator?.end();
    await postgres?.stop();
  });

  function row(overrides: Record<string, unknown> = {}) {
    return {
      user_id: a.user_id, conversation_id: a.conversation_id,
      provider: 'max', provider_event_key: 'event-1', sequence: 1,
      kind: 'text', occurred_at: '2026-10-01T00:00:00Z', timezone_snapshot: 'Europe/Moscow',
      payload: { kind: 'text', text: 'hello' }, raw_sha256: sha,
      ...overrides,
    };
  }

  async function insert(value: Record<string, unknown>) {
    const fields = Object.keys(value);
    const params = fields.map((_, index) => `$${index + 1}`);
    return postgres.pool.query(
      `INSERT INTO public.inbound_events (${fields.join(', ')}) VALUES (${params.join(', ')}) RETURNING *`,
      Object.values(value).map((item) => typeof item === 'object' && item !== null ? JSON.stringify(item) : item),
    );
  }

  test('stores valid variants, statuses, counters and timestamps', async () => {
    const result = await insert(row());
    expect(result.rows[0]).toMatchObject({ provider: 'max', kind: 'text', sequence: '1', preparation_status: 'ready', processing_status: 'accepted', attempt_count: 0 });
    expect(result.rows[0].received_at).toBeInstanceOf(Date);
    expect(result.rows[0].created_at).toBeInstanceOf(Date);
    await insert(row({ provider_event_key: 'voice-1', sequence: 2, kind: 'voice', payload: { kind: 'voice', media: { url: 'https://example.test/audio', token: 't' } } }));
    await insert(row({ provider_event_key: 'button-1', sequence: 3, kind: 'button', payload: { kind: 'button', callbackPayload: 'go', replyToMessageId: 'x' } }));
    await insert(row({ provider_event_key: 'lifecycle-1', sequence: 4, kind: 'lifecycle', payload: { kind: 'lifecycle', lifecycleType: 'started' } }));
  });

  test.each([
    [{ kind: 'bad' }, 'kind'],
    [{ provider: 'telegram' }, 'provider'],
    [{ sequence: 0 }, 'sequence'],
    [{ attempt_count: -1 }, 'attempt count'],
    [{ preparation_status: 'unknown' }, 'preparation status'],
    [{ processing_status: 'unknown' }, 'processing status'],
    [{ failure_code: 'arbitrary' }, 'failure code'],
    [{ raw_sha256: 'abc' }, 'hash'],
    [{ payload: { kind: 'text', text: 'a'.repeat(16_001) } }, 'code points'],
    [{ payload: { kind: 'text', text: '😀'.repeat(16_001) } }, 'UTF-8 bytes'],
    [{ payload: { kind: 'button', callbackPayload: 'a'.repeat(129 * 1024) } }, 'payload bytes'],
    [{ payload: { kind: 'voice', media: {} }, kind: 'voice' }, 'media'],
    [{ payload: { kind: 'text' } }, 'missing text'],
    [{ payload: { kind: 'button' }, kind: 'button' }, 'missing callback payload'],
    [{ payload: { kind: 'button', callbackPayload: 'x' } }, 'variant mismatch'],
  ] as const)('rejects invalid event %#', async (change) => {
    await expect(insert(row({ provider_event_key: crypto.randomUUID(), sequence: 10, ...change })))
      .rejects.toMatchObject({ code: '23514' });
  });

  test('requires tenant ID', async () => {
    await expect(insert(row({ provider_event_key: 'no-tenant', sequence: 13, user_id: null })))
      .rejects.toMatchObject({ code: '23502' });
  });

  test('rejects cross-tenant conversation and duplicate event or sequence identities', async () => {
    await expect(insert(row({ provider_event_key: 'cross-tenant', sequence: 11, conversation_id: b.conversation_id })))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insert(row({ provider_event_key: 'event-1', sequence: 12 })))
      .rejects.toMatchObject({ code: '23505' });
    await expect(insert(row({ provider_event_key: 'new-key', sequence: 1 })))
      .rejects.toMatchObject({ code: '23505' });
  });

  test('forces RLS and grants tenant-only worker access', async () => {
    await insert(row({ user_id: b.user_id, conversation_id: b.conversation_id,
      provider_event_key: 'other-tenant-event', sequence: 1 }));
    const flags = await postgres.pool.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.inbound_events'::regclass");
    expect(flags.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect((await worker.query('SELECT * FROM public.inbound_events')).rows).toEqual([]);
    for (const pool of [gateway, delivery, scheduler]) {
      await expect(pool.query('SELECT * FROM public.inbound_events')).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('INSERT INTO public.inbound_events DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
    }
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [a.user_id]);
      expect((await client.query('SELECT provider_event_key FROM public.inbound_events ORDER BY sequence')).rows.map((r) => r.provider_event_key))
        .toEqual(['event-1', 'voice-1', 'button-1', 'lifecycle-1']);
      expect((await client.query('UPDATE public.inbound_events SET attempt_count = attempt_count + 1 WHERE user_id = $1 RETURNING id', [b.user_id])).rows).toEqual([]);
      expect((await client.query('UPDATE public.inbound_events SET attempt_count = attempt_count + 1 WHERE provider_event_key = $1 RETURNING attempt_count', ['event-1'])).rows)
        .toEqual([{ attempt_count: 1 }]);
      await expect(client.query('UPDATE public.inbound_events SET payload = $1 WHERE provider_event_key = $2',
        [JSON.stringify({ kind: 'text', text: 'changed' }), 'event-1']))
        .rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  test('denies worker insertion and changes to immutable envelope fields', async () => {
    const client = await worker.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [a.user_id]);
      await expect(client.query(`INSERT INTO public.inbound_events (user_id, conversation_id, provider, provider_event_key, sequence, kind, occurred_at, timezone_snapshot, payload, raw_sha256)
        VALUES ($1, $2, 'max', 'worker-write', 30, 'text', now(), 'UTC', '{"kind":"text","text":"x"}', $3)`, [a.user_id, a.conversation_id, sha]))
        .rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });

  test('stores and deduplicates a long canonical provider key', async () => {
    const providerEventKey = `message:${randomBytes(4096).toString('hex')}`;
    const stored = await insert(row({ provider_event_key: providerEventKey, sequence: 20 }));
    expect(stored.rows[0].provider_event_key).toBe(providerEventKey);
    await expect(insert(row({ provider_event_key: providerEventKey, sequence: 21 })))
      .rejects.toMatchObject({ code: '23505' });
  });

  test.each([
    ['button', { kind: 'button', callbackPayload: 'a'.repeat(131_031) },
      { kind: 'button', callbackPayload: 'a'.repeat(131_032) }],
    ['button', { kind: 'button', callbackPayload: '😀\n\\"' + 'a'.repeat(130_996), replyToMessageId: 'r' },
      { kind: 'button', callbackPayload: '😀\n\\"' + 'a'.repeat(130_997), replyToMessageId: 'r' }],
    ['voice', { kind: 'voice', media: { url: 'https://x/😀\n', token: 'a'.repeat(130_979) }, replyToMessageId: 'r' },
      { kind: 'voice', media: { url: 'https://x/😀\n', token: 'a'.repeat(130_980) }, replyToMessageId: 'r' }],
  ] as const)('matches domain and PostgreSQL at 128 KiB for case %#', async (kind, atLimit, overLimit) => {
    expect(validateInboundPayload(atLimit)).toBe(true);
    expect(validateInboundPayload(overLimit)).toBe(false);
    const sizes = await postgres.pool.query(
      'SELECT octet_length($1::jsonb::text) AS at_limit, octet_length($2::jsonb::text) AS over_limit',
      [JSON.stringify(atLimit), JSON.stringify(overLimit)],
    );
    expect(sizes.rows[0]).toEqual({ at_limit: 131_072, over_limit: 131_073 });
    const sequence = kind === 'voice' ? 52 : atLimit.replyToMessageId ? 51 : 50;
    await insert(row({ provider_event_key: `boundary-${sequence}`, sequence, kind, payload: atLimit }));
    await expect(insert(row({ provider_event_key: `over-boundary-${sequence}`, sequence: sequence + 10, kind, payload: overLimit })))
      .rejects.toMatchObject({ code: '23514' });
  });
});
