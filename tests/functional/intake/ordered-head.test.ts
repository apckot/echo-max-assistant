import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ConversationLease } from '../../../src/modules/intake/application/conversation-queue.js';
import { MissingAllocatedHeadError } from '../../../src/modules/intake/application/ordered-head.js';
import { ConversationLeaseLostError } from '../../../src/modules/intake/application/work-disposition.js';
import { createDatabase, type Database } from '../../../src/infrastructure/postgres/database.js';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { PostgresConversationQueue } from '../../../src/infrastructure/postgres/postgres-conversation-queue.js';
import { PostgresFencedConversation } from '../../../src/infrastructure/postgres/postgres-fenced-conversation.js';
import { PostgresOrderedHead } from '../../../src/infrastructure/postgres/postgres-ordered-head.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ingressSql = 'SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)';
let serial = 1000;
const wait = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe('ordered conversation head', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let gateway: Pool;
  let database: Database;
  let queue: PostgresConversationQueue;
  let ordered: PostgresOrderedHead;

  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    const url = (role: string) => {
      const value = new URL(postgres.pool.options.connectionString!);
      value.username = `echo_${role}`;
      value.password = 'isolated-test-password';
      return value.toString();
    };
    for (const role of ['migrator', 'gateway', 'worker']) {
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    }
    migrator = new Pool({ connectionString: url('migrator') });
    gateway = new Pool({ connectionString: url('gateway') });
    await runMigrations(migrator, `${root}migrations`);
    database = createDatabase({ worker: url('worker') });
    queue = new PostgresConversationQueue(database);
    ordered = new PostgresOrderedHead(new PostgresFencedConversation(database));
  }, 120_000);
  beforeEach(async () => { await postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => {
    await Promise.all([database?.close(), migrator?.end(), gateway?.end()]);
    await postgres?.stop();
  });

  const accept = async (chat: string, key: string) => gateway.query(ingressSql,
    [chat, chat, `message:${chat}:${key}`, '2026-10-01T00:00:00.123Z',
      JSON.stringify({ kind: 'text', text: 'private' }), 'a'.repeat(64)]);
  const initial = async () => {
    const chat = String(++serial);
    await accept(chat, 'one');
    const [lease] = await queue.claim({ ownerId: owner, limit: 1 });
    return { chat, lease: lease! };
  };
  const claim = async () => (await queue.claim({ ownerId: otherOwner, limit: 1 }))[0]!;
  const head = async (lease: ConversationLease) => (await postgres.pool.query(
    'SELECT * FROM public.inbound_events WHERE conversation_id = $1 ORDER BY sequence',
    [lease.conversationId])).rows;
  const conversation = async (lease: ConversationLease) => (await postgres.pool.query(
    'SELECT * FROM public.conversations WHERE id = $1', [lease.conversationId])).rows[0];
  const work = async (lease: ConversationLease) => (await postgres.pool.query(
    'SELECT *, available_at::text AS availability FROM public.conversation_work WHERE conversation_id = $1',
    [lease.conversationId])).rows[0];
  const leave = async () => ({ value: 'untouched', disposition: { kind: 'keep' as const } });

  test('preparing head blocks ready successor without consuming retry budget, then becomes actionable', async () => {
    const { chat, lease } = await initial();
    await accept(chat, 'two');
    await postgres.pool.query(`UPDATE public.inbound_events SET preparation_status = 'preparing'
      WHERE conversation_id = $1 AND sequence = 1`, [lease.conversationId]);
    await postgres.pool.query(`UPDATE public.conversation_work SET attempt_count = 2, last_error_code = 'processing_error'
      WHERE conversation_id = $1`, [lease.conversationId]);
    let called = false;
    expect(await ordered.run(lease, async () => { called = true; return leave(); })).toEqual({ kind: 'preparing' });
    expect(called).toBe(false);
    expect(await conversation(lease)).toMatchObject({ next_apply_sequence: '1' });
    expect(await work(lease)).toMatchObject({ state: 'ready', attempt_count: 2,
      last_error_code: 'processing_error', lease_generation: '1' });
    expect((await work(lease)).availability).not.toBe('infinity');
    expect(await queue.claim({ ownerId: otherOwner, limit: 1 })).toEqual([]);
    await postgres.pool.query(`UPDATE public.inbound_events SET preparation_status = 'ready'
      WHERE conversation_id = $1 AND sequence = 1`, [lease.conversationId]);
    await postgres.pool.query(`UPDATE public.conversation_work SET available_at = clock_timestamp()
      WHERE conversation_id = $1`, [lease.conversationId]);
    const secondLease = await claim();
    expect(await ordered.run(secondLease, async (action) => {
      expect(action.kind).toBe('ready');
      expect(action.event.sequence).toBe(1n);
      expect(action.event.payload).toEqual({ kind: 'text', text: 'private' });
      return leave();
    })).toEqual({ kind: 'actionable', value: 'untouched' });
    expect(await conversation(lease)).toMatchObject({ next_apply_sequence: '1' });
    expect((await head(lease))[1].processing_status).toBe('accepted');
  });

  test.each(['applied', 'failed', 'ignored'] as const)('terminal %s head advances once and offers successor', async (status) => {
    const { chat, lease } = await initial();
    await accept(chat, 'two');
    await postgres.pool.query('UPDATE public.inbound_events SET processing_status = $1 WHERE conversation_id = $2 AND sequence = 1',
      [status, lease.conversationId]);
    await postgres.pool.query(`UPDATE public.conversation_work SET attempt_count = 3,
      last_error_code = 'processing_error' WHERE conversation_id = $1`, [lease.conversationId]);
    expect(await ordered.run(lease, async () => { throw new Error('terminal callback reached'); }))
      .toEqual({ kind: 'advanced' });
    expect(await conversation(lease)).toMatchObject({ next_apply_sequence: '2' });
    expect(await work(lease)).toMatchObject({ state: 'ready', attempt_count: 0,
      last_error_code: null, lease_generation: '1' });
    const secondLease = await claim();
    expect(await ordered.run(secondLease, async (action) => {
      expect(action.event.sequence).toBe(2n);
      return leave();
    })).toEqual({ kind: 'actionable', value: 'untouched' });
    expect(await conversation(lease)).toMatchObject({ next_apply_sequence: '2' });
  });

  test('preparation failure is offered for result finalization and callback rollback is atomic', async () => {
    const { lease } = await initial();
    await postgres.pool.query(`UPDATE public.inbound_events SET preparation_status = 'failed'
      WHERE conversation_id = $1`, [lease.conversationId]);
    await expect(ordered.run(lease, async (action, tx) => {
      expect(action.kind).toBe('preparation_failed');
      await tx.query(`UPDATE public.inbound_events SET processing_status = 'failed'
        WHERE id = $1`, [action.event.id]);
      throw new Error('receipt failed');
    })).rejects.toThrow('receipt failed');
    expect((await head(lease))[0].processing_status).toBe('accepted');
    expect(await conversation(lease)).toMatchObject({ next_apply_sequence: '1' });
    expect(await work(lease)).toMatchObject({ state: 'leased', lease_generation: '1' });
    expect(await ordered.run(lease, async (action) => {
      expect(action.kind).toBe('preparation_failed');
      return leave();
    })).toEqual({ kind: 'actionable', value: 'untouched' });
  });

  test('drained work sleeps on retained row and new inbound wakes with monotonic generation', async () => {
    const { chat, lease } = await initial();
    await postgres.pool.query(`UPDATE public.inbound_events SET processing_status = 'applied'
      WHERE conversation_id = $1`, [lease.conversationId]);
    expect(await ordered.run(lease, async () => { throw new Error('terminal callback reached'); }))
      .toEqual({ kind: 'advanced' });
    expect(await work(lease)).toMatchObject({ state: 'ready', availability: 'infinity', lease_generation: '1' });
    expect(await queue.claim({ ownerId: otherOwner, limit: 1 })).toEqual([]);
    await accept(chat, 'two');
    expect(await work(lease)).toMatchObject({ state: 'ready', lease_generation: '1' });
    const next = await claim();
    expect(next.leaseGeneration).toBe(2n);
    expect(await ordered.run(next, async (action) => {
      expect(action.event.sequence).toBe(2n);
      return leave();
    })).toEqual({ kind: 'actionable', value: 'untouched' });
  });

  test('no allocated head sleeps; missing allocated head fails closed', async () => {
    const { lease } = await initial();
    await postgres.pool.query('DELETE FROM public.inbound_events WHERE conversation_id = $1', [lease.conversationId]);
    await expect(ordered.run(lease, leave)).rejects.toBeInstanceOf(MissingAllocatedHeadError);
    expect(await conversation(lease)).toMatchObject({ next_apply_sequence: '1' });
    expect(await work(lease)).toMatchObject({ state: 'leased', lease_generation: '1' });
    await postgres.pool.query('UPDATE public.conversations SET next_apply_sequence = next_inbound_sequence WHERE id = $1',
      [lease.conversationId]);
    expect(await ordered.run(lease, leave)).toEqual({ kind: 'drained' });
    expect(await work(lease)).toMatchObject({ state: 'ready', availability: 'infinity', lease_generation: '1' });
  });

  test('a stale lease cannot inspect or advance a head; another conversation can progress', async () => {
    const first = await initial();
    const second = await initial();
    await postgres.pool.query(`UPDATE public.conversation_work SET lease_until = clock_timestamp() - interval '1 second'
      WHERE conversation_id = $1`, [first.lease.conversationId]);
    await postgres.pool.query(`UPDATE public.inbound_events SET processing_status = 'ignored'
      WHERE conversation_id = $1`, [second.lease.conversationId]);
    expect(await ordered.run(second.lease, leave)).toEqual({ kind: 'advanced' });
    let entered = false;
    await expect(ordered.run(first.lease, async () => { entered = true; return leave(); }))
      .rejects.toBeInstanceOf(ConversationLeaseLostError);
    expect(entered).toBe(false);
    expect(await conversation(first.lease)).toMatchObject({ next_apply_sequence: '1' });
    expect(await conversation(second.lease)).toMatchObject({ next_apply_sequence: '2' });
  });

  test('ingress committed before inspection is seen behind terminal head', async () => {
    const { chat, lease } = await initial();
    await postgres.pool.query(`UPDATE public.inbound_events SET processing_status = 'ignored'
      WHERE conversation_id = $1`, [lease.conversationId]);
    const blocker = await postgres.pool.connect();
    let processing: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM public.conversations WHERE id = $1 FOR UPDATE', [lease.conversationId]);
      processing = ordered.run(lease, leave);
      void processing.catch(() => undefined);
      let blocked = false;
      for (let i = 0; i < 50 && !blocked; i++) {
        blocked = (await postgres.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))) AS blocked',
          [blocker.processID])).rows[0]!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await blocker.query(ingressSql, [chat, chat, `message:${chat}:two`, '2026-10-01T00:00:00.123Z',
        JSON.stringify({ kind: 'text', text: 'private' }), 'a'.repeat(64)]);
      await blocker.query('COMMIT');
      expect(await processing).toEqual({ kind: 'advanced' });
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await processing?.catch(() => undefined); }
    expect(await work(lease)).toMatchObject({ state: 'ready', lease_generation: '1' });
    expect((await work(lease)).availability).not.toBe('infinity');
    expect(await conversation(lease)).toMatchObject({ next_apply_sequence: '2', next_inbound_sequence: '3' });
  });

  test('ingress waiting behind terminal drain wakes sleeping row after commit', async () => {
    const { chat, lease } = await initial();
    await postgres.pool.query(`UPDATE public.inbound_events SET processing_status = 'ignored'
      WHERE conversation_id = $1`, [lease.conversationId]);
    const finalized = wait();
    const commit = wait();
    const delayed = new PostgresOrderedHead(new PostgresFencedConversation({ tenantTransaction: (role, userId, fn) =>
      database.tenantTransaction(role, userId, async (tx) => {
        const result = await fn(tx);
        finalized.release();
        await commit.promise;
        return result;
      }) }));
    const processing = delayed.run(lease, leave);
    try {
      await finalized.promise;
      const incoming = accept(chat, 'two');
      let blocked = false;
      for (let i = 0; i < 50 && !blocked; i++) {
        blocked = (await postgres.pool.query<{ blocked: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = \'Lock\' AND pid <> pg_backend_pid()) AS blocked'))
          .rows[0]!.blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      commit.release();
      expect(await processing).toEqual({ kind: 'advanced' });
      await incoming;
    } finally { commit.release(); await processing.catch(() => undefined); }
    expect(await work(lease)).toMatchObject({ state: 'ready', lease_generation: '1' });
    expect((await work(lease)).availability).not.toBe('infinity');
    expect((await claim()).leaseGeneration).toBe(2n);
  });
});
