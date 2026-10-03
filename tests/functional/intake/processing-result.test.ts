import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createDatabase, type Database } from '../../../src/infrastructure/postgres/database.js';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { PostgresConversationQueue } from '../../../src/infrastructure/postgres/postgres-conversation-queue.js';
import { ProcessInbound, HandlerDeadlineError, PreparationFailedError, ReceiptMismatchError } from '../../../src/modules/intake/application/process-inbound.js';
import { FoundationInboundHandler } from '../../../src/modules/intake/application/inbound-handler.js';
import { PostgresAtomicProcessing } from '../../../src/infrastructure/postgres/postgres-atomic-processing.js';
import { PostgresOrderedHead } from '../../../src/infrastructure/postgres/postgres-ordered-head.js';
import { PostgresFencedConversation } from '../../../src/infrastructure/postgres/postgres-fenced-conversation.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const result = { receiptType: 'foundation_echo', receiptVersion: 1, messages: [
  { version: 1, kind: 'text', text: 'first' }, { version: 1, kind: 'text', text: 'second' }] } as const;

describe('durable processing results', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let gateway: Pool;
  let database: Database;
  let queue: PostgresConversationQueue;
  let serial = 2000;
  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    const url = (role: string) => {
      const value = new URL(postgres.pool.options.connectionString!);
      value.username = `echo_${role}`; value.password = 'isolated-test-password'; return value.toString();
    };
    for (const role of ['migrator', 'gateway', 'worker'])
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    migrator = new Pool({ connectionString: url('migrator') });
    gateway = new Pool({ connectionString: url('gateway') });
    await runMigrations(migrator, `${root}migrations`);
    database = createDatabase({ worker: url('worker') });
    queue = new PostgresConversationQueue(database);
  }, 120_000);
  beforeEach(async () => { await postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => {
    await Promise.all([database?.close(), migrator?.end(), gateway?.end()]); await postgres?.stop();
  });
  const initial = async () => {
    const chat = String(++serial);
    await gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',
      [chat, chat, `message:${chat}:one`, '2026-10-01T00:00:00Z',
        JSON.stringify({ kind: 'text', text: 'private' }), 'a'.repeat(64)]);
    return (await queue.claim({ ownerId, limit: 1 }))[0]!;
  };
  const event = async (conversationId: string) => (await postgres.pool.query(
    'SELECT * FROM public.inbound_events WHERE conversation_id = $1', [conversationId])).rows[0]!;
  const insert = `INSERT INTO public.processing_receipts
    (user_id, conversation_id, inbound_event_id, receipt_type, receipt_version, result)
    VALUES ($1,$2,$3,'foundation_echo',1,$4)`;

  const atomic = (db: Pick<Database, 'tenantTransaction'> = database) =>
    new PostgresAtomicProcessing(new PostgresOrderedHead(new PostgresFencedConversation(db)));
  const state = async () => ({
    receipts: (await postgres.pool.query('SELECT * FROM public.processing_receipts')).rows,
    events: (await postgres.pool.query('SELECT processing_status, failure_code, processed_at FROM public.inbound_events')).rows,
    pointers: (await postgres.pool.query('SELECT next_apply_sequence FROM public.conversations')).rows,
    work: (await postgres.pool.query('SELECT state, lease_owner, lease_generation, available_at::text FROM public.conversation_work')).rows,
  });

  test('receipt table enforces tenant access, immutable grants, ownership, uniqueness and closed result shape', async () => {
    expect((await postgres.pool.query("SELECT to_regclass('public.processing_receipts') AS name")).rows[0].name)
      .toBe('processing_receipts');
    const a = await initial(); const b = await initial(); const source = await event(a.conversationId);
    const values = [a.userId, a.conversationId, source.id, JSON.stringify(result)];
    await database.tenantTransaction('worker', a.userId, (tx) => tx.query(insert, values));
    expect(await database.tenantTransaction('worker', b.userId,
      (tx) => tx.query('SELECT * FROM public.processing_receipts'))).toEqual([]);
    await expect(database.tenantTransaction('worker', b.userId, (tx) => tx.query(insert, values)))
      .rejects.toMatchObject({ code: 'DB_FAILURE' });
    for (const sql of ['UPDATE public.processing_receipts SET receipt_version = 1', 'DELETE FROM public.processing_receipts'])
      await expect(database.tenantTransaction('worker', a.userId, (tx) => tx.query(sql)))
        .rejects.toMatchObject({ code: 'DB_FAILURE' });
    await expect(postgres.pool.query(insert, values)).rejects.toMatchObject({ code: '23505' });
    await postgres.pool.query('DELETE FROM public.processing_receipts');
    await expect(postgres.pool.query(insert, [b.userId, b.conversationId, source.id, JSON.stringify(result)]))
      .rejects.toMatchObject({ code: '23503' });
    await postgres.pool.query('DELETE FROM public.processing_receipts');
    for (const bad of [null, {}, { ...result, extra: true }, { ...result, receiptVersion: 2 },
      { ...result, messages: [null] }, { ...result, messages: [{ version: 1, kind: 'text', text: 3 }] },
      { ...result, messages: [{ version: 1, kind: 'text', text: 'x', extra: true }] }])
      await expect(postgres.pool.query(insert, [...values.slice(0, 3), JSON.stringify(bad)]))
        .rejects.toMatchObject({ code: '23514' });
    expect((await postgres.pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'public.processing_receipts'::regclass`)).rows[0])
      .toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  test.each([
    [{ kind: 'text', text: 'private' }, 'Получено сообщение №1.', 'applied', null],
    [{ kind: 'voice', media: { url: 'secret', token: 'secret' } }, 'Голосовые сообщения пока недоступны. Поддержка появится на следующем этапе.', 'applied', 'capability_unavailable'],
    [{ kind: 'button', callbackPayload: 'secret' }, 'Кнопка устарела или уже использована', 'applied', null],
    [{ kind: 'lifecycle', lifecycleType: 'started' }, undefined, 'applied', null],
  ])('saves exact %j result with atomic event, pointer and sleeping work', async (payload, text, status, failure) => {
    const lease = await initial();
    await postgres.pool.query('UPDATE public.inbound_events SET kind = $1, payload = $2',
      [(payload as { kind: string }).kind, JSON.stringify(payload)]);
    const expected = { receiptType: 'foundation_echo', receiptVersion: 1,
      messages: text === undefined ? [] : [{ version: 1, kind: 'text', text }] };
    expect(await new ProcessInbound(atomic(), new FoundationInboundHandler()).run(lease))
      .toEqual({ kind: 'actionable', value: expected });
    const saved = await state();
    expect(saved.receipts).toHaveLength(1); expect(saved.receipts[0].result).toEqual(expected);
    expect(saved.events[0]).toEqual({ processing_status: status, failure_code: failure, processed_at: expect.any(Date) });
    expect(saved.pointers).toEqual([{ next_apply_sequence: '2' }]);
    expect(saved.work[0]).toMatchObject({ state: 'ready', lease_owner: null, lease_generation: '1', available_at: 'infinity' });
    await expect(new ProcessInbound(atomic(), new FoundationInboundHandler()).run(lease)).rejects.toThrow();
    expect(await state()).toEqual(saved);
  });

  test('ordered drafts survive a new runner; consistent existing receipt is reused and inconsistent receipt fails closed', async () => {
    const lease = await initial(); const source = await event(lease.conversationId);
    await database.tenantTransaction('worker', lease.userId, (tx) => tx.query(insert,
      [lease.userId, lease.conversationId, source.id, JSON.stringify(result)]));
    const before = await state();
    await expect(new ProcessInbound(atomic(), new FoundationInboundHandler()).run(lease)).rejects.toBeInstanceOf(ReceiptMismatchError);
    expect(await state()).toEqual(before);
    await new ProcessInbound(atomic(), { handle: async () => result }).run(lease);
    expect((await state()).receipts).toEqual(before.receipts);
    await postgres.pool.query("UPDATE public.conversation_work SET available_at = clock_timestamp()");
    const reclaimed = (await queue.claim({ ownerId, limit: 1 }))[0]!;
    expect(await new ProcessInbound(atomic(), { handle: async () => { throw new Error('rehandled'); } }).run(reclaimed))
      .toEqual({ kind: 'drained' });
    expect((await state()).receipts[0].result.messages).toEqual(result.messages);
  });

  test('failure after receipt INSERT rolls back all effects; another connection can process after rollback', async () => {
    const lease = await initial(); const before = await state(); let inserted = false;
    const broken = atomic({ tenantTransaction: (role, userId, fn) => database.tenantTransaction(role, userId,
      (tx) => fn({ query: async (sql, values) => {
        const rows = await tx.query(sql, values);
        if (sql.startsWith('INSERT INTO public.processing_receipts')) { inserted = true; throw new Error('after receipt'); }
        return rows as never;
      } })) });
    await expect(new ProcessInbound(broken, { handle: async () => result }).run(lease)).rejects.toThrow('after receipt');
    expect(inserted).toBe(true); expect(await state()).toEqual(before);
    await new ProcessInbound(atomic(), { handle: async () => result }).run(lease);
    expect((await state()).receipts[0].result).toEqual(result);
  });

  test('handler timeout releases transaction locks, propagates error and cannot save a late result', async () => {
    const lease = await initial(); const before = await state();
    let settle!: (value: typeof result) => void;
    await expect(new ProcessInbound(atomic(), { handle: () => new Promise((resolve) => { settle = resolve; }) }).run(lease))
      .rejects.toBeInstanceOf(HandlerDeadlineError);
    expect(await state()).toEqual(before);
    settle(result); await new Promise((resolve) => setImmediate(resolve));
    expect(await state()).toEqual(before);
    await new ProcessInbound(atomic(), { handle: async () => result }).run(lease);
  }, 10_000);

  test('success exposes only the next head and preserves lease generation across ready work', async () => {
    const lease = await initial(); const chat = String(serial);
    await gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',
      [chat, chat, `message:${chat}:two`, '2026-10-01T00:00:00Z',
        JSON.stringify({ kind: 'text', text: 'second private' }), 'a'.repeat(64)]);
    await new ProcessInbound(atomic(), new FoundationInboundHandler()).run(lease);
    const next = (await queue.claim({ ownerId, limit: 1 }))[0]!;
    expect(next.leaseGeneration).toBe(2n);
    expect(await new ProcessInbound(atomic(), new FoundationInboundHandler()).run(next)).toEqual({ kind: 'actionable',
      value: { receiptType: 'foundation_echo', receiptVersion: 1,
        messages: [{ version: 1, kind: 'text', text: 'Получено сообщение №2.' }] } });
    expect((await state()).receipts).toHaveLength(2);
    expect((await state()).pointers).toEqual([{ next_apply_sequence: '3' }]);
  });

  test('fresh final lease guard rolls back receipt, outcome and pointer if lease expires during processing', async () => {
    const lease = await initial(); const before = await state();
    const expires = atomic({ tenantTransaction: (role, userId, fn) => database.tenantTransaction(role, userId,
      (tx) => fn({ query: async (sql, values) => {
        const rows = await tx.query(sql, values);
        if (sql.startsWith('INSERT INTO public.processing_receipts'))
          await tx.query("UPDATE public.conversation_work SET lease_until = clock_timestamp() - interval '1 second'");
        return rows as never;
      } })) });
    await expect(new ProcessInbound(expires, { handle: async () => result }).run(lease))
      .rejects.toMatchObject({ name: 'ConversationLeaseLostError' });
    expect(await state()).toEqual(before);
  });

  test('preparation failure stays recoverable for 20B without invoking pure handler', async () => {
    const lease = await initial(); await postgres.pool.query("UPDATE public.inbound_events SET preparation_status = 'failed'");
    const before = await state();
    await expect(new ProcessInbound(atomic(), { handle: async () => { throw new Error('must not handle'); } }).run(lease))
      .rejects.toBeInstanceOf(PreparationFailedError);
    expect(await state()).toEqual(before);
  });
});
