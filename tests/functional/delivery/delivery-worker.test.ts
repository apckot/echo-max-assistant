import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeliveryWorker } from '../../../src/modules/delivery/application/delivery-worker.js';
import { PostgresDeliveryAdmission } from '../../../src/infrastructure/postgres/postgres-delivery-admission.js';
import { PostgresDeliveryCompletion } from '../../../src/infrastructure/postgres/postgres-delivery-completion.js';
import { PostgresDeliveryQueue } from '../../../src/infrastructure/postgres/postgres-delivery-queue.js';
import type { Database, DbTx } from '../../../src/infrastructure/postgres/database.js';
import { deliveryFixture, ownerA, ownerB } from '../../support/delivery-fixture.js';

describe('one lease delivery across real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof deliveryFixture>>;
  let queue: PostgresDeliveryQueue;
  let admission: PostgresDeliveryAdmission;
  let completion: PostgresDeliveryCompletion;
  beforeAll(async () => {
    f = await deliveryFixture();
    queue = new PostgresDeliveryQueue(f.database);
    admission = new PostgresDeliveryAdmission(f.database);
    completion = new PostgresDeliveryCompletion(f.database);
  }, 120_000);
  beforeEach(async () => { await f.postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => { await f?.close(); });
  const rows = async (table: string) => (await f.postgres.pool.query(`SELECT * FROM public.${table}
    ${table === 'delivery_attempts' ? 'ORDER BY attempt_number, phase DESC' : ''}`)).rows;
  const claim = async (owner = ownerA) => (await queue.claim({ ownerId: owner, limit: 1 }))[0]!;

  test('acknowledged admission sends once outside tenant transactions under duplicate orchestration', async () => {
    await f.seed();
    const lease = await claim();
    let inTransaction = false;
    const senderTransactionStates: boolean[] = [];
    const database: Pick<Database, 'tenantTransaction'> = { tenantTransaction: (role, user, fn) =>
      f.database.tenantTransaction(role, user, async (tx) => {
        inTransaction = true;
        try { return await fn(tx); } finally { inTransaction = false; }
      }) };
    let entered!: () => void;
    let release!: () => void;
    const sentEntered = new Promise<void>((resolve) => { entered = resolve; });
    const canFinish = new Promise<void>((resolve) => { release = resolve; });
    const sender = { send: vi.fn(async () => {
      senderTransactionStates.push(inTransaction);
      entered();
      await canFinish;
      return { status: 'sent' as const, externalMessageId: 'private-success-id' };
    }) };
    const worker = new DeliveryWorker(new PostgresDeliveryAdmission(database), sender,
      new PostgresDeliveryCompletion(database));
    const first = worker.run(lease);
    await sentEntered;
    expect(await worker.run(lease)).toMatchObject({ status: 'not_admitted', admission: { status: 'in_flight' } });
    release();
    expect(await first).toMatchObject({ status: 'completed', completion: { status: 'sent' } });
    expect(senderTransactionStates).toEqual([false]);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(await rows('delivery_attempts')).toMatchObject([
      { phase: 'started', attempt_number: 1 }, { phase: 'completed', attempt_number: 1, certainty: 'sent' },
    ]);
    expect(await rows('delivery_work')).toMatchObject([{ state: 'sent', attempt_count: 1 }]);
  });

  test('lost admission ACK creates no call; reclaim closes the abandoned attempt uncertain', async () => {
    await f.seed();
    const lease = await claim();
    const sender = { send: vi.fn() };
    const lostAck = new PostgresDeliveryAdmission({ tenantTransaction: async (role, user, fn) => {
      await f.database.tenantTransaction(role, user, fn);
      throw new Error('admission ACK lost');
    } });
    await expect(new DeliveryWorker(lostAck, sender, completion).run(lease)).rejects.toThrow('admission ACK lost');
    expect(sender.send).not.toHaveBeenCalled();
    expect(await rows('delivery_attempts')).toMatchObject([{ phase: 'started', attempt_number: 1 }]);
    await f.postgres.pool.query("UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 second'");
    const reclaimed = await claim(ownerB);
    expect((await new DeliveryWorker(admission, sender, completion).run(reclaimed)).status).toBe('not_admitted');
    expect(sender.send).not.toHaveBeenCalled();
    expect(await rows('delivery_attempts')).toMatchObject([
      { phase: 'started', attempt_number: 1 },
      { phase: 'completed', attempt_number: 1, certainty: 'uncertain', code: 'attempt_abandoned' },
    ]);
    expect(await rows('delivery_work')).toMatchObject([{ state: 'uncertain' }]);
  });

  test('rolled-back admission makes no sender call or attempt', async () => {
    await f.seed();
    const sender = { send: vi.fn() };
    const failed = new PostgresDeliveryAdmission({ tenantTransaction: (role, user, fn) =>
      f.database.tenantTransaction(role, user, async (tx) => {
        await fn(tx);
        throw new Error('admission rollback');
      }) });
    await expect(new DeliveryWorker(failed, sender, completion).run(await claim()))
      .rejects.toThrow('admission rollback');
    expect(sender.send).not.toHaveBeenCalled();
    expect(await rows('delivery_attempts')).toEqual([]);
  });

  test('a later message is deferred before any sender call while predecessor is pending', async () => {
    const first = await f.seed();
    await claim();
    const later = (await f.postgres.pool.query(`INSERT INTO public.outbound_messages
      (user_id,conversation_id,source_inbound_event_id,message_index,payload,dedupe_key)
      SELECT user_id,conversation_id,source_inbound_event_id,1,payload,
        'response:'||source_inbound_event_id::text||':1:v1'
      FROM public.outbound_messages WHERE id=$1 RETURNING id,user_id`, [first.id])).rows[0];
    await f.postgres.pool.query('INSERT INTO public.delivery_work (outbound_message_id,user_id) VALUES ($1,$2)',
      [later.id, later.user_id]);
    const sender = { send: vi.fn() };
    const result = await new DeliveryWorker(admission, sender, completion).run(await claim(ownerB));
    expect(result).toMatchObject({ status: 'not_admitted', admission: { status: 'deferred' } });
    expect(sender.send).not.toHaveBeenCalled();
    expect(await rows('delivery_attempts')).toEqual([]);
  });

  test('lost completion ACK after a confirmed send cannot authorize another call', async () => {
    await f.seed();
    const lease = await claim();
    const sender = { send: vi.fn().mockResolvedValue({ status: 'sent', externalMessageId: 'private-success-id' }) };
    const lostAck = new PostgresDeliveryCompletion({ tenantTransaction: async (role, user, fn) => {
      await f.database.tenantTransaction(role, user, fn);
      throw new Error('completion ACK lost');
    } });
    await expect(new DeliveryWorker(admission, sender, lostAck).run(lease)).rejects.toThrow('completion ACK lost');
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(await rows('delivery_work')).toMatchObject([{ state: 'sent' }]);
    expect(await rows('delivery_attempts')).toMatchObject([
      { phase: 'started' }, { phase: 'completed', certainty: 'sent' },
    ]);
    expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
    await expect(new DeliveryWorker(admission, sender, completion).run(lease)).rejects.toThrow();
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test('only proven not_sent repeats five times, then six calls exhaust the budget', async () => {
    await f.seed();
    const timedAdmission = new PostgresDeliveryAdmission({ tenantTransaction: (role, user, fn) =>
      f.database.tenantTransaction(role, user, (tx) => fn({ query: (sql, params) =>
        tx.query(sql.includes('AS blocked')
          ? sql.replace('SELECT clock_timestamp() AS now',
            "SELECT clock_timestamp()+interval '1 hour' AS now") : sql, params) } as DbTx)) });
    const sender = { send: vi.fn().mockResolvedValue({ status: 'not_sent', code: 'preconnection_failure', retryable: true }) };
    const worker = new DeliveryWorker(timedAdmission, sender, completion, () => 0);
    for (let n = 1; n <= 6; n++) {
      const lease = await claim(n % 2 ? ownerA : ownerB);
      expect(lease).toBeDefined();
      const before = (await f.postgres.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      const result = await worker.run(lease);
      const after = (await f.postgres.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      expect(result).toMatchObject({ status: 'completed', completion: { status: n < 6 ? 'retry' : 'dead' } });
      const work = (await rows('delivery_work'))[0];
      expect(work.attempt_count).toBe(n);
      if (n < 6) {
        const delay = 500 * 2 ** (n - 1);
        expect(work.available_at.getTime()).toBeGreaterThanOrEqual(before.getTime() + delay);
        expect(work.available_at.getTime()).toBeLessThanOrEqual(after.getTime() + delay + 1);
        await f.postgres.pool.query('UPDATE public.delivery_work SET available_at=clock_timestamp()');
      } else expect(work.last_error_code).toBe('attempt_budget_exhausted');
    }
    expect(sender.send).toHaveBeenCalledTimes(6);
    expect(await queue.claim({ ownerId: ownerA, limit: 1 })).toEqual([]);
    expect((await rows('delivery_attempts')).filter((row) => row.phase === 'completed'))
      .toHaveLength(6);
  });

  test('retry scheduling honors full Retry-After while retaining actual not_sent certainty', async () => {
    await f.seed();
    const sender = { send: vi.fn().mockResolvedValue({ status: 'not_sent', code: 'rate_limited',
      retryable: true, retryAfterMs: 3_000_000_000 }) };
    const before = (await f.postgres.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const result = await new DeliveryWorker(admission, sender, completion, () => 0).run(await claim());
    const after = (await f.postgres.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    expect(result).toMatchObject({ status: 'completed', completion: { status: 'retry' } });
    const work = (await rows('delivery_work'))[0];
    expect(work.available_at.getTime()).toBeGreaterThanOrEqual(before.getTime() + 3_000_000_000);
    expect(work.available_at.getTime()).toBeLessThanOrEqual(after.getTime() + 3_000_000_001);
    expect(await rows('delivery_attempts')).toMatchObject([
      { phase: 'started' }, { phase: 'completed', certainty: 'not_sent', code: 'rate_limited' },
    ]);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test('sender exception is closed uncertain and never reclaimed for retry', async () => {
    await f.seed();
    const sender = { send: vi.fn().mockRejectedValue(new Error('private token and address')) };
    expect(await new DeliveryWorker(admission, sender, completion).run(await claim()))
      .toMatchObject({ status: 'completed', completion: { status: 'uncertain' } });
    expect(await rows('delivery_attempts')).toMatchObject([
      { phase: 'started' }, { phase: 'completed', certainty: 'uncertain', code: 'sender_exception' },
    ]);
    expect(JSON.stringify(await rows('delivery_work'))).not.toContain('private token');
    expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test('possible HTTP dispatch remains actual uncertain certainty with no automatic retry', async () => {
    await f.seed();
    const sender = { send: vi.fn().mockResolvedValue({ status: 'uncertain', code: 'server_failure' }) };
    expect(await new DeliveryWorker(admission, sender, completion).run(await claim()))
      .toMatchObject({ status: 'completed', completion: { status: 'uncertain' } });
    expect(await rows('delivery_attempts')).toMatchObject([
      { phase: 'started' }, { phase: 'completed', certainty: 'uncertain', code: 'server_failure' },
    ]);
    expect(await rows('delivery_work')).toMatchObject([{ state: 'uncertain', last_error_code: 'server_failure' }]);
    expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});
