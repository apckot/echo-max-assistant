import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { PostgresDeliveryQueue } from '../../../src/infrastructure/postgres/postgres-delivery-queue.js';
import { deliveryFixture, ownerA, ownerB } from '../../support/delivery-fixture.js';

describe('technical delivery queue claims', () => {
  let fixture: Awaited<ReturnType<typeof deliveryFixture>>;
  let queue: PostgresDeliveryQueue;
  beforeAll(async () => {
    fixture = await deliveryFixture();
    queue = new PostgresDeliveryQueue(fixture.database);
  }, 120_000);
  beforeEach(async () => { await fixture.postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => { await fixture?.close(); });
  const row = async (id: string) => (await fixture.postgres.pool.query('SELECT * FROM public.delivery_work WHERE outbound_message_id = $1', [id])).rows[0];
  const databaseNow = async () => (await fixture.postgres.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime();

  test.each([-300_000, 300_000])('claims only a bounded due batch, retaining terminal rows and only internal metadata with host clock offset %i ms', async (hostClockOffset) => {
    const due = await fixture.seed();
    const next = await fixture.seed();
    const future = await fixture.seed();
    await fixture.postgres.pool.query("UPDATE public.delivery_work SET state = 'retry', available_at = now() - interval '1 hour' WHERE outbound_message_id = $1", [due.id]);
    await fixture.postgres.pool.query("UPDATE public.delivery_work SET available_at = now() + interval '1 day' WHERE outbound_message_id = $1", [future.id]);
    for (const state of ['sent', 'uncertain', 'dead', 'cancelled']) {
      const terminal = await fixture.seed();
      await fixture.postgres.pool.query('UPDATE public.delivery_work SET state = $2, lease_generation = 4 WHERE outbound_message_id = $1', [terminal.id, state]);
    }
    const hostNow = Date.now;
    const hostClock = vi.spyOn(Date, 'now').mockImplementation(() => hostNow() + hostClockOffset);
    try {
      const beforeClaim = await databaseNow();
      const [claim] = await queue.claim({ ownerId: ownerA, limit: 1 });
      const afterClaim = await databaseNow();
      expect(claim).toEqual({ outboundMessageId: due.id, userId: due.user_id, ownerId: ownerA,
        leaseGeneration: 1n, leaseUntil: expect.any(Date), attemptCount: 0 });
      expect(claim!.leaseUntil.getTime()).toBeGreaterThanOrEqual(beforeClaim + 60_000);
      expect(claim!.leaseUntil.getTime()).toBeLessThanOrEqual(afterClaim + 60_000);
      expect((await queue.claim({ ownerId: ownerA, limit: 5 })).map((lease) => lease.outboundMessageId)).toEqual([next.id]);
      expect(await queue.claim({ ownerId: ownerB, limit: 5 })).toEqual([]);
      expect((await fixture.postgres.pool.query("SELECT state, lease_generation FROM public.delivery_work WHERE state IN ('sent','uncertain','dead','cancelled') ORDER BY state")).rows)
        .toEqual(['cancelled', 'dead', 'sent', 'uncertain'].map((state) => ({ state, lease_generation: '4' })));
    } finally { hostClock.mockRestore(); }
  });

  test('concurrent claims do not overlap and skip an independently locked row', async () => {
    const locked = await fixture.seed();
    const one = await fixture.seed();
    const two = await fixture.seed();
    const client = await fixture.postgres.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM public.delivery_work WHERE outbound_message_id = $1 FOR UPDATE', [locked.id]);
      const [a, b] = await Promise.all([queue.claim({ ownerId: ownerA, limit: 1 }), queue.claim({ ownerId: ownerB, limit: 1 })]);
      expect(new Set([...a, ...b].map((lease) => lease.outboundMessageId))).toEqual(new Set([one.id, two.id]));
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await queue.claim({ ownerId: ownerA, limit: 1 }))[0]!.outboundMessageId).toBe(locked.id);
  });

  test('reclaim advances generation without resetting attempts or admitting a send', async () => {
    const work = await fixture.seed();
    const [old] = await queue.claim({ ownerId: ownerA, limit: 1 });
    await fixture.postgres.pool.query("UPDATE public.delivery_work SET lease_until = now() - interval '1 hour', attempt_count = 2 WHERE outbound_message_id = $1", [work.id]);
    const [current] = await queue.claim({ ownerId: ownerB, limit: 1 });
    expect(current).toMatchObject({ outboundMessageId: work.id, leaseGeneration: 2n, attemptCount: 2 });
    expect(await queue.renew(old!)).toBeNull();
    expect((await fixture.postgres.pool.query('SELECT * FROM public.delivery_attempts')).rows).toEqual([]);
    expect((await fixture.postgres.pool.query('SELECT status FROM public.outbound_messages')).rows).toEqual([{ status: 'pending' }]);
  });

  test('monotonic renewal retains same-generation authority despite an observational old expiry', async () => {
    await fixture.seed();
    const [lease] = await queue.claim({ ownerId: ownerA, limit: 1 });
    const extended = await queue.renew(lease!, 120_000);
    expect(extended!.getTime()).toBeGreaterThan(lease!.leaseUntil.getTime() + 50_000);
    expect((await queue.renew(lease!, 1))!.getTime()).toBe(extended!.getTime());
    expect(await queue.renew({ ...lease!, ownerId: ownerB })).toBeNull();
    expect(await queue.renew({ ...lease!, leaseGeneration: 0n })).toBeNull();
    expect(await queue.renew({ ...lease!, userId: ownerB })).toBeNull();
    await fixture.postgres.pool.query("UPDATE public.delivery_work SET lease_until = now() - interval '1 hour' WHERE outbound_message_id = $1", [lease!.outboundMessageId]);
    expect(await queue.renew(lease!)).toBeNull();
    expect((await row(lease!.outboundMessageId)).lease_until.getTime()).toBeLessThan(await databaseNow());
  });

  test('checks expiry after waiting for the work lock, without reviving the lease', async () => {
    await fixture.seed();
    const [lease] = await queue.claim({ ownerId: ownerA, limit: 1 });
    const client = await fixture.postgres.pool.connect();
    let renewed: Promise<Date | null> | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM public.delivery_work WHERE outbound_message_id = $1 FOR UPDATE', [lease!.outboundMessageId]);
      renewed = queue.renew(lease!);
      let waiting = false;
      for (let poll = 0; poll < 100 && !waiting; poll++) {
        waiting = (await fixture.postgres.pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE usename = 'echo_delivery' AND wait_event_type = 'Lock'`)).rowCount === 1;
      }
      expect(waiting).toBe(true);
      await client.query("UPDATE public.delivery_work SET lease_until = now() - interval '1 hour' WHERE outbound_message_id = $1", [lease!.outboundMessageId]);
      await client.query('COMMIT');
      expect(await renewed).toBeNull();
    } finally { await client.query('ROLLBACK'); client.release(); await renewed; }
  });

  test('does not expose a claim when its transaction rolls back or acknowledgement is lost', async () => {
    const work = await fixture.seed();
    const rollback = new PostgresDeliveryQueue({ systemTransaction: (role, fn) => fixture.database.systemTransaction(role, async (tx) => {
      await fn(tx); throw new Error('rollback');
    }) });
    await expect(rollback.claim({ ownerId: ownerA, limit: 1 })).rejects.toThrow('rollback');
    expect(await row(work.id)).toMatchObject({ state: 'ready', lease_generation: '0' });
    const lostAck = new PostgresDeliveryQueue({ systemTransaction: async (role, fn) => {
      await fixture.database.systemTransaction(role, fn); throw new Error('ack lost');
    } });
    await expect(lostAck.claim({ ownerId: ownerA, limit: 1 })).rejects.toThrow('ack lost');
    expect(await row(work.id)).toMatchObject({ state: 'leased', lease_generation: '1' });
    expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
  });

  test('rejects invalid claim and renewal inputs without changing work', async () => {
    const work = await fixture.seed();
    for (const change of [{ ownerId: 'bad' }, { ownerId: '00000000-0000-0000-0000-000000000000' },
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { leaseMs: 0 }, { leaseMs: 300_001 }])
      await expect(queue.claim({ ownerId: ownerA, limit: 1, ...change })).rejects.toThrow(RangeError);
    expect(await row(work.id)).toMatchObject({ state: 'ready', lease_generation: '0' });
    const [lease] = await queue.claim({ ownerId: ownerA, limit: 1 });
    for (const change of [{ outboundMessageId: 'bad' }, { userId: 'bad' }, { ownerId: 'bad' },
      { leaseGeneration: -1n }, { leaseGeneration: 9_223_372_036_854_775_808n }])
      await expect(queue.renew({ ...lease!, ...change })).rejects.toThrow(RangeError);
    await expect(queue.renew(lease!, 300_001)).rejects.toThrow(RangeError);
  });
});
