import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createDatabase, type Database } from '../../../src/infrastructure/postgres/database.js';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { PostgresConversationQueue } from '../../../src/infrastructure/postgres/postgres-conversation-queue.js';
import type { ConversationId, UserId } from '../../../src/shared/types/identity.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let externalId = 100;

describe('conversation queue claim and renewal', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let gateway: Pool;
  let database: Database;
  let queue: PostgresConversationQueue;

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
  }, 120_000);
  beforeEach(async () => { await postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => {
    await Promise.all([database?.close(), migrator?.end(), gateway?.end()]);
    await postgres?.stop();
  });

  const wake = async (key: string) => {
    const id = String(++externalId);
    await gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',
      [id, id, `message:${key}`, '2026-10-01T00:00:00.123Z',
        JSON.stringify({ kind: 'text', text: `private ${key}` }), 'a'.repeat(64)]);
    return (await postgres.pool.query<{ conversation_id: string; user_id: string }>(
      `SELECT w.conversation_id, w.user_id FROM public.conversation_work w
       JOIN public.conversations c ON c.id = w.conversation_id WHERE c.external_conversation_id = $1`, [id])).rows[0]!;
  };
  const row = async (id: string) => (await postgres.pool.query(
    'SELECT * FROM public.conversation_work WHERE conversation_id = $1', [id])).rows[0];

  test('claims a finite due batch and returns only internal technical metadata', async () => {
    const due = await wake('due');
    const alsoDue = await wake('also-due');
    const future = await wake('future');
    const dead = await wake('dead');
    const active = await wake('active');
    await postgres.pool.query(`UPDATE public.conversation_work SET state = 'retry',
      available_at = now() - interval '2 seconds' WHERE conversation_id = $1`, [due.conversation_id]);
    await postgres.pool.query(`UPDATE public.conversation_work SET available_at = now() - interval '1 second'
      WHERE conversation_id = $1`, [alsoDue.conversation_id]);
    await postgres.pool.query(`UPDATE public.conversation_work SET available_at = now() + interval '1 hour'
      WHERE conversation_id = $1`, [future.conversation_id]);
    await postgres.pool.query(`UPDATE public.conversation_work SET state = 'dead' WHERE conversation_id = $1`, [dead.conversation_id]);
    await postgres.pool.query(`UPDATE public.conversation_work SET state = 'leased', lease_owner = $2,
      lease_until = now() + interval '1 hour' WHERE conversation_id = $1`, [active.conversation_id, ownerB]);
    const claimed = await queue.claim({ ownerId: ownerA, limit: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toEqual({ conversationId: due.conversation_id, userId: due.user_id,
      ownerId: ownerA, leaseGeneration: 1n, leaseUntil: expect.any(Date), attemptCount: 0 });
    expect(claimed[0]!.leaseUntil.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect((await row(due.conversation_id)).state).toBe('leased');
    expect((await queue.claim({ ownerId: ownerA, limit: 1 }))[0]!.conversationId).toBe(alsoDue.conversation_id);
    expect(await queue.claim({ ownerId: ownerA, limit: 1 })).toEqual([]);
  });

  test('concurrent workers claim distinct conversations without overlap', async () => {
    const first = await wake('one');
    const second = await wake('two');
    const [a, b] = await Promise.all([
      queue.claim({ ownerId: ownerA, limit: 1 }), queue.claim({ ownerId: ownerB, limit: 1 }),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(new Set([a[0]!.conversationId, b[0]!.conversationId]))
      .toEqual(new Set([first.conversation_id, second.conversation_id]));
  });

  test('skips a row locked by another transaction without waiting for its release', async () => {
    const locked = await wake('locked');
    const free = await wake('free');
    const client = await postgres.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM public.conversation_work WHERE conversation_id = $1 FOR UPDATE', [locked.conversation_id]);
      const claimed = await queue.claim({ ownerId: ownerA, limit: 2 });
      expect(claimed.map((item) => item.conversationId)).toEqual([free.conversation_id]);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect((await queue.claim({ ownerId: ownerB, limit: 1 }))[0]!.conversationId).toBe(locked.conversation_id);
  });

  test('reclaims an expired lease with a newer generation and preserves attempts', async () => {
    const work = await wake('expired');
    await postgres.pool.query(`UPDATE public.conversation_work SET state = 'leased', lease_owner = $2,
      lease_until = now() - interval '1 second', lease_generation = 8, attempt_count = 3
      WHERE conversation_id = $1`, [work.conversation_id, ownerB]);
    const [claimed] = await queue.claim({ ownerId: ownerA, limit: 1 });
    expect(claimed).toMatchObject({ conversationId: work.conversation_id, userId: work.user_id,
      ownerId: ownerA, leaseGeneration: 9n, attemptCount: 3 });
    expect((await row(work.conversation_id)).lease_generation).toBe('9');
  });

  test('renews only the current owner and generation while the lease is unexpired', async () => {
    const work = await wake('renew');
    const [claim] = await queue.claim({ ownerId: ownerA, limit: 1 });
    expect(claim!.conversationId).toBe(work.conversation_id);
    const renewed = await queue.renew(claim!, 120_000);
    expect(renewed).toBeInstanceOf(Date);
    expect(renewed!.getTime()).toBeGreaterThan(claim!.leaseUntil.getTime() + 50_000);
    expect(await queue.renew({ ...claim!, ownerId: ownerB })).toBeNull();
    expect(await queue.renew({ ...claim!, leaseGeneration: 0n })).toBeNull();
    await postgres.pool.query(`UPDATE public.conversation_work SET lease_until = now() - interval '1 second'
      WHERE conversation_id = $1`, [work.conversation_id]);
    expect(await queue.renew(claim!)).toBeNull();
    expect((await row(work.conversation_id)).lease_until.getTime()).toBeLessThan(Date.now());
  });

  test('a rolled back claim leaves the row ready', async () => {
    const work = await wake('rollback');
    const rollbackDatabase: Pick<Database, 'systemTransaction'> = {
      systemTransaction: (role, fn) => database.systemTransaction(role, async (tx) => {
        await fn(tx);
        throw new Error('rollback marker');
      }),
    };
    const rollingQueue = new PostgresConversationQueue(rollbackDatabase);
    await expect(rollingQueue.claim({ ownerId: ownerA, limit: 1 })).rejects.toThrow('rollback marker');
    expect(await row(work.conversation_id)).toMatchObject({ state: 'ready', lease_owner: null, lease_generation: '0' });
    expect((await queue.claim({ ownerId: ownerB, limit: 1 }))[0]!.conversationId).toBe(work.conversation_id);
  });

  test('rejects invalid owners, identifiers, generations and bounds before SQL', async () => {
    await expect(queue.claim({ ownerId: 'bad', limit: 1 })).rejects.toThrow();
    await expect(queue.claim({ ownerId: ownerA, limit: 0 })).rejects.toThrow();
    await expect(queue.claim({ ownerId: ownerA, limit: 101 })).rejects.toThrow();
    await expect(queue.claim({ ownerId: ownerA, limit: 1, leaseMs: 300_001 })).rejects.toThrow();
    await expect(queue.renew({ conversationId: 'bad' as ConversationId,
      userId: 'bad' as UserId, ownerId: ownerA, leaseGeneration: 1n,
      leaseUntil: new Date(), attemptCount: 0 })).rejects.toThrow();
    await expect(queue.renew({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ConversationId,
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as UserId,
      ownerId: ownerA, leaseGeneration: -1n, leaseUntil: new Date(), attemptCount: 0 })).rejects.toThrow();
    await expect(queue.renew({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as ConversationId,
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as UserId,
      ownerId: ownerA, leaseGeneration: 9_223_372_036_854_775_808n,
      leaseUntil: new Date(), attemptCount: 0 })).rejects.toThrow();
  });
});
