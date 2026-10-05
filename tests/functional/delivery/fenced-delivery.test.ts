import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DeliveryLeaseLostError, PostgresFencedDelivery, type DeliveryDisposition } from '../../../src/infrastructure/postgres/postgres-fenced-delivery.js';
import { PostgresDeliveryQueue } from '../../../src/infrastructure/postgres/postgres-delivery-queue.js';
import type { UserId } from '../../../src/shared/types/identity.js';
import { deliveryFixture, ownerA, ownerB } from '../../support/delivery-fixture.js';

describe('fenced tenant delivery transaction', () => {
  let fixture: Awaited<ReturnType<typeof deliveryFixture>>;
  let fenced: PostgresFencedDelivery;
  let queue: PostgresDeliveryQueue;
  beforeAll(async () => {
    fixture = await deliveryFixture();
    fenced = new PostgresFencedDelivery(fixture.database);
    queue = new PostgresDeliveryQueue(fixture.database);
  }, 120_000);
  beforeEach(async () => { await fixture.postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => { await fixture?.close(); });
  const claim = async () => {
    await fixture.seed();
    return (await queue.claim({ ownerId: ownerA, limit: 1 }))[0]!;
  };
  const keep = async () => ({ value: 'acknowledged', disposition: { state: 'keep' } as const });
  const work = async () => (await fixture.postgres.pool.query('SELECT * FROM public.delivery_work')).rows[0];

  test('reads current tenant context and commits writes together with a retained lease', async () => {
    const lease = await claim();
    const expected = (await fixture.postgres.pool.query('SELECT external_user_id FROM public.channel_accounts')).rows[0];
    expect(await fenced.run(lease, async (tx, context) => {
      expect(context).toEqual({ conversationId: expect.any(String), userStatus: 'active', accountState: 'active',
        conversationState: 'active', recipientAddress: expected.external_user_id, outboundStatus: 'pending', attemptCount: 0 });
      expect(await tx.query('SELECT sequence FROM public.inbound_events')).toEqual([{ sequence: '1' }]);
      await tx.query("UPDATE public.outbound_messages SET status = 'sending'");
      return { value: 'committed', disposition: { state: 'keep', attemptCount: 1 } };
    })).toBe('committed');
    expect(await work()).toMatchObject({ state: 'leased', attempt_count: 1, lease_owner: ownerA, lease_generation: '1' });
  });

  test('releases only through the final fenced disposition and preserves attempt counts', async () => {
    for (const state of ['retry', 'sent', 'uncertain', 'dead', 'cancelled'] as const) {
      const lease = await claim();
      const due = new Date(Date.now() + 60_000);
      await fenced.run(lease, async () => ({ value: null,
        disposition: state === 'retry' ? { state, availableAt: due } : { state } }));
      const row = (await fixture.postgres.pool.query('SELECT * FROM public.delivery_work WHERE outbound_message_id=$1', [lease.outboundMessageId])).rows[0];
      expect(row).toMatchObject({ state, attempt_count: 0, lease_owner: null, lease_until: null });
      if (state === 'retry') expect(row.available_at).toEqual(due);
      await expect(fenced.run(lease, keep)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    }
  });

  test('rejects stale, wrong-tenant and expired authority but accepts same-generation renewal', async () => {
    const lease = await claim();
    const other = await fixture.seed();
    for (const change of [{ ownerId: ownerB }, { leaseGeneration: 0n }, { userId: other.user_id as UserId }])
      await expect(fenced.run({ ...lease, ...change }, keep)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    await queue.renew(lease, 120_000);
    expect(await fenced.run({ ...lease, leaseUntil: new Date(0) }, keep)).toBe('acknowledged');
    await fixture.postgres.pool.query("UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 hour' WHERE outbound_message_id=$1", [lease.outboundMessageId]);
    await expect(fenced.run(lease, keep)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
  });

  test('rolls back callback effects if the final guard finds expiry or a cleared lease', async () => {
    const lease = await claim();
    for (const mutation of ["lease_until=clock_timestamp()-interval '1 hour'", "state='dead',lease_owner=NULL,lease_until=NULL"]) {
      await expect(fenced.run(lease, async (tx) => {
        await tx.query("UPDATE public.outbound_messages SET status='sending'");
        await tx.query(`UPDATE public.delivery_work SET ${mutation}`);
        return keep();
      })).rejects.toBeInstanceOf(DeliveryLeaseLostError);
      expect((await fixture.postgres.pool.query('SELECT status FROM public.outbound_messages')).rows).toEqual([{ status: 'pending' }]);
      expect(await work()).toMatchObject({ state: 'leased', lease_owner: ownerA });
    }
  });

  test('returns no value after rollback or lost COMMIT acknowledgement', async () => {
    const lease = await claim();
    const rollback = new PostgresFencedDelivery({ tenantTransaction: (role, user, fn) => fixture.database.tenantTransaction(role, user, async (tx) => {
      await fn(tx); throw new Error('rollback');
    }) });
    await expect(rollback.run(lease, async () => ({ value: 'hidden', disposition: { state: 'dead' } }))).rejects.toThrow('rollback');
    expect(await work()).toMatchObject({ state: 'leased' });
    const lost = new PostgresFencedDelivery({ tenantTransaction: async (role, user, fn) => {
      await fixture.database.tenantTransaction(role, user, fn); throw new Error('ack lost');
    } });
    await expect(lost.run(lease, async () => ({ value: 'hidden', disposition: { state: 'dead' } }))).rejects.toThrow('ack lost');
    expect(await work()).toMatchObject({ state: 'dead' });
  });

  test('validates closed dispositions before committing callback writes', async () => {
    const lease = await claim();
    for (const disposition of [{ state: 'ready' }, { state: 'keep', attemptCount: 7 }, { state: 'keep', attemptCount: -1 },
      { state: 'keep', attemptCount: 1.5 }, { state: 'retry', availableAt: new Date(NaN) },
      { state: 'retry', availableAt: new Date(-8640000000000000) }]) {
      await expect(fenced.run(lease, async (tx) => {
        await tx.query("UPDATE public.outbound_messages SET status='sending'");
        return { value: null, disposition: disposition as DeliveryDisposition };
      })).rejects.toThrow(RangeError);
    }
    expect((await fixture.postgres.pool.query('SELECT status FROM public.outbound_messages')).rows).toEqual([{ status: 'pending' }]);
  });

  test('does not allow a disposition to reduce the durable attempt count', async () => {
    const lease = await claim();
    await fixture.postgres.pool.query('UPDATE public.delivery_work SET attempt_count=3');
    await expect(fenced.run(lease, async () => ({ value: null, disposition: { state: 'keep', attemptCount: 2 } })))
      .rejects.toThrow(RangeError);
    expect(await work()).toMatchObject({ attempt_count: 3 });
  });

  const lockOrder = ['users', 'channel_accounts', 'conversations', 'outbound_messages', 'delivery_work'];
  test.each(lockOrder)('checks expiry after waiting for %s, without locking later rows first', async (table) => {
    const lease = await claim();
    const blocker = await fixture.postgres.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM public.${table} FOR UPDATE`);
      pending = fenced.run(lease, keep).catch((error: unknown) => error);
      let waiting = false;
      for (let poll = 0; poll < 100 && !waiting; poll++) {
        waiting = (await fixture.postgres.pool.query("SELECT 1 FROM pg_stat_activity WHERE usename='echo_delivery' AND wait_event_type='Lock'")).rowCount === 1;
      }
      expect(waiting).toBe(true);
      for (const later of lockOrder.slice(lockOrder.indexOf(table) + 1))
        await blocker.query(`SELECT 1 FROM public.${later} FOR UPDATE NOWAIT`);
      await blocker.query("UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 hour'");
      await blocker.query('COMMIT');
      expect(await pending).toBeInstanceOf(DeliveryLeaseLostError);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
  });

  test('restricts delivery identity and sequence access to the tenant and required columns', async () => {
    const lease = await claim();
    await fixture.seed();
    await fixture.database.tenantTransaction('delivery', lease.userId, async (tx) => {
      expect(await tx.query('SELECT id FROM public.users')).toEqual([{ id: lease.userId }]);
      expect(await tx.query('SELECT user_id FROM public.channel_accounts')).toEqual([{ user_id: lease.userId }]);
      expect(await tx.query('SELECT user_id FROM public.conversations')).toEqual([{ user_id: lease.userId }]);
      expect(await tx.query('SELECT sequence FROM public.inbound_events')).toEqual([{ sequence: '1' }]);
    });
    for (const sql of ['SELECT id FROM public.users', 'SELECT external_user_id FROM public.channel_accounts',
      'SELECT id FROM public.conversations', 'SELECT sequence FROM public.inbound_events'])
      expect(await fixture.database.systemTransaction('delivery', (tx) => tx.query(sql))).toEqual([]);
    for (const sql of ['SELECT payload FROM public.inbound_events', 'SELECT external_conversation_id FROM public.conversations',
      "UPDATE public.users SET status='deleted'", "UPDATE public.channel_accounts SET state='stopped'", "UPDATE public.conversations SET state='stopped'"])
      await expect(fixture.database.tenantTransaction('delivery', lease.userId, (tx) => tx.query(sql))).rejects.toThrow();
  });
});
