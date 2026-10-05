import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { PostgresDeliveryAdmission } from '../../../src/infrastructure/postgres/postgres-delivery-admission.js';
import { PostgresDeliveryCompletion } from '../../../src/infrastructure/postgres/postgres-delivery-completion.js';
import { PostgresDeliveryQueue } from '../../../src/infrastructure/postgres/postgres-delivery-queue.js';
import { DeliveryLeaseLostError } from '../../../src/infrastructure/postgres/postgres-fenced-delivery.js';
import type { Database, DbTx } from '../../../src/infrastructure/postgres/database.js';
import type { DeliveryOutcome } from '../../../src/modules/delivery/application/delivery-completion.js';
import { deliveryFixture, ownerA, ownerB } from '../../support/delivery-fixture.js';

const terminal = { kind: 'terminal' } as const;
const retry = { kind: 'retry', delayMs: 1_000 } as const;
const limited = { status: 'not_sent', code: 'rate_limited', retryable: true } as const;
const sent = { status: 'sent', externalMessageId: 'private-success-id' } as const;
describe('durable actual completion', () => {
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
  const start = async () => {
    await f.seed();
    const lease = (await queue.claim({ ownerId: ownerA, limit: 1 }))[0]!;
    const admitted = await admission.admit(lease);
    if (admitted.status !== 'admitted') throw new Error('Fixture admission failed');
    return { lease, attempt: admitted.attempt };
  };
  const rows = async (table: string) => (await f.postgres.pool.query(`SELECT * FROM public.${table}
    ${table === 'delivery_attempts' ? 'ORDER BY attempt_number, phase DESC' : ''}`)).rows;
  const expire = () => f.postgres.pool.query("UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 hour'");
  const wrap = (transform: (tx: DbTx) => DbTx): Pick<Database, 'tenantTransaction'> => ({
    tenantTransaction: (role, user, fn) => f.database.tenantTransaction(role, user, (tx) => fn(transform(tx))),
  });

  test.each<DeliveryOutcome>([sent, { status: 'uncertain', code: 'timeout' },
    { status: 'uncertain', code: 'sender_exception' }, { status: 'not_sent', code: 'rejected', retryable: false }])
  ('persists actual $status/$code atomically and never retries terminal certainty', async (outcome) => {
    const { lease, attempt } = await start();
    const original = (await rows('delivery_attempts'))[0];
    // Even an erroneous later policy cannot retry sent, uncertain, or permanent failure.
    expect(await completion.complete(lease, attempt, outcome, retry)).toEqual({ status: outcome.status });
    const facts = await rows('delivery_attempts');
    expect(facts).toEqual([original, expect.objectContaining({ phase: 'completed', attempt_number: 1,
      lease_owner: ownerA, lease_generation: '1', certainty: outcome.status,
      code: outcome.status === 'sent' ? null : outcome.code,
      external_message_id: outcome.status === 'sent' ? 'private-success-id' : null })]);
    expect(await rows('outbound_messages')).toMatchObject([{ status: outcome.status }]);
    const work = (await rows('delivery_work'))[0];
    expect(work).toMatchObject({ state: outcome.status === 'not_sent' ? 'dead' : outcome.status,
      lease_owner: null, lease_until: null, attempt_count: 1,
      last_error_code: outcome.status === 'sent' ? null : outcome.code });
    expect(JSON.stringify(work)).not.toMatch(/private-success-id|private output/);
    await expect(completion.complete(lease, attempt, outcome, terminal)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    expect(await rows('delivery_attempts')).toEqual(facts);
    expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
  });

  test.each([0, 4_000_000_000_000])('uses database time under host skew %i and preserves a full multi-week minimum', async (hostNow) => {
    const { lease, attempt } = await start();
    const before = (await f.postgres.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    const skew = vi.spyOn(Date, 'now').mockReturnValue(hostNow);
    let result;
    try { result = await completion.complete(lease, attempt, { ...limited, retryAfterMs: 3_000_000_000 }, retry); }
    finally { skew.mockRestore(); }
    expect(result.status).toBe('retry');
    if (result.status !== 'retry') throw new Error('Retry missing');
    const after = (await f.postgres.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    expect(result.availableAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 3_000_000_000);
    expect(result.availableAt.getTime()).toBeLessThanOrEqual(after.getTime() + 3_000_000_001);
    expect(await rows('delivery_work')).toMatchObject([{ state: 'retry', available_at: result.availableAt, attempt_count: 1 }]);
    expect(await rows('delivery_attempts')).toMatchObject([{}, { certainty: 'not_sent', code: 'rate_limited' }]);
    expect(await rows('outbound_messages')).toMatchObject([{ status: 'retry' }]);
    expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
  });

  test.each([{ delayMs: 0, minimum: 0, expected: '2026-10-05T00:00:00.001Z' },
    { delayMs: 2_000, minimum: 1_000, expected: '2026-10-05T00:00:02.001Z' }])
  ('rounds database fractional milliseconds upward with delay $delayMs', async ({ delayMs, minimum, expected }) => {
    const { lease, attempt } = await start();
    const clocked = new PostgresDeliveryCompletion(wrap((tx) => ({ query: (sql, params) =>
      tx.query(sql.includes('AS epoch_ms')
        ? sql.replace('clock_timestamp()', "timestamptz '2026-10-05 00:00:00.000123+00'") : sql, params) })));
    const result = await clocked.complete(lease, attempt, { ...limited, retryAfterMs: minimum }, { kind: 'retry', delayMs });
    expect(result).toEqual({ status: 'retry', availableAt: new Date(expected) });
    expect(await rows('delivery_work')).toMatchObject([{ available_at: new Date(expected) }]);
  });

  test.each([NaN, Infinity, -1, 0.5, 8_640_000_000_000_000])
  ('never substitutes fallback for an invalid or unrepresentable supplied minimum %s', async (retryAfterMs) => {
    const { lease, attempt } = await start();
    expect(await completion.complete(lease, attempt, { ...limited, retryAfterMs }, retry)).toEqual({ status: 'dead' });
    expect(await rows('delivery_work')).toMatchObject([{ state: 'dead', last_error_code: 'retry_delay_unschedulable' }]);
    expect(await rows('delivery_attempts')).toMatchObject([{}, { certainty: 'not_sent', code: 'rate_limited' }]);
  });

  test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_000])
  ('finalizes an unrepresentable delay %s without changing actual certainty', async (delayMs) => {
    const { lease, attempt } = await start();
    expect(await completion.complete(lease, attempt, limited, { kind: 'retry', delayMs })).toEqual({ status: 'dead' });
    expect(await rows('delivery_work')).toMatchObject([{ state: 'dead', last_error_code: 'retry_delay_unschedulable' }]);
    expect(await rows('outbound_messages')).toMatchObject([{ status: 'dead' }]);
    expect(await rows('delivery_attempts')).toMatchObject([{}, { certainty: 'not_sent', code: 'rate_limited' }]);
  });

  test('never falls back from a valid unschedulable rate restriction', async () => {
    const { lease, attempt } = await start();
    expect(await completion.complete(lease, attempt,
      { status: 'not_sent', code: 'rate_limit_unschedulable', retryable: false }, retry)).toEqual({ status: 'not_sent' });
    expect(await rows('delivery_work')).toMatchObject([{ state: 'dead', last_error_code: 'rate_limit_unschedulable' }]);
    expect(await rows('delivery_attempts')).toMatchObject([{}, { certainty: 'not_sent', code: 'rate_limit_unschedulable' }]);
  });

  test.each([terminal, retry])('exhausts six attempts with $kind scheduling, retaining actual not_sent', async (scheduling) => {
    const { lease, attempt } = await start();
    await completion.complete(lease, attempt, limited, retry);
    await f.postgres.pool.query(`INSERT INTO public.delivery_attempts
      (outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,certainty,code)
      SELECT $1,$2,n,phase,$3,1,CASE WHEN phase='completed' THEN 'not_sent' END,
        CASE WHEN phase='completed' THEN 'rate_limited' END
      FROM generate_series(2,5) n CROSS JOIN (VALUES ('started'),('completed')) p(phase)`,
    [lease.outboundMessageId, lease.userId, ownerA]);
    await f.postgres.pool.query('UPDATE public.delivery_work SET attempt_count=5,available_at=clock_timestamp()');
    const next = (await queue.claim({ ownerId: ownerB, limit: 1 }))[0]!;
    const later = new PostgresDeliveryAdmission(wrap((tx) => ({ query: (sql, params) =>
      tx.query(sql.replaceAll('clock_timestamp()', "(clock_timestamp()+interval '1 second')"), params) })));
    const admitted = await later.admit(next);
    if (admitted.status !== 'admitted') throw new Error('Sixth admission missing');
    expect(await completion.complete(next, admitted.attempt, limited, scheduling)).toEqual({ status: 'dead' });
    expect(await rows('delivery_work')).toMatchObject([{ state: 'dead', attempt_count: 6, last_error_code: 'attempt_budget_exhausted' }]);
    expect((await rows('delivery_attempts')).at(-1)).toMatchObject({ attempt_number: 6, certainty: 'not_sent', code: 'rate_limited' });
  });

  test.each([{ fault: 'rollback', outcome: sent, state: 'sent' }, { fault: 'ack lost', outcome: sent, state: 'sent' },
    { fault: 'ack lost', outcome: limited, state: 'retry' }])
  ('keeps atomic durable $state state after $fault', async ({ fault, outcome, state }) => {
    const { lease, attempt } = await start();
    const faulty = new PostgresDeliveryCompletion({ tenantTransaction: async (role, user, fn) => {
      await f.database.tenantTransaction(role, user, async (tx) => {
        await fn(tx);
        if (fault === 'rollback') throw new Error(fault);
      });
      throw new Error(fault);
    } });
    await expect(faulty.complete(lease, attempt, outcome, retry)).rejects.toThrow(fault);
    expect(await rows('delivery_attempts')).toHaveLength(fault === 'rollback' ? 1 : 2);
    expect(await rows('delivery_work')).toMatchObject([{ state: fault === 'rollback' ? 'leased' : state }]);
    expect(await rows('outbound_messages')).toMatchObject([{ status: fault === 'rollback' ? 'sending' : state }]);
    if (fault === 'rollback') expect(await completion.complete(lease, attempt, sent, terminal)).toEqual({ status: 'sent' });
    else await expect(completion.complete(lease, attempt, limited, retry)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    expect(await rows('delivery_attempts')).toHaveLength(2);
    expect(await queue.claim({ ownerId: ownerB, limit: 1 })).toEqual([]);
  });

  test('rejects wrong proof and expired authority, preserving recovered uncertainty', async () => {
    const { lease, attempt } = await start();
    for (const wrong of [{ ...attempt, attemptNumber: 2 }, { ...attempt, ownerId: ownerB },
      { ...attempt, leaseGeneration: 2n }, { ...attempt, outboundMessageId: ownerB }, { ...attempt, userId: ownerB }])
      await expect(completion.complete(lease, wrong, sent, terminal)).rejects.toThrow('Delivery completion state invalid');
    expect(await rows('delivery_attempts')).toHaveLength(1);
    await expire();
    await expect(completion.complete(lease, attempt, sent, terminal)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    const next = (await queue.claim({ ownerId: ownerB, limit: 1 }))[0]!;
    await expect(completion.complete(next, { ...attempt, ownerId: ownerB, leaseGeneration: next.leaseGeneration }, sent, terminal))
      .rejects.toThrow('Delivery completion state invalid');
    expect(await rows('delivery_work')).toMatchObject([{ state: 'leased', lease_owner: ownerB, lease_generation: '2' }]);
    await admission.admit(next);
    const facts = await rows('delivery_attempts');
    await expect(completion.complete(lease, attempt, sent, terminal)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    expect(await rows('delivery_attempts')).toEqual(facts);
    expect(await rows('outbound_messages')).toMatchObject([{ status: 'uncertain' }]);
  });

  test('renewal and subsequent identity stop preserve an admitted actual completion', async () => {
    const { lease, attempt } = await start();
    await queue.renew(lease, 120_000);
    await f.postgres.pool.query("UPDATE public.channel_accounts SET state='stopped'");
    expect(await completion.complete({ ...lease, leaseUntil: new Date(0), attemptCount: 0 }, attempt, sent, terminal))
      .toEqual({ status: 'sent' });
  });

  test('rejects unadmitted state and nonclosed outcome codes without raw diagnostics', async () => {
    const { lease, attempt } = await start();
    const before = await rows('delivery_work');
    await expect(completion.complete(lease, attempt,
      { status: 'uncertain', code: 'private provider text' } as unknown as DeliveryOutcome, terminal))
      .rejects.toThrow('Delivery completion state invalid');
    await f.postgres.pool.query("UPDATE public.outbound_messages SET status='pending'");
    await expect(completion.complete(lease, attempt, sent, terminal)).rejects.toThrow('Delivery completion state invalid');
    expect(await rows('delivery_attempts')).toHaveLength(1);
    expect(await rows('delivery_work')).toEqual(before);
  });

  test('final expiry rolls back journal, status and technical error writes', async () => {
    const { lease, attempt } = await start();
    const before = await rows('delivery_work');
    const faulty = new PostgresDeliveryCompletion(wrap((tx) => ({ query: async (sql, params) => {
      const result = await tx.query(sql, params);
      if (sql.includes('INSERT INTO public.delivery_attempts'))
        await tx.query("UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 hour'");
      return result;
    } })));
    await expect(faulty.complete(lease, attempt, limited, retry)).rejects.toBeInstanceOf(DeliveryLeaseLostError);
    expect(await rows('delivery_attempts')).toHaveLength(1);
    expect(await rows('outbound_messages')).toMatchObject([{ status: 'sending' }]);
    expect(await rows('delivery_work')).toEqual(before);
  });
});
