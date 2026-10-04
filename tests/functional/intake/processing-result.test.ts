import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createDatabase, type Database } from '../../../src/infrastructure/postgres/database.js';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { PostgresConversationQueue } from '../../../src/infrastructure/postgres/postgres-conversation-queue.js';
import { ProcessInbound, ReceiptMismatchError } from '../../../src/modules/intake/application/process-inbound.js';
import { FoundationInboundHandler } from '../../../src/modules/intake/application/inbound-handler.js';
import { PostgresAtomicProcessing } from '../../../src/infrastructure/postgres/postgres-atomic-processing.js';
import { PostgresOutbox } from '../../../src/infrastructure/postgres/postgres-outbox.js';
import { OutboxMismatchError } from '../../../src/modules/delivery/application/outbox.js';
import type { OutboundMessageDraft } from '../../../src/modules/delivery/domain/outbound-message.js';
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
    for (const role of ['migrator', 'gateway', 'worker', 'delivery'])
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    migrator = new Pool({ connectionString: url('migrator') });
    gateway = new Pool({ connectionString: url('gateway') });
    await runMigrations(migrator, `${root}migrations`);
    database = createDatabase({ worker: url('worker'), delivery: url('delivery') });
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
    events: (await postgres.pool.query('SELECT processing_status, failure_code, processed_at FROM public.inbound_events ORDER BY sequence')).rows,
    pointers: (await postgres.pool.query('SELECT next_apply_sequence FROM public.conversations')).rows,
    work: (await postgres.pool.query('SELECT state, lease_owner, lease_generation, available_at::text FROM public.conversation_work')).rows,
    outbound: (await postgres.pool.query('SELECT * FROM public.outbound_messages ORDER BY source_inbound_event_id, message_index')).rows,
    delivery: (await postgres.pool.query('SELECT * FROM public.delivery_work ORDER BY outbound_message_id')).rows,
  });

  test('processing commits each ordered draft with one private delivery work item', async () => {
    const lease = await initial();
    const source = await event(lease.conversationId);
    await new ProcessInbound(atomic(), { handle: async () => result }).run(lease);
    expect((await postgres.pool.query(`SELECT user_id, conversation_id, source_inbound_event_id,
      provider, message_index, payload, dedupe_key, status FROM public.outbound_messages ORDER BY message_index`)).rows)
      .toEqual([0, 1].map((index) => ({ user_id: lease.userId, conversation_id: lease.conversationId,
        source_inbound_event_id: source.id, provider: 'max', message_index: index,
        payload: result.messages[index], dedupe_key: `response:${source.id}:${index}:v1`, status: 'pending' })));
    const work = (await postgres.pool.query('SELECT * FROM public.delivery_work ORDER BY outbound_message_id')).rows;
    expect(work).toHaveLength(2);
    expect(work.map((row) => row.user_id)).toEqual([lease.userId, lease.userId]);
    expect(work.map((row) => row.state)).toEqual(['ready', 'ready']);
    const committed = await state();
    await database.tenantTransaction('worker', lease.userId,
      (tx) => new PostgresOutbox(tx).save({ id: source.id, userId: lease.userId,
        conversationId: lease.conversationId }, result.messages));
    expect(await state()).toEqual(committed);
  });

  test('adapter rejects a malformed versioned draft before writing either table', async () => {
    const lease = await initial(); const source = await event(lease.conversationId);
    const malformed = { version: 1, kind: 'text', text: 'private', externalId: 'leak' } as unknown as OutboundMessageDraft;
    const before = await state();
    await expect(database.tenantTransaction('worker', lease.userId,
      (tx) => new PostgresOutbox(tx).save(source, [malformed])))
      .rejects.toThrow(/^Invalid outbound payload$/);
    expect(await state()).toEqual(before);
  });

  test('outbox source and payload conflicts fail closed without advancing the head', async () => {
    const lease = await initial(); const source = await event(lease.conversationId);
    await database.tenantTransaction('worker', lease.userId, async (tx) => {
      await tx.query(insert, [lease.userId, lease.conversationId, source.id, JSON.stringify(result)]);
      await tx.query(`INSERT INTO public.outbound_messages
        (user_id, conversation_id, source_inbound_event_id, message_index, payload, dedupe_key)
        VALUES ($1,$2,$3,0,$4,$5)`, [lease.userId, lease.conversationId, source.id,
        JSON.stringify({ version: 1, kind: 'text', text: 'wrong' }), `response:${source.id}:0:v1`]);
    });
    const before = await state();
    await expect(new ProcessInbound(atomic(), { handle: async () => result }).run(lease))
      .rejects.toBeInstanceOf(OutboxMismatchError);
    expect(await state()).toEqual(before);
  });

  test('failure after delivery work INSERT rolls back receipt, outbound, work and sequence', async () => {
    const lease = await initial(); const before = await state();
    const broken = atomic({ tenantTransaction: (role, userId, fn) => database.tenantTransaction(role, userId,
      (tx) => fn({ query: async (sql, values) => {
        const rows = await tx.query(sql, values);
        if (sql.startsWith('INSERT INTO public.delivery_work')) throw new Error('after outbox insert');
        return rows as never;
      } })) });
    await expect(new ProcessInbound(broken, { handle: async () => result }).run(lease))
      .rejects.toThrow('after outbox insert');
    expect(await state()).toEqual(before);
    await new ProcessInbound(atomic(), { handle: async () => result }).run(lease);
    expect((await state()).outbound).toHaveLength(2);
    expect((await state()).delivery).toHaveLength(2);
  });

  test('tenant reads are scoped while the system delivery queue carries no message or address', async () => {
    const a = await initial(); const b = await initial();
    const source = await event(a.conversationId);
    await new ProcessInbound(atomic(), new FoundationInboundHandler()).run(a);
    expect(await database.tenantTransaction('worker', b.userId,
      (tx) => tx.query('SELECT * FROM public.outbound_messages'))).toEqual([]);
    expect(await database.systemTransaction('delivery',
      (tx) => tx.query('SELECT * FROM public.outbound_messages'))).toEqual([]);
    expect(await database.tenantTransaction('delivery', a.userId,
      (tx) => tx.query('SELECT user_id FROM public.outbound_messages'))).toEqual([{ user_id: a.userId }]);
    expect(await database.tenantTransaction('delivery', b.userId,
      (tx) => tx.query('SELECT * FROM public.outbound_messages'))).toEqual([]);
    const columns = (await postgres.pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'delivery_work'`)).rows.map((row) => row.column_name);
    expect(columns).toEqual(expect.arrayContaining(['outbound_message_id', 'user_id', 'lease_generation']));
    expect(columns).not.toContain('payload'); expect(columns).not.toContain('text');
    expect(columns).not.toContain('external_message_id'); expect(columns).not.toContain('address');
    expect((await database.systemTransaction('delivery',
      (tx) => tx.query('SELECT user_id FROM public.delivery_work')))).toEqual([{ user_id: a.userId }]);
    await expect(database.tenantTransaction('worker', a.userId, (tx) => tx.query(`INSERT INTO public.outbound_messages
      (user_id, conversation_id, source_inbound_event_id, message_index, payload, dedupe_key, status)
      VALUES ($1,$2,$3,99,$4,$5,'sent')`, [a.userId, a.conversationId, source.id,
      JSON.stringify({ version: 1, kind: 'text', text: 'forged' }), `response:${source.id}:99:v1`])))
      .rejects.toMatchObject({ code: 'DB_FAILURE' });
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
    expect(saved.outbound).toHaveLength(text === undefined ? 0 : 1);
    expect(saved.delivery).toHaveLength(text === undefined ? 0 : 1);
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

  test('handler timeout records one retry, releases locks and cannot save a late result', async () => {
    const lease = await initial();
    let settle!: (value: typeof result) => void;
    expect(await new ProcessInbound(atomic(), { handle: () => new Promise((resolve) => { settle = resolve; }) }, 20).run(lease))
      .toMatchObject({ kind: 'retry', attemptCount: 1, availableAt: expect.any(Date) });
    const saved = await state();
    expect(saved.receipts).toEqual([]); expect(saved.work[0].state).toBe('retry');
    expect((await event(lease.conversationId)).attempt_count).toBe(1);
    settle(result); await new Promise((resolve) => setImmediate(resolve));
    expect(await state()).toEqual(saved);
  });

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

  test('preparation failure finalizes one error receipt without handler or retry charge', async () => {
    const lease = await initial(); await postgres.pool.query("UPDATE public.inbound_events SET preparation_status = 'failed'");
    expect(await new ProcessInbound(atomic(), { handle: async () => { throw new Error('must not handle'); } }).run(lease))
      .toMatchObject({ kind: 'actionable', value: { messages: [{ kind: 'text', text: expect.any(String) }] } });
    const saved = await state();
    expect(saved.events[0]).toMatchObject({ processing_status: 'failed', failure_code: 'invalid_payload' });
    expect(saved.receipts).toHaveLength(1); expect(saved.pointers[0].next_apply_sequence).toBe('2');
    expect(saved.outbound).toHaveLength(1); expect(saved.delivery).toHaveLength(1);
    expect((await event(lease.conversationId)).attempt_count).toBe(0);
  });

  const fail = { handle: async () => { throw Object.assign(new Error('private handler text'), { code: '08006' }); } };
  const due = async () => { await postgres.pool.query("UPDATE public.conversation_work SET available_at = clock_timestamp()");
    return (await queue.claim({ ownerId, limit: 1 }))[0]!; };
  const addNext = async () => { const chat = String(serial);
    await gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',
      [chat, chat, `message:${chat}:two`, '2026-10-01T00:00:00Z',
        JSON.stringify({ kind: 'text', text: 'next private' }), 'a'.repeat(64)]); };
  const attempts = async () => (await postgres.pool.query(
    'SELECT attempt_count, processing_status FROM public.inbound_events ORDER BY sequence')).rows;

  test('five failures are per head; unrelated inbound preserves backoff; terminal receipt unblocks next', async () => {
    let lease = await initial();
    for (let count = 1; count <= 5; count++) {
      const outcome = await new ProcessInbound(atomic(), fail).run(lease);
      expect((await attempts())[0]).toEqual({ attempt_count: count, processing_status: count === 5 ? 'failed' : 'accepted' });
      const saved = await state();
      if (count < 5) {
        expect(outcome).toMatchObject({ kind: 'retry', attemptCount: count, availableAt: expect.any(Date) });
        expect(saved.receipts).toHaveLength(0); expect(saved.pointers[0].next_apply_sequence).toBe('1');
        const work = (await postgres.pool.query('SELECT * FROM public.conversation_work')).rows[0];
        expect(work).toMatchObject({ state: 'retry', attempt_count: count, last_error_code: 'processing_error' });
        if (count === 1) { await addNext();
          expect((await postgres.pool.query('SELECT * FROM public.conversation_work')).rows[0]).toEqual(work); }
        expect(await queue.claim({ ownerId, limit: 1 })).toEqual([]);
        lease = await due();
      } else {
        expect(outcome).toMatchObject({ kind: 'actionable' });
        expect(saved.receipts).toHaveLength(1);
        expect(saved.outbound).toHaveLength(1); expect(saved.delivery).toHaveLength(1);
        expect(saved.receipts[0].result.messages).toEqual([
          { version: 1, kind: 'text', text: 'Не удалось обработать сообщение. Попробуйте отправить его ещё раз.' }]);
        expect(saved.events[0]).toMatchObject({ failure_code: 'retry_exhausted', processed_at: expect.any(Date) });
        expect(saved.pointers[0].next_apply_sequence).toBe('2');
        expect(saved.work[0].state).toBe('ready');
      }
    }
    const next = (await queue.claim({ ownerId, limit: 1 }))[0]!;
    expect(await new ProcessInbound(atomic(), fail).run(next)).toMatchObject({ kind: 'retry', attemptCount: 1 });
    expect(await attempts()).toEqual([{ attempt_count: 5, processing_status: 'failed' }, { attempt_count: 1, processing_status: 'accepted' }]);
    await new ProcessInbound(atomic(), new FoundationInboundHandler()).run(await due());
    expect((await state()).receipts).toHaveLength(2);
    await addNext(); // duplicate is inert; a genuinely new inbound wakes sleeping ready work below.
    const chat = String(serial);
    await gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',
      [chat, chat, `message:${chat}:three`, '2026-10-01T00:00:00Z', JSON.stringify({ kind: 'text', text: 'three' }), 'a'.repeat(64)]);
    expect(await queue.claim({ ownerId, limit: 1 })).toHaveLength(1);
  });

  test('wake preserves an existing retry row verbatim', async () => {
    await initial();
    await postgres.pool.query(`UPDATE public.conversation_work SET state = 'retry', lease_owner = NULL,
      lease_until = NULL, available_at = clock_timestamp() + interval '5 minutes', attempt_count = 3,
      last_error_code = 'processing_error'`);
    const before = (await postgres.pool.query('SELECT * FROM public.conversation_work')).rows;
    await addNext(); expect((await postgres.pool.query('SELECT * FROM public.conversation_work')).rows).toEqual(before);
  });

  test('preparing deferrals and database lock contention never charge the head', async () => {
    let lease = await initial(); await postgres.pool.query("UPDATE public.inbound_events SET preparation_status = 'preparing'");
    expect(await new ProcessInbound(atomic(), fail).run(lease)).toEqual({ kind: 'preparing' });
    expect((await attempts())[0].attempt_count).toBe(0); lease = await due();
    const blocker = await postgres.pool.connect();
    try { await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM public.conversations FOR UPDATE');
      await expect(new ProcessInbound(atomic(), fail).run(lease)).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
      expect((await attempts())[0].attempt_count).toBe(0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });

  test.each(['before commit', 'after commit'])('crash %s can be reclaimed without budget charge or duplicate receipt', async (phase) => {
    const lease = await initial(); await addNext();
    const broken = atomic({ tenantTransaction: async (role, userId, fn) => {
      const value = await database.tenantTransaction(role, userId, async (tx) => {
        const value = await fn(tx); if (phase === 'before commit') throw new Error('crash'); return value;
      });
      throw new Error(`ack lost ${String(value)}`);
    } });
    await expect(new ProcessInbound(broken, new FoundationInboundHandler()).run(lease)).rejects.toThrow();
    expect((await attempts()).every((row) => row.attempt_count === 0)).toBe(true);
    expect((await state()).receipts).toHaveLength(phase === 'before commit' ? 0 : 1);
    expect((await state()).outbound).toHaveLength(phase === 'before commit' ? 0 : 1);
    expect((await state()).delivery).toHaveLength(phase === 'before commit' ? 0 : 1);
    await postgres.pool.query("UPDATE public.conversation_work SET lease_until = clock_timestamp() - interval '1 second' WHERE state = 'leased'");
    const fresh = (await queue.claim({ ownerId, limit: 1 }))[0]!;
    await new ProcessInbound(atomic(), new FoundationInboundHandler()).run(fresh);
    const saved = await state(); expect(saved.receipts).toHaveLength(phase === 'before commit' ? 1 : 2);
    expect(saved.outbound).toHaveLength(saved.receipts.length);
    expect(saved.delivery).toHaveLength(saved.receipts.length);
    expect(new Set(saved.receipts.map((row) => row.inbound_event_id)).size).toBe(saved.receipts.length);
  });

  test.each([0, 4])('recovery commit ack loss at prior count %i never charges twice or duplicates terminal receipt', async (count) => {
    const lease = await initial(); await addNext();
    await postgres.pool.query('UPDATE public.inbound_events SET attempt_count = $1 WHERE sequence = 1', [count]);
    let calls = 0;
    const uncertain = atomic({ tenantTransaction: async (role, userId, fn) => {
      calls++; const value = await database.tenantTransaction(role, userId, fn);
      if (calls === 2) throw new Error('recovery ack lost'); return value;
    } });
    await expect(new ProcessInbound(uncertain, fail).run(lease)).rejects.toThrow('recovery ack lost');
    const saved = await state(); expect((await attempts())[0].attempt_count).toBe(count + 1);
    expect(saved.receipts).toHaveLength(count === 4 ? 1 : 0);
    await expect(new ProcessInbound(atomic(), fail).run(lease)).rejects.toMatchObject({ name: 'ConversationLeaseLostError' });
    expect(await state()).toEqual(saved); expect((await attempts())[1].attempt_count).toBe(0);
  });

  test.each(['token', 'head', 'identity', 'terminal', 'preparation'])('stale %s after pure failure cannot record against successor', async (change) => {
    const lease = await initial(); await addNext(); let failed = false; let calls = 0; let before: Awaited<ReturnType<typeof state>>;
    const raced = atomic({ tenantTransaction: async (role, userId, fn) => {
      calls++; try { return await database.tenantTransaction(role, userId, fn); }
      catch (error) { if (!failed) { failed = true;
        if (change === 'token') await postgres.pool.query('UPDATE public.conversation_work SET lease_generation = lease_generation + 1');
        else if (change === 'head') await postgres.pool.query('UPDATE public.conversations SET next_apply_sequence = 2');
        else if (change === 'identity') await postgres.pool.query('UPDATE public.inbound_events SET id = gen_random_uuid() WHERE sequence = 1');
        else if (change === 'preparation') await postgres.pool.query("UPDATE public.inbound_events SET preparation_status = 'preparing' WHERE sequence = 1");
        else await postgres.pool.query("UPDATE public.inbound_events SET processing_status = 'failed' WHERE sequence = 1");
        before = await state();
      } throw error; }
    } });
    await expect(new ProcessInbound(raced, fail).run(lease)).rejects.toThrow();
    expect(calls).toBe(2); expect(await state()).toEqual(before!); expect((await attempts()).every((row) => row.attempt_count === 0)).toBe(true);
  });
});
