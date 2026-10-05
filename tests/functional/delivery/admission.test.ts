import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { PostgresDeliveryAdmission } from '../../../src/infrastructure/postgres/postgres-delivery-admission.js';
import { PostgresDeliveryQueue } from '../../../src/infrastructure/postgres/postgres-delivery-queue.js';
import { DeliveryLeaseLostError } from '../../../src/infrastructure/postgres/postgres-fenced-delivery.js';
import type { Database, DbTx } from '../../../src/infrastructure/postgres/database.js';
import type { UserId } from '../../../src/shared/types/identity.js';
import { deliveryFixture, ownerA, ownerB } from '../../support/delivery-fixture.js';

describe('durable delivery admission', () => {
  let f: Awaited<ReturnType<typeof deliveryFixture>>;
  let queue: PostgresDeliveryQueue;
  let admission: PostgresDeliveryAdmission;
  beforeAll(async () => {
    f = await deliveryFixture();
    queue = new PostgresDeliveryQueue(f.database);
    admission = new PostgresDeliveryAdmission(f.database);
  }, 120_000);
  beforeEach(async () => { await f.postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => { await f?.close(); });
  const claim = async () => { await f.seed(); return (await queue.claim({ ownerId: ownerA, limit: 1 }))[0]!; };
  const rows = async (table: string) => (await f.postgres.pool.query(`SELECT * FROM public.${table}
    ${table === 'delivery_attempts' ? 'ORDER BY attempt_number, phase DESC' : ''}`)).rows;
  const expire = async () => { await f.postgres.pool.query("UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 hour'"); };
  const wrap = (transform: (tx: DbTx) => DbTx): Pick<Database, 'tenantTransaction'> => ({
    tenantTransaction: (role, user, fn) => f.database.tenantTransaction(role, user, (tx) => fn(transform(tx))),
  });

  test('concurrent and repeated same-generation calls authorize once and preserve the live start', async () => {
    const lease = await claim();
    const original = await rows('outbound_messages');
    const results = await Promise.all([admission.admit(lease), admission.admit(lease)]);
    expect(results.map((r) => r.status).sort()).toEqual(['admitted', 'in_flight']);
    expect(results.find((r) => r.status === 'admitted')).toEqual({ status: 'admitted',
      recipientAddress: (await rows('channel_accounts'))[0].external_user_id,
      message: { version: 1, kind: 'text', text: 'private output' },
      attempt: { outboundMessageId: lease.outboundMessageId, userId: lease.userId, ownerId: ownerA, leaseGeneration: 1n, attemptNumber: 1 } });
    await f.postgres.pool.query("UPDATE public.channel_accounts SET state='stopped'");
    expect(await admission.admit(lease)).toEqual({ status: 'in_flight' });
    expect(await rows('delivery_attempts')).toMatchObject([{ phase: 'started', attempt_number: 1, lease_owner: ownerA, lease_generation: '1' }]);
    expect(await rows('delivery_work')).toMatchObject([{ state: 'leased', attempt_count: 1 }]);
    expect(await rows('outbound_messages')).toMatchObject([{ ...original[0], status: 'sending', updated_at: expect.any(Date) }]);
    // Repeated admission must leave the original proof usable for actual certainty (B3).
    await f.database.tenantTransaction('delivery', lease.userId, (tx) => tx.query(`INSERT INTO public.delivery_attempts
      (outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,certainty,external_message_id)
      VALUES ($1,$2,1,'completed',$3,1,'sent','confirmed')`, [lease.outboundMessageId,lease.userId,ownerA]));
    expect(await rows('delivery_attempts')).toHaveLength(2);
  });

  test('renewal keeps authority, expired tokens cannot admit, and a pre-admission reclaim can start', async () => {
    const lease = await claim();
    await queue.renew(lease, 120_000);
    expect((await admission.admit({ ...lease, leaseUntil: new Date(0) })).status).toBe('admitted');
    await f.postgres.pool.query('TRUNCATE public.users CASCADE');
    const abandonedClaim = await claim();
    await expire();
    await expect(admission.admit(abandonedClaim)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    expect(await rows('delivery_attempts')).toEqual([]);
    const reclaimed = (await queue.claim({ ownerId: ownerB, limit: 1 }))[0]!;
    await expect(admission.admit(abandonedClaim)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    expect(await admission.admit(reclaimed)).toMatchObject({ status: 'admitted', attempt: { ownerId: ownerB, leaseGeneration: 2n, attemptNumber: 1 } });
  });

  test('recovery appends uncertain using the original token and cannot resurrect terminal work', async () => {
    const lease = await claim();
    await admission.admit(lease);
    await expire();
    const recovery = (await queue.claim({ ownerId: ownerB, limit: 1 }))[0]!;
    expect(await admission.admit(recovery)).toEqual({ status: 'uncertain' });
    expect(await rows('delivery_attempts')).toMatchObject([
      { phase: 'started', attempt_number: 1, lease_owner: ownerA, lease_generation: '1' },
      { phase: 'completed', attempt_number: 1, lease_owner: ownerA, lease_generation: '1', certainty: 'uncertain', code: 'attempt_abandoned' },
    ]);
    expect(await rows('delivery_work')).toMatchObject([{ state: 'uncertain', attempt_count: 1, lease_owner: null }]);
    expect(await rows('outbound_messages')).toMatchObject([{ status: 'uncertain' }]);
    expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
    await expect(admission.admit(lease)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
  });

  test.each(['rollback', 'ack lost'])('returns no authorization after %s', async (fault) => {
    const lease = await claim();
    const faulty = new PostgresDeliveryAdmission({ tenantTransaction: async (role, user, fn) => {
      await f.database.tenantTransaction(role, user, async (tx) => {
        await fn(tx);
        if (fault === 'rollback') throw new Error(fault);
      });
      throw new Error(fault);
    } });
    await expect(faulty.admit(lease)).rejects.toThrow(fault);
    expect((await rows('delivery_attempts')).length).toBe(fault === 'rollback' ? 0 : 1);
    expect((await rows('delivery_work'))[0].attempt_count).toBe(fault === 'rollback' ? 0 : 1);
    expect((await admission.admit(lease)).status).toBe(fault === 'rollback' ? 'admitted' : 'in_flight');
  });

  test.each(['expiry', 'reclaim'])('final expiry rolls back admission; lock-wait %s prevents entry', async (change) => {
    const lease = await claim();
    const faulty = new PostgresDeliveryAdmission(wrap((tx) => ({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (sql.includes('INSERT INTO public.delivery_attempts'))
        await tx.query("UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 hour'");
      return result;
    } })));
    await expect(faulty.admit(lease)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    expect(await rows('delivery_attempts')).toEqual([]);
    const blocker = await f.postgres.pool.connect();
    let pending: Promise<unknown> | undefined;
    let entered = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM public.conversations FOR UPDATE');
      const observed = new PostgresDeliveryAdmission(wrap((tx) => ({ query: async (sql, params) => {
        if (sql.includes('public.delivery_attempts')) entered = true;
        return tx.query(sql, params);
      } })));
      pending = observed.admit(lease).catch((e: unknown) => e);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++)
        waiting = (await f.postgres.pool.query("SELECT 1 FROM pg_stat_activity WHERE usename='echo_delivery' AND wait_event_type='Lock'")).rowCount === 1;
      expect(waiting).toBe(true);
      await blocker.query(change === 'expiry'
        ? "UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 hour'"
        : 'UPDATE public.delivery_work SET lease_generation=lease_generation+1');
      await blocker.query('COMMIT');
      expect(await pending).toBeInstanceOf(DeliveryLeaseLostError);
      expect(entered).toBe(false);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
  });

  test('denies cross-tenant authority and cancels inactive identities before any start', async () => {
    const lease = await claim();
    const other = await f.seed();
    await expect(admission.admit({ ...lease, userId: other.user_id as UserId })).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    await f.postgres.pool.query("UPDATE public.channel_accounts SET state='stopped' WHERE user_id=$1", [lease.userId]);
    expect(await admission.admit(lease)).toEqual({ status: 'cancelled' });
    expect(await rows('delivery_attempts')).toEqual([]);
  });

  test.each(['ordinal', 'source'])('defers behind a nonterminal %s predecessor using database time', async (order) => {
    const first = await claim();
    if (order === 'source') await f.postgres.pool.query(`INSERT INTO public.inbound_events
      (user_id,conversation_id,provider,provider_event_key,sequence,kind,occurred_at,timezone_snapshot,payload,raw_sha256)
      SELECT user_id,conversation_id,provider,'later',2,kind,occurred_at,timezone_snapshot,payload,raw_sha256 FROM public.inbound_events`);
    const later = (await f.postgres.pool.query(`INSERT INTO public.outbound_messages
      (user_id,conversation_id,source_inbound_event_id,message_index,payload,dedupe_key)
      SELECT i.user_id,i.conversation_id,i.id,$1::integer,o.payload,'response:'||i.id::text||':'||($1::integer)::text||':v1'
      FROM public.inbound_events i JOIN public.outbound_messages o ON o.conversation_id=i.conversation_id
      WHERE i.sequence=$2 RETURNING id,user_id`, [order === 'source' ? 0 : 1, order === 'source' ? 2 : 1])).rows[0];
    await f.postgres.pool.query('INSERT INTO public.delivery_work (outbound_message_id,user_id) VALUES ($1,$2)', [later.id,later.user_id]);
    for (const state of ['pending', 'sending', 'retry', 'dead']) {
      await f.postgres.pool.query('UPDATE public.outbound_messages SET status=$1 WHERE id=$2', [state,first.outboundMessageId]);
      await f.postgres.pool.query("UPDATE public.delivery_work SET available_at=clock_timestamp() WHERE outbound_message_id=$1", [later.id]);
      const lease = (await queue.claim({ ownerId: ownerB, limit: 1 }))[0]!;
      const before = (await f.postgres.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      const skew = vi.spyOn(Date, 'now').mockReturnValue(0);
      let result;
      try { result = await admission.admit(lease); } finally { skew.mockRestore(); }
      expect(result.status).toBe(state === 'dead' ? 'admitted' : 'deferred');
      if (result.status === 'deferred') {
        expect(result.availableAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 500);
        expect((await rows('delivery_work')).find((r) => r.outbound_message_id === later.id))
          .toMatchObject({ state: 'retry', attempt_count: 0, available_at: result.availableAt });
        expect(await rows('delivery_attempts')).toEqual([]);
      }
    }
  });

  test.each([1, 6])('only proven not_sent history permits retry, bounded at %i existing attempts', async (count) => {
    const lease = await claim();
    await f.postgres.pool.query(`INSERT INTO public.delivery_attempts
      (outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,certainty,code)
      SELECT $1,$2,n,phase,$3,1,CASE WHEN phase='completed' THEN 'not_sent' END,
        CASE WHEN phase='completed' THEN 'rate_limited' END
      FROM generate_series(1,$4::int) n CROSS JOIN (VALUES ('started'),('completed')) p(phase)`,
    [lease.outboundMessageId,lease.userId,ownerA,count]);
    await f.postgres.pool.query("UPDATE public.outbound_messages SET status='retry'");
    await f.postgres.pool.query('UPDATE public.delivery_work SET attempt_count=$1', [count]);
    const frozenClock = new PostgresDeliveryAdmission(wrap((tx) => ({ query: (sql, params) =>
      tx.query(sql.includes('AS next_start')
        ? sql.replace('clock_timestamp()', '(SELECT max(recorded_at) FROM public.delivery_attempts)') : sql, params) })));
    const result = await frozenClock.admit(lease);
    expect(result.status).toBe(count === 6 ? 'exhausted' : 'deferred');
    if (count === 1) {
      await f.postgres.pool.query("UPDATE public.delivery_work SET available_at=clock_timestamp()");
      // Move the store's database clock observation forward without changing immutable journal facts.
      const laterClock = new PostgresDeliveryAdmission(wrap((tx) => ({ query: (sql, params) =>
        tx.query(sql.replaceAll('clock_timestamp()', "(clock_timestamp()+interval '1 second')"), params) })));
      const retry = (await queue.claim({ ownerId: ownerB, limit: 1 }))[0]!;
      expect(await laterClock.admit(retry)).toMatchObject({ status: 'admitted', attempt: { attemptNumber: 2 } });
    }
    expect((await rows('delivery_work'))[0].attempt_count).toBe(count === 6 ? 6 : 2);
  });

  test('rejects inconsistent sending state and invalid persisted drafts with safe diagnostics', async () => {
    const lease = await claim();
    await f.postgres.pool.query("UPDATE public.outbound_messages SET status='sending'");
    await expect(admission.admit(lease)).rejects.toThrow('Delivery admission state invalid');
    await f.postgres.pool.query('ALTER TABLE public.outbound_messages DROP CONSTRAINT outbound_messages_payload_check');
    await f.postgres.pool.query(`UPDATE public.outbound_messages SET status='pending', payload='{"version":1,"kind":"text","text":"private output","extra":true}'`);
    await expect(admission.admit(lease)).rejects.toThrow('Delivery admission state invalid');
    expect(await rows('delivery_attempts')).toEqual([]);
    await f.postgres.pool.query('ALTER TABLE public.outbound_messages ADD CONSTRAINT outbound_messages_payload_check CHECK (public.valid_outbound_payload(payload)) NOT VALID');
  });
});
