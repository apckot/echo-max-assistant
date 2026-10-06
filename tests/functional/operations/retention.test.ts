import { afterAll,beforeAll,expect,test } from 'vitest';
import { createDatabase } from '../../../src/infrastructure/postgres/database.js';
import { RetentionService } from '../../../src/modules/operations/application/retention-service.js';
import { PostgresRetentionStore } from '../../../src/infrastructure/postgres/postgres-retention-store.js';
import { deliveryFixture,ownerA } from '../../support/delivery-fixture.js';
let f:Awaited<ReturnType<typeof deliveryFixture>>;
let db:ReturnType<typeof createDatabase>;
beforeAll(async()=>{f=await deliveryFixture();db=createDatabase({scheduler:f.pools.scheduler.options.connectionString!});},120_000);
afterAll(async()=>{await db?.close();await f?.close();});
test('bounded technical retention uses incident closure and completed attempt age; active and stopped content survives',async()=>{
  expect((await f.postgres.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='delivery_work' AND column_name='incident_closed_at'")).rowCount).toBe(1);
  const old=await f.seed();const boundary=await f.seed();const open=await f.seed();
  const now=new Date('2026-10-01T00:00:00Z');
  for(const [row,closure] of [[old,'2026-08-31'],[boundary,'2026-09-01'],[open,null]] as const){
    await f.postgres.pool.query(`UPDATE public.delivery_work SET state='dead' WHERE outbound_message_id=$1`,[row.id]);
    await f.postgres.pool.query('UPDATE public.delivery_work SET incident_closed_at=$2 WHERE outbound_message_id=$1',[row.id,closure]);
    await f.postgres.pool.query(`UPDATE public.outbound_messages SET status='dead' WHERE id=$1`,[row.id]);
  }
  await f.postgres.pool.query(`INSERT INTO public.delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,recorded_at)
    VALUES ($1,$2,1,'started',$3,1,'2026-07-01')`,[old.id,old.user_id,ownerA]);
  await f.postgres.pool.query(`INSERT INTO public.delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,recorded_at,certainty,code)
    VALUES ($1,$2,1,'completed',$3,1,'2026-07-01','uncertain','timeout')`,[old.id,old.user_id,ownerA]);
  await f.postgres.pool.query(`UPDATE public.channel_accounts SET state='stopped' WHERE user_id=$1`,[boundary.user_id]);
  const service=new RetentionService(new PostgresRetentionStore(db),()=>now);
  expect(await service.run(1)).toEqual({conversationWork:0,deliveryWork:1,attempts:2});
  expect(await service.run(1)).toEqual({conversationWork:0,deliveryWork:0,attempts:0});
  expect((await f.postgres.pool.query('SELECT count(*)::int AS count FROM public.inbound_events')).rows[0]).toEqual({count:3});
  expect((await f.postgres.pool.query('SELECT count(*)::int AS count FROM public.outbound_messages')).rows[0]).toEqual({count:3});
  expect((await f.postgres.pool.query('SELECT count(*)::int AS count FROM public.delivery_work')).rows[0]).toEqual({count:2});
  await expect(f.pools.scheduler.query('DELETE FROM public.inbound_events')).rejects.toThrow();
  await expect(f.pools.scheduler.query('DELETE FROM public.delivery_attempts')).rejects.toThrow();
  await expect(service.run(101)).rejects.toThrow();
});
test('cleanup skips locked dead work, enforces batch bounds and clears closure on revival',async()=>{
  await f.postgres.pool.query('TRUNCATE public.users CASCADE');
  const rows=await Promise.all([f.seed(),f.seed(),f.seed()]);
  for(const row of rows){
    await f.postgres.pool.query("UPDATE public.delivery_work SET state='dead' WHERE outbound_message_id=$1",[row.id]);
    await f.postgres.pool.query("UPDATE public.delivery_work SET incident_closed_at='2026-08-01' WHERE outbound_message_id=$1",[row.id]);
  }
  const client=await f.postgres.pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM public.delivery_work WHERE outbound_message_id=$1 FOR UPDATE',[rows[0]!.id]);
    const service=new RetentionService(new PostgresRetentionStore(db),()=>new Date('2026-10-01'));
    expect(await service.run(1)).toEqual({conversationWork:0,deliveryWork:1,attempts:0});
    expect((await f.postgres.pool.query('SELECT count(*)::int AS count FROM public.delivery_work')).rows[0]).toEqual({count:2});
  }finally{await client.query('ROLLBACK');client.release();}
  await f.postgres.pool.query("UPDATE public.delivery_work SET state='ready' WHERE outbound_message_id=$1",[rows[0]!.id]);
  expect((await f.postgres.pool.query('SELECT incident_closed_at FROM public.delivery_work WHERE outbound_message_id=$1',[rows[0]!.id])).rows[0]).toEqual({incident_closed_at:null});
});
test('permanent not_sent journals expire strictly after90 days even after dead work is removed',async()=>{
  await f.postgres.pool.query('TRUNCATE public.users CASCADE');
  const row=await f.seed();
  await f.postgres.pool.query("UPDATE public.outbound_messages SET status='not_sent' WHERE id=$1",[row.id]);
  await f.postgres.pool.query("UPDATE public.delivery_work SET state='dead' WHERE outbound_message_id=$1",[row.id]);
  await f.postgres.pool.query("UPDATE public.delivery_work SET incident_closed_at='2026-08-01' WHERE outbound_message_id=$1",[row.id]);
  await f.postgres.pool.query(`INSERT INTO public.delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,recorded_at)
    VALUES($1,$2,1,'started',$3,1,'2026-07-03')`,[row.id,row.user_id,ownerA]);
  await f.postgres.pool.query(`INSERT INTO public.delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,recorded_at,certainty,code)
    VALUES($1,$2,1,'completed',$3,1,'2026-07-03','not_sent','rejected')`,[row.id,row.user_id,ownerA]);
  let now=new Date('2026-10-01');const service=new RetentionService(new PostgresRetentionStore(db),()=>now);
  expect(await service.run(1)).toEqual({conversationWork:0,deliveryWork:1,attempts:0});
  now=new Date('2026-10-02');
  expect(await service.run(1)).toEqual({conversationWork:0,deliveryWork:0,attempts:2});
});
