import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,test } from 'vitest';
import { createDatabase } from '../../../src/infrastructure/postgres/database.js';
import { DeleteAccount } from '../../../src/modules/identity/application/delete-account.js';
import { PostgresAccountDeletion } from '../../../src/infrastructure/postgres/postgres-account-deletion.js';
import { PostgresDeliveryQueue } from '../../../src/infrastructure/postgres/postgres-delivery-queue.js';
import { PostgresDeliveryAdmission } from '../../../src/infrastructure/postgres/postgres-delivery-admission.js';
import { PostgresDeliveryCompletion } from '../../../src/infrastructure/postgres/postgres-delivery-completion.js';
import { deliveryFixture,ownerA } from '../../support/delivery-fixture.js';
import type { UserId } from '../../../src/shared/types/identity.js';
let f:Awaited<ReturnType<typeof deliveryFixture>>;let db:ReturnType<typeof createDatabase>;let deletion:DeleteAccount;
const request=(userId:string)=>({userId:userId as UserId,operationId:randomUUID(),actor:'operator' as const,reason:'privacy_request' as const});
beforeAll(async()=>{f=await deliveryFixture();db=createDatabase({scheduler:f.pools.scheduler.options.connectionString!});deletion=new DeleteAccount(new PostgresAccountDeletion(db));},120_000);
afterAll(async()=>{await db?.close();await f?.close();});
test('preview is read-only; begin blocks ingress and stale leases; finish removes all tenant rows and leaves anonymous audit',async()=>{
  const seed=await f.seed();const survivor=await f.seed();const input=request(seed.user_id);
  const queue=new PostgresDeliveryQueue(f.database);
  const leases=await queue.claim({ownerId:ownerA,limit:100});const lease=leases.find(l=>l.userId===seed.user_id)!;
  const preview=await deletion.preview(input);
  expect(preview).toMatchObject({status:'preview',counts:{inbound:1,outbound:1,accounts:1,conversations:1}});
  expect((await f.postgres.pool.query('SELECT status FROM public.users WHERE id=$1',[seed.user_id])).rows[0]).toEqual({status:'active'});
  expect((await f.postgres.pool.query('SELECT count(*)::int AS count FROM public.account_deletions')).rows[0]).toEqual({count:0});
  await deletion.begin(input);
  await expect(new PostgresDeliveryAdmission(f.database).admit(lease)).rejects.toThrow();
  const account=(await f.postgres.pool.query('SELECT external_user_id FROM public.channel_accounts WHERE user_id=$1',[seed.user_id])).rows[0]!;
  await expect(f.pools.gateway.query('SELECT * FROM public.accept_max_inbound($1,$1,$2,$3,$4,$5)',
    [account.external_user_id,'new-during-deletion','2026-10-01',JSON.stringify({kind:'text',text:'private'}),'a'.repeat(64)])).rejects.toThrow();
  expect(await deletion.finish(input)).toMatchObject({status:'completed'});
  expect(await deletion.apply(input)).toMatchObject({status:'completed'});
  for(const table of ['users','channel_accounts','conversations','inbound_events','processing_receipts','outbound_messages','delivery_attempts','conversation_work','delivery_work']){
    const column=table==='users'?'id':'user_id';
    expect((await f.postgres.pool.query(`SELECT 1 FROM public.${table} WHERE ${column}=$1`,[seed.user_id])).rowCount).toBe(0);
  }
  expect((await f.postgres.pool.query('SELECT 1 FROM public.users WHERE id=$1',[survivor.user_id])).rowCount).toBe(1);
  const audit=(await f.postgres.pool.query('SELECT * FROM public.account_deletions')).rows;
  expect(audit).toMatchObject([{user_id:null,status:'completed',actor:'operator',reason:'privacy_request'}]);
  expect(JSON.stringify(audit)).not.toContain(JSON.stringify(account.external_user_id));
  expect(JSON.stringify(audit)).not.toContain(seed.user_id);
  await expect(f.pools.scheduler.query('DELETE FROM public.users')).rejects.toThrow();
  await expect(f.pools.scheduler.query("SET app.privacy_erasure='on'; DELETE FROM public.delivery_attempts")).rejects.toThrow();
});
test('already admitted send must resolve before privacy erasure; ordinary immutable facts stay protected',async()=>{
  await f.postgres.pool.query('TRUNCATE public.users CASCADE');
  const seed=await f.seed();const input=request(seed.user_id);
  const [lease]=await new PostgresDeliveryQueue(f.database).claim({ownerId:ownerA,limit:1});
  const admitted=await new PostgresDeliveryAdmission(f.database).admit(lease!);
  expect(admitted.status).toBe('admitted');if(admitted.status!=='admitted')throw new Error('admission_failed');
  await deletion.begin(input);
  expect(await deletion.finish(input)).toMatchObject({status:'waiting'});
  await expect(f.pools.migrator.query('DELETE FROM public.delivery_attempts')).rejects.toThrow();
  await new PostgresDeliveryCompletion(f.database).complete(lease!,admitted.attempt,{status:'uncertain',code:'timeout'},{kind:'terminal'});
  expect(await deletion.finish(input)).toMatchObject({status:'completed'});
  expect((await f.postgres.pool.query('SELECT 1 FROM public.delivery_attempts')).rowCount).toBe(0);
});
test('a second operation cannot delete a different tenant or bypass the pending job',async()=>{
  const seed=await f.seed();const other=await f.seed();const input=request(seed.user_id);
  await deletion.begin(input);
  await expect(deletion.begin({...input,userId:other.user_id as UserId})).rejects.toThrow();
  await expect(deletion.begin({...input,operationId:randomUUID()})).rejects.toThrow();
  expect((await f.postgres.pool.query('SELECT status FROM public.users WHERE id=$1',[other.user_id])).rows[0]).toEqual({status:'active'});
  expect(await deletion.finish(input)).toMatchObject({status:'completed'});
});
