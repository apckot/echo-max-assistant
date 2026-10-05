import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { DeliveryWorker } from '../../../src/modules/delivery/application/delivery-worker.js';
import { PostgresDeliveryAdmission } from '../../../src/infrastructure/postgres/postgres-delivery-admission.js';
import { PostgresDeliveryCompletion } from '../../../src/infrastructure/postgres/postgres-delivery-completion.js';
import { PostgresDeliveryQueue } from '../../../src/infrastructure/postgres/postgres-delivery-queue.js';
import type { SendOutcome } from '../../../src/modules/delivery/application/sender.js';
import { deliveryFixture, ownerA, ownerB } from '../../support/delivery-fixture.js';

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

describe('lifecycle cancellation and delivery races', () => {
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
  const claim = async (owner = ownerA) => (await queue.claim({ ownerId: owner, limit: 1 }))[0]!;
  const rows = async (table: string) => (await f.postgres.pool.query(`SELECT * FROM public.${table}
    ${table === 'delivery_attempts' ? 'ORDER BY attempt_number, phase DESC' : ''}`)).rows;
  const accept = async (key: string, payload: object) => {
    const account = (await rows('channel_accounts'))[0];
    const gateway = await f.pools.gateway.connect();
    try {
      await gateway.query('BEGIN');
      await gateway.query("SET LOCAL statement_timeout='150ms'");
      const result = await gateway.query('SELECT * FROM public.accept_max_inbound($1,$1,$2,$3,$4,$5)',
        [account.external_user_id, key, '2026-10-01T00:00:00Z', JSON.stringify(payload), 'a'.repeat(64)]);
      await gateway.query('COMMIT');
      return result;
    } finally { await gateway.query('ROLLBACK'); gateway.release(); }
  };
  const lifecycle = (kind: 'started' | 'stopped', key = kind) =>
    accept(key, { kind: 'lifecycle', lifecycleType: kind });
  const materialize = async (sourceId: string, index = 0) => {
    const result = await f.postgres.pool.query(`INSERT INTO public.outbound_messages
      (user_id,conversation_id,source_inbound_event_id,message_index,payload,dedupe_key)
      SELECT user_id,conversation_id,id,$2::integer,'{"version":1,"kind":"text","text":"reply"}',
        'response:'||id::text||':'||$2::integer::text||':v1' FROM public.inbound_events WHERE id=$1 RETURNING id,user_id`,
    [sourceId, index]);
    const work = result.rows[0];
    await f.postgres.pool.query('INSERT INTO public.delivery_work(outbound_message_id,user_id) VALUES ($1,$2)',
      [work.id, work.user_id]);
    return work.id as string;
  };
  const makeDue = () => f.postgres.pool.query('UPDATE public.delivery_work SET available_at=clock_timestamp()');
  const sent = { status: 'sent', externalMessageId: 'private-result' } as const;

  test.each(['pending', 'retry'] as const)('stop and restart cannot resurrect future-due %s or block a fresh reply', async (state) => {
    const old = await f.seed();
    const sender = { send: vi.fn().mockResolvedValue({ status: 'not_sent', code: 'rate_limited',
      retryable: true, retryAfterMs: 3_000_000_000 }) };
    const worker = new DeliveryWorker(admission, sender, completion);
    if (state === 'retry') await worker.run(await claim());
    else await f.postgres.pool.query("UPDATE public.delivery_work SET available_at=clock_timestamp()+interval '1 day'");
    await lifecycle('stopped');
    await lifecycle('started');
    expect(await queue.claim({ ownerId: ownerA, limit: 1 })).toEqual([]);
    const event = await accept('fresh', { kind: 'text', text: 'new request' });
    const fresh = await materialize(event.rows[0].inbound_event_id);
    const lease = await claim();
    expect(lease?.outboundMessageId).toBe(fresh);
    sender.send.mockResolvedValue(sent);
    let result = await worker.run(lease);
    if (result.status === 'not_admitted' && result.admission.status === 'deferred') {
      // Await the durable pacing boundary, without modifying the immutable journal.
      await f.postgres.pool.query('SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))',
        [result.admission.availableAt]);
      result = await worker.run(await claim());
    }
    expect(result).toMatchObject({ status: 'completed', completion: { status: 'sent' } });
    await makeDue();
    expect((await worker.run(await claim())).status).toBe('not_admitted');
    const oldWork = (await rows('delivery_work')).find((row) => row.outbound_message_id === old.id);
    expect(oldWork).toMatchObject({ state: 'cancelled', attempt_count: state === 'retry' ? 1 : 0, lease_owner: null });
    expect((await rows('outbound_messages')).find((row) => row.id === old.id)?.status).toBe('cancelled');
    expect(sender.send).toHaveBeenCalledTimes(state === 'retry' ? 2 : 1);
    expect(await rows('delivery_attempts')).toHaveLength(state === 'retry' ? 4 : 2);
  });

  test('pre-stop source materialized only after reactivation remains cancelled', async () => {
    await f.seed();
    const source = (await rows('inbound_events'))[0];
    await f.postgres.pool.query('TRUNCATE public.outbound_messages CASCADE');
    await lifecycle('stopped');
    await lifecycle('started');
    await materialize(source.id);
    const sender = { send: vi.fn().mockResolvedValue(sent) };
    expect(await new DeliveryWorker(admission, sender, completion).run(await claim()))
      .toMatchObject({ status: 'not_admitted', admission: { status: 'cancelled' } });
    expect(sender.send).not.toHaveBeenCalled();
    expect(await rows('delivery_attempts')).toEqual([]);
    expect(await rows('delivery_work')).toMatchObject([{ state: 'cancelled', attempt_count: 0 }]);
  });

  test('duplicate old start cannot reactivate a later stop or lower its cutoff', async () => {
    await f.seed();
    await lifecycle('started', 'original-start');
    await lifecycle('stopped');
    const before = (await rows('conversations'))[0];
    expect(before.delivery_cancelled_through_sequence).toBe('2');
    expect((await lifecycle('started', 'original-start')).rows[0].status).toBe('duplicate');
    expect((await rows('conversations'))[0]).toMatchObject({ state: 'stopped',
      delivery_cancelled_through_sequence: before.delivery_cancelled_through_sequence });
    const sender = { send: vi.fn().mockResolvedValue(sent) };
    await new DeliveryWorker(admission, sender, completion).run(await claim());
    expect(sender.send).not.toHaveBeenCalled();
    expect(await rows('delivery_attempts')).toEqual([]);
  });

  test('captured claim waits behind committing lifecycle stop; concurrent claim cannot bypass it', async () => {
    await f.seed();
    const lease = await claim();
    const gateway = await f.pools.gateway.connect();
    let pending: Promise<unknown> | undefined;
    const sender = { send: vi.fn().mockResolvedValue(sent) };
    try {
      await gateway.query('BEGIN');
      const account = (await rows('channel_accounts'))[0];
      await gateway.query('SELECT * FROM public.accept_max_inbound($1,$1,$2,$3,$4,$5)',
        [account.external_user_id, 'stop-barrier', '2026-10-01T00:00:00Z',
          JSON.stringify({ kind: 'lifecycle', lifecycleType: 'stopped' }), 'a'.repeat(64)]);
      pending = new DeliveryWorker(admission, sender, completion).run(lease);
      let waiting = false;
      for (let poll = 0; poll < 100 && !waiting; poll++) {
        waiting = (await f.postgres.pool.query("SELECT 1 FROM pg_stat_activity WHERE usename='echo_delivery' AND wait_event_type='Lock'")).rowCount === 1;
      }
      expect(waiting).toBe(true);
      expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
      await gateway.query('COMMIT');
      expect(await pending).toMatchObject({ status: 'not_admitted', admission: { status: 'cancelled' } });
      expect(sender.send).not.toHaveBeenCalled();
      expect(await rows('delivery_attempts')).toEqual([]);
      expect(await rows('delivery_work')).toMatchObject([{ state: 'cancelled', attempt_count: 0 }]);
    } finally { await gateway.query('ROLLBACK'); gateway.release(); await pending; }
  });

  const outcomes: SendOutcome[] = [sent,
    { status: 'not_sent', code: 'preconnection_failure', retryable: true },
    { status: 'uncertain', code: 'server_failure' }];
  test.each(outcomes)('admitted $status retains actual certainty after stop and same-generation renewal', async (outcome) => {
    await f.seed();
    const lease = await claim();
    const entered = barrier();
    const finish = barrier();
    const sender = { send: vi.fn(async () => { entered.release(); await finish.reached; return outcome; }) };
    const worker = new DeliveryWorker(admission, sender, completion);
    const pending = worker.run(lease);
    try {
      await entered.reached;
      await lifecycle('stopped'); // Must commit while the sender is still blocked: no network-held DB lock.
      expect(await queue.renew(lease, 120_000)).toBeInstanceOf(Date);
      expect(await worker.run(lease)).toMatchObject({ status: 'not_admitted', admission: { status: 'in_flight' } });
    } finally { finish.release(); await pending.catch(() => undefined); }
    expect(await pending).toMatchObject({ status: 'completed' });
    expect(await rows('delivery_attempts')).toMatchObject([
      { phase: 'started', attempt_number: 1 }, { phase: 'completed', attempt_number: 1, certainty: outcome.status },
    ]);
    if (outcome.status === 'not_sent') {
      await lifecycle('started');
      await makeDue();
      expect(await worker.run(await claim(ownerB)))
        .toMatchObject({ status: 'not_admitted', admission: { status: 'cancelled' } });
    }
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(await rows('outbound_messages')).toMatchObject([{
      status: outcome.status === 'not_sent' ? 'cancelled' : outcome.status }]);
    expect(await rows('delivery_work')).toMatchObject([{ attempt_count: 1,
      state: outcome.status === 'not_sent' ? 'cancelled' : outcome.status }]);
  });

  test('recovery after stop fences a late original completion and preserves uncertainty', async () => {
    await f.seed();
    const original = await claim();
    const started = await admission.admit(original);
    if (started.status !== 'admitted') throw new Error('expected admission');
    await lifecycle('stopped');
    await f.postgres.pool.query("UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 second'");
    const recovered = await claim(ownerB);
    const sender = { send: vi.fn().mockResolvedValue(sent) };
    await new DeliveryWorker(admission, sender, completion).run(recovered);
    await expect(completion.complete(original, started.attempt, sent, { kind: 'terminal' })).rejects.toThrow('Delivery lease lost');
    expect(sender.send).not.toHaveBeenCalled();
    expect(await rows('delivery_attempts')).toMatchObject([
      { phase: 'started', lease_generation: '1' },
      { phase: 'completed', lease_generation: '1', certainty: 'uncertain', code: 'attempt_abandoned' },
    ]);
    expect(await rows('delivery_work')).toMatchObject([{ state: 'uncertain', attempt_count: 1, lease_generation: '2' }]);
  });

  test('an admitted pre-stop predecessor still blocks new work after restart until actual completion', async () => {
    await f.seed();
    const oldLease = await claim();
    const started = await admission.admit(oldLease);
    if (started.status !== 'admitted') throw new Error('expected admission');
    await lifecycle('stopped');
    await lifecycle('started');
    const event = await accept('fresh-after-admission', { kind: 'text', text: 'new request' });
    await materialize(event.rows[0].inbound_event_id);
    // Allow pacing to expire first so only the unresolved predecessor blocks.
    await f.postgres.pool.query(`SELECT pg_sleep(GREATEST(0,
      extract(epoch FROM max(recorded_at)+interval '501 milliseconds'-clock_timestamp())))
      FROM public.delivery_attempts`);
    const sender = { send: vi.fn().mockResolvedValue(sent) };
    const worker = new DeliveryWorker(admission, sender, completion);
    expect(await worker.run(await claim(ownerB)))
      .toMatchObject({ status: 'not_admitted', admission: { status: 'deferred' } });
    expect(sender.send).not.toHaveBeenCalled();
    await completion.complete(oldLease, started.attempt, sent, { kind: 'terminal' });
    await makeDue();
    expect(await worker.run(await claim(ownerB)))
      .toMatchObject({ status: 'completed', completion: { status: 'sent' } });
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(await rows('delivery_attempts')).toHaveLength(4);
  });

  test('cutoff access remains tenant scoped and delivery cannot change it', async () => {
    await f.seed();
    const lease = await claim();
    await lifecycle('stopped');
    await f.seed();
    expect(await f.database.tenantTransaction('delivery', lease.userId, (tx) =>
      tx.query('SELECT delivery_cancelled_through_sequence FROM public.conversations')))
      .toEqual([{ delivery_cancelled_through_sequence: '1' }]);
    expect(await f.database.systemTransaction('delivery', (tx) =>
      tx.query('SELECT delivery_cancelled_through_sequence FROM public.conversations'))).toEqual([]);
    await expect(f.database.tenantTransaction('delivery', lease.userId, (tx) =>
      tx.query('UPDATE public.conversations SET delivery_cancelled_through_sequence=0'))).rejects.toThrow();
  });

  const downgradeTo15 = async () => {
    await f.postgres.pool.query(`DROP TRIGGER IF EXISTS delivery_stop_cutoff ON public.conversations;
      DROP FUNCTION IF EXISTS public.advance_delivery_stop_cutoff();
      ALTER TABLE public.conversations DROP COLUMN IF EXISTS delivery_cancelled_through_sequence;
      DELETE FROM public.schema_migrations WHERE name='0016_delivery_stop_cutoff.sql';
      UPDATE public.system_state SET schema_version=15`);
  };
  const siblingSource = async () => {
    const account = (await rows('channel_accounts'))[0];
    const result = await f.pools.gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',
      [account.external_user_id, '-9001', 'sibling', '2026-10-01T00:00:00Z',
        JSON.stringify({ kind: 'text', text: 'sibling request' }), 'a'.repeat(64)]);
    return result.rows[0].inbound_event_id as string;
  };

  test('runtime account-wide stop advances every sibling cutoff across restart', async () => {
    await f.seed();
    await materialize(await siblingSource());
    await lifecycle('stopped');
    await lifecycle('started');
    expect((await rows('conversations')).map((row) => row.delivery_cancelled_through_sequence)).toEqual(['1', '1']);
    const sender = { send: vi.fn().mockResolvedValue(sent) };
    for (const lease of await queue.claim({ ownerId: ownerA, limit: 2 }))
      expect(await new DeliveryWorker(admission, sender, completion).run(lease))
        .toMatchObject({ status: 'not_admitted', admission: { status: 'cancelled' } });
    expect(sender.send).not.toHaveBeenCalled();
    expect(await rows('delivery_attempts')).toEqual([]);
  });

  test('ambiguous active sibling history rejects migration atomically instead of guessing cancellation', async () => {
    await downgradeTo15();
    try {
      await f.seed();
      await materialize(await siblingSource());
      await lifecycle('stopped');
      await lifecycle('started');
      await expect(runMigrations(f.pools.migrator, fileURLToPath(new URL('../../../migrations', import.meta.url))))
        .rejects.toThrow('Ambiguous historical delivery cancellation');
      expect((await rows('system_state'))[0].schema_version).toBe(15);
      expect(await f.postgres.pool.query("SELECT 1 FROM public.schema_migrations WHERE name='0016_delivery_stop_cutoff.sql'"))
        .toMatchObject({ rowCount: 0 });
      expect((await rows('conversations'))[0]).not.toHaveProperty('delivery_cancelled_through_sequence');
      expect((await rows('outbound_messages')).map((row) => row.status)).toEqual(['pending', 'pending']);
      expect(await rows('delivery_attempts')).toEqual([]);
    } finally {
      await f.postgres.pool.query('TRUNCATE public.users CASCADE');
      await runMigrations(f.pools.migrator, fileURLToPath(new URL('../../../migrations', import.meta.url)));
    }
  });

  test('migration 15 to 16 backfills a historical stop after restart and a currently stopped conversation', async () => {
    await downgradeTo15();
    const old = await f.seed();
    await lifecycle('stopped');
    await lifecycle('started');
    const stopped = await f.seed();
    const account = (await rows('channel_accounts')).find((row) => row.user_id === stopped.user_id);
    await f.pools.gateway.query("SELECT * FROM public.resolve_or_create_max_identity($1,$1,'bot_stopped')",
      [account.external_user_id]);
    await runMigrations(f.pools.migrator, fileURLToPath(new URL('../../../migrations', import.meta.url)));
    const conversations = await rows('conversations');
    expect(conversations.find((row) => row.user_id === old.user_id))
      .toMatchObject({ state: 'active', delivery_cancelled_through_sequence: '1' });
    expect(conversations.find((row) => row.user_id === stopped.user_id))
      .toMatchObject({ state: 'stopped', delivery_cancelled_through_sequence: '1' });
    expect((await rows('system_state'))[0].schema_version).toBe(16);
    const sender = { send: vi.fn().mockResolvedValue(sent) };
    for (const lease of await queue.claim({ ownerId: ownerA, limit: 2 }))
      expect(await new DeliveryWorker(admission, sender, completion).run(lease))
        .toMatchObject({ status: 'not_admitted', admission: { status: 'cancelled' } });
    expect(sender.send).not.toHaveBeenCalled();
    expect(await rows('delivery_attempts')).toEqual([]);
  });
});
