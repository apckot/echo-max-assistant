import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { UserId } from '../../../src/shared/types/identity.js';
import { deliveryFixture, ownerA, ownerB } from '../../support/delivery-fixture.js';

describe('immutable tenant delivery attempt journal', () => {
  let fixture: Awaited<ReturnType<typeof deliveryFixture>>;
  beforeAll(async () => { fixture = await deliveryFixture(); }, 120_000);
  beforeEach(async () => { await fixture.postgres.pool.query('TRUNCATE public.users CASCADE'); });
  afterAll(async () => { await fixture?.close(); });
  const insert = (work: { id: string; user_id: string }, phase = 'started', certainty: string | null = null,
    code: string | null = null, owner = ownerA, attempt = 1, external: string | null = null) =>
    fixture.postgres.pool.query(`INSERT INTO public.delivery_attempts
      (outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,certainty,code,external_message_id)
      VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8)`, [work.id, work.user_id, attempt, phase, owner, certainty, code, external]);

  test('stores distinct start and completion facts with one row per phase', async () => {
    const work = await fixture.seed();
    await insert(work);
    await insert(work, 'completed', 'sent', null, ownerA, 1, 'private-provider-id');
    const rows = (await fixture.postgres.pool.query('SELECT phase,certainty,external_message_id,recorded_at FROM public.delivery_attempts ORDER BY phase')).rows;
    expect(rows).toEqual([
      { phase: 'completed', certainty: 'sent', external_message_id: 'private-provider-id', recorded_at: expect.any(Date) },
      { phase: 'started', certainty: null, external_message_id: null, recorded_at: expect.any(Date) },
    ]);
    await expect(insert(work)).rejects.toMatchObject({ code: '23505' });
    await expect(insert(work, 'completed', 'uncertain', 'attempt_abandoned')).rejects.toMatchObject({ code: '23505' });
  });

  test('requires a matching start and tenant ownership for completion', async () => {
    const work = await fixture.seed();
    const other = await fixture.seed();
    await expect(insert(work, 'completed', 'uncertain', 'attempt_abandoned')).rejects.toMatchObject({ code: '23503' });
    await expect(insert({ ...work, user_id: other.user_id })).rejects.toMatchObject({ code: '23503' });
    await insert(work);
    await expect(insert(work, 'completed', 'uncertain', 'attempt_abandoned', ownerB)).rejects.toMatchObject({ code: '23503' });
    await insert(work, 'completed', 'uncertain', 'attempt_abandoned');
  });

  test('rejects unbounded attempts, free text codes, and inconsistent certainty shapes', async () => {
    const work = await fixture.seed();
    for (const attempt of [0, 7]) await expect(insert(work, 'started', null, null, ownerA, attempt)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(work, 'started', 'sent')).rejects.toMatchObject({ code: '23514' });
    await insert(work);
    for (const [certainty, code, external] of [
      ['not_sent', 'private text', null], ['uncertain', 'rate_limited', null],
      ['sent', null, null], ['not_sent', 'rejected', 'provider-id'], ['uncertain', null, null],
    ]) await expect(insert(work, 'completed', certainty, code, ownerA, 1, external)).rejects.toMatchObject({ code: '23514' });
    await insert(work, 'completed', 'not_sent', 'rate_limited');
  });

  test('enforces FORCE RLS and delivery insert/select scope using actual role credentials', async () => {
    const work = await fixture.seed();
    const other = await fixture.seed();
    await fixture.database.tenantTransaction('delivery', work.user_id as UserId, (tx) => tx.query(`INSERT INTO public.delivery_attempts
      (outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation) VALUES ($1,$2,1,'started',$3,1)`, [work.id, work.user_id, ownerA]));
    expect(await fixture.database.systemTransaction('delivery', (tx) => tx.query('SELECT * FROM public.delivery_attempts'))).toEqual([]);
    expect(await fixture.database.tenantTransaction('delivery', other.user_id as UserId, (tx) => tx.query('SELECT * FROM public.delivery_attempts'))).toEqual([]);
    expect(await fixture.database.tenantTransaction('delivery', work.user_id as UserId, (tx) => tx.query('SELECT phase FROM public.delivery_attempts'))).toEqual([{ phase: 'started' }]);
    await expect(fixture.database.tenantTransaction('delivery', other.user_id as UserId, (tx) => tx.query(`INSERT INTO public.delivery_attempts
      (outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation) VALUES ($1,$2,2,'started',$3,1)`, [work.id, work.user_id, ownerA]))).rejects.toThrow();
    expect((await fixture.postgres.pool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid = 'public.delivery_attempts'::regclass")).rows[0])
      .toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  test('denies journal rewriting and other runtime roles access', async () => {
    const work = await fixture.seed();
    await insert(work);
    for (const sql of ['UPDATE public.delivery_attempts SET attempt_number = 2', 'DELETE FROM public.delivery_attempts', 'TRUNCATE public.delivery_attempts'])
      await expect(fixture.pools.delivery.query(sql)).rejects.toMatchObject({ code: '42501' });
    for (const role of ['gateway', 'worker', 'scheduler'] as const)
      await expect(fixture.pools[role].query('SELECT * FROM public.delivery_attempts')).rejects.toMatchObject({ code: '42501' });
    await expect(fixture.pools.migrator.query('DELETE FROM public.delivery_attempts')).rejects.toMatchObject({ code: '55000' });
    await expect(fixture.pools.migrator.query('UPDATE public.delivery_attempts SET attempt_number = 2')).rejects.toMatchObject({ code: '55000' });
  });
});
