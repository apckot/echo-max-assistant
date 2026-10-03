import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createDatabase, type Database, type DbTx } from '../../../src/infrastructure/postgres/database.js';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { PostgresConversationQueue } from '../../../src/infrastructure/postgres/postgres-conversation-queue.js';
import { PostgresFencedConversation } from '../../../src/infrastructure/postgres/postgres-fenced-conversation.js';
import type { ConversationLease } from '../../../src/modules/intake/application/conversation-queue.js';
import { ConversationLeaseLostError, type WorkDisposition } from '../../../src/modules/intake/application/work-disposition.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let externalId = 100;
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe('fenced conversation transactions', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let gateway: Pool;
  let database: Database;
  let queue: PostgresConversationQueue;
  let fenced: PostgresFencedConversation;

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
    fenced = new PostgresFencedConversation(database);
  }, 120_000);
  beforeEach(async () => { await postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => {
    await Promise.all([database?.close(), migrator?.end(), gateway?.end()]);
    await postgres?.stop();
  });

  const ingressArgs = (id: string, key: string) => [id, id, `message:${key}`,
    '2026-10-01T00:00:00.123Z', JSON.stringify({ kind: 'text', text: 'private' }), 'a'.repeat(64)];
  const ingressSql = 'SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)';
  const claim = async () => {
    const id = String(++externalId);
    await gateway.query(ingressSql, ingressArgs(id, id));
    return (await queue.claim({ ownerId: ownerA, limit: 1 }))[0]!;
  };
  const work = async (lease: ConversationLease) => (await postgres.pool.query(
    'SELECT *, available_at::text AS availability FROM public.conversation_work WHERE conversation_id = $1',
    [lease.conversationId])).rows[0];
  const effect = async (tx: DbTx, lease: ConversationLease, count: number) => {
    await tx.query('UPDATE public.inbound_events SET attempt_count = $1 WHERE conversation_id = $2',
      [count, lease.conversationId]);
  };
  const effectCount = async (lease: ConversationLease) => (await postgres.pool.query(
    'SELECT attempt_count FROM public.inbound_events WHERE conversation_id = $1 ORDER BY sequence',
    [lease.conversationId])).rows[0]!.attempt_count;
  const expire = async (lease: ConversationLease) => {
    await postgres.pool.query(`UPDATE public.conversation_work SET lease_until = clock_timestamp() - interval '1 second'
      WHERE conversation_id = $1`, [lease.conversationId]);
  };

  test.each(['keep', 'ready', 'retry', 'sleep'] as const)('commits effects and guarded %s disposition', async (kind) => {
    const lease = await claim();
    const future = new Date(Date.now() + 60_000);
    const disposition: WorkDisposition = kind === 'retry'
      ? { kind, availableAt: future, attemptCount: 2, lastErrorCode: 'processing_error' }
      : { kind };
    const value = await fenced.run(lease, async (tx) => {
      await effect(tx, lease, 2);
      return { value: 'committed', disposition };
    });
    expect(value).toBe('committed');
    expect(await effectCount(lease)).toBe(2);
    expect(await work(lease)).toMatchObject({ state: kind === 'keep' ? 'leased' : kind === 'retry' ? 'retry' : 'ready',
      lease_owner: kind === 'keep' ? ownerA : null, lease_generation: '1',
      attempt_count: kind === 'retry' ? 2 : 0, last_error_code: kind === 'retry' ? 'processing_error' : null });
    if (kind !== 'keep') expect((await work(lease)).lease_until).toBeNull();
    if (kind === 'sleep') expect((await work(lease)).availability).toBe('infinity');
    if (kind === 'retry') expect((await work(lease)).available_at).toEqual(future);
  });

  test('ready can defer a check and clears prior retry metadata', async () => {
    const lease = await claim();
    await postgres.pool.query(`UPDATE public.conversation_work SET attempt_count = 3, last_error_code = 'processing_error'
      WHERE conversation_id = $1`, [lease.conversationId]);
    const future = new Date(Date.now() + 60_000);
    await fenced.run(lease, async () => ({ value: undefined, disposition: { kind: 'ready', availableAt: future } }));
    expect(await work(lease)).toMatchObject({ available_at: future, attempt_count: 0, last_error_code: null });
    expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
  });

  test('late generation one cannot overwrite committed generation two effects', async () => {
    const a = await claim();
    await expire(a);
    const [b] = await queue.claim({ ownerId: ownerB, limit: 1 });
    expect(b!.leaseGeneration).toBe(2n);
    await fenced.run(b!, async (tx) => {
      await effect(tx, b!, 2);
      return { value: undefined, disposition: { kind: 'keep' } };
    });
    await expect(fenced.run(a, async (tx) => {
      await effect(tx, a, 1);
      return { value: undefined, disposition: { kind: 'sleep' } };
    })).rejects.toBeInstanceOf(ConversationLeaseLostError);
    expect(await effectCount(a)).toBe(2);
    expect(await work(a)).toMatchObject({ state: 'leased', lease_owner: ownerB, lease_generation: '2' });
  });

  test.each(['owner', 'generation', 'user', 'conversation', 'state', 'expired', 'missing'] as const)(
    'denies a mismatched %s before exposing tenant data to the callback', async (mismatch) => {
      const lease = await claim();
      const other = await claim();
      const token = { ...lease };
      if (mismatch === 'owner') token.ownerId = ownerB;
      if (mismatch === 'generation') token.leaseGeneration = 0n;
      if (mismatch === 'user') token.userId = other.userId;
      if (mismatch === 'conversation') token.conversationId = other.conversationId;
      if (mismatch === 'state') await postgres.pool.query(`UPDATE public.conversation_work
        SET state = 'ready', lease_owner = NULL, lease_until = NULL WHERE conversation_id = $1`, [lease.conversationId]);
      if (mismatch === 'expired') await expire(lease);
      if (mismatch === 'missing') await postgres.pool.query('DELETE FROM public.conversation_work WHERE conversation_id = $1',
        [lease.conversationId]);
      let entered = false;
      await expect(fenced.run(token, async (tx) => {
        entered = true;
        await effect(tx, lease, 1);
        return { value: undefined, disposition: { kind: 'keep' } };
      })).rejects.toBeInstanceOf(ConversationLeaseLostError);
      expect(entered).toBe(false);
      expect(await effectCount(lease)).toBe(0);
      expect(await effectCount(other)).toBe(0);
    });

  test('tenant callback cannot read or update another tenant', async () => {
    const lease = await claim();
    const other = await claim();
    await fenced.run(lease, async (tx) => {
      expect(await tx.query('SELECT id FROM public.inbound_events WHERE user_id = $1', [other.userId])).toEqual([]);
      await effect(tx, other, 9);
      await effect(tx, lease, 1);
      return { value: undefined, disposition: { kind: 'keep' } };
    });
    expect(await effectCount(other)).toBe(0);
    expect(await effectCount(lease)).toBe(1);
  });

  test('callback exception rolls back all provisional effects', async () => {
    const lease = await claim();
    await expect(fenced.run(lease, async (tx) => {
      await effect(tx, lease, 1);
      throw new Error('callback failure');
    })).rejects.toThrow('callback failure');
    expect(await effectCount(lease)).toBe(0);
    expect(await work(lease)).toMatchObject({ state: 'leased', lease_generation: '1' });
  });

  test.each(['keep', 'sleep'] as const)('expiry during the callback rolls back %s effects using fresh DB time', async (kind) => {
    const lease = await claim();
    await expect(fenced.run(lease, async (tx) => {
      await effect(tx, lease, 1);
      // Fixture forces expiry after transaction-start now(), avoiding a real lease-length sleep.
      await tx.query(`UPDATE public.conversation_work SET lease_until = clock_timestamp() + interval '40 milliseconds'
        WHERE conversation_id = $1`, [lease.conversationId]);
      await tx.query('SELECT pg_sleep(0.07)');
      return { value: undefined, disposition: { kind } };
    })).rejects.toBeInstanceOf(ConversationLeaseLostError);
    expect(await effectCount(lease)).toBe(0);
    expect(await work(lease)).toMatchObject({ state: 'leased', lease_owner: ownerA, lease_generation: '1' });
  });

  test('finalization holds both locks until commit and prevents an intervening claim', async () => {
    const lease = await claim();
    const finalized = barrier();
    const commit = barrier();
    const boundary = new PostgresFencedConversation({ tenantTransaction: (role, userId, fn) =>
      database.tenantTransaction(role, userId, async (tx) => {
        const value = await fn(tx);
        finalized.release();
        await commit.promise;
        return value;
      }) });
    const processing = boundary.run(lease, async (tx) => {
      await effect(tx, lease, 1);
      return { value: undefined, disposition: { kind: 'ready' } };
    });
    try {
      await Promise.race([finalized.promise, processing]);
      expect(await effectCount(lease)).toBe(0);
      expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
      await expect(postgres.pool.query('SELECT id FROM public.conversations WHERE id = $1 FOR UPDATE NOWAIT',
        [lease.conversationId])).rejects.toMatchObject({ code: '55P03' });
    } finally { commit.release(); await processing; }
    expect(await effectCount(lease)).toBe(1);
    expect((await queue.claim({ ownerId: ownerB, limit: 1 }))[0]).toMatchObject({ leaseGeneration: 2n });
  });

  test('ingress holding conversation can wake work while processing waits in the same lock order', async () => {
    const lease = await claim();
    const blocker = await postgres.pool.connect();
    let processing: Promise<void> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM public.conversations WHERE id = $1 FOR UPDATE', [lease.conversationId]);
      processing = fenced.run(lease, async (tx) => {
        await effect(tx, lease, 1);
        return { value: undefined, disposition: { kind: 'ready' } };
      });
      // Attach a rejection handler before inspecting the deterministic blocked session.
      void processing.catch(() => undefined);
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        waiting = (await postgres.pool.query<{ waiting: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))) AS waiting',
          [blocker.processID])).rows[0]!.waiting;
        if (!waiting) await setTimeout(10);
      }
      expect(waiting).toBe(true);
      await blocker.query(ingressSql, ingressArgs(String(externalId), `later:${externalId}`));
      await blocker.query('COMMIT');
      await processing;
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await processing?.catch(() => undefined); }
    expect(await effectCount(lease)).toBe(1);
    expect((await postgres.pool.query('SELECT count(*) FROM public.inbound_events WHERE conversation_id = $1',
      [lease.conversationId])).rows[0]!.count).toBe('2');
  });
});
