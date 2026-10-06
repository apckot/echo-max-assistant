import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,test } from 'vitest';
import { deliveryFixture } from '../../support/delivery-fixture.js';
let f:Awaited<ReturnType<typeof deliveryFixture>>;
beforeAll(async()=>{f=await deliveryFixture();},120_000);
afterAll(async()=>{await f?.close();});
test('restore is preview-only by default; fenced reconciliation quarantines old outbox and invalidates leases',async()=>{
 const old=await f.seed();const sending=await f.seed();const retry=await f.seed();
 await f.postgres.pool.query("UPDATE public.outbound_messages SET status='sending' WHERE id=$1",[sending.id]);
 await f.postgres.pool.query("UPDATE public.outbound_messages SET status='retry' WHERE id=$1",[retry.id]);
 await f.postgres.pool.query("UPDATE public.delivery_work SET state='leased',lease_owner=$1,lease_generation=7,lease_until=clock_timestamp()+interval '1 hour'",[randomUUID()]);
 const snapshot=(await f.postgres.pool.query('SELECT clock_timestamp() AS t')).rows[0].t;
 const incident=randomUUID();await f.postgres.pool.query('UPDATE public.system_state SET restore_fence=true');
 await expect(f.pools.migrator.query('SELECT public.reconcile_restore($1,$2,true)',[randomUUID(),'2020-01-01T00:00:00Z'])).rejects.toThrow('Snapshot older than restored data');
 const preview=await f.pools.migrator.query('SELECT public.reconcile_restore($1,$2,false) AS result',[incident,snapshot]);
 expect(preview.rows[0].result).toMatchObject({outbound:3,applied:false});
 expect((await f.postgres.pool.query("SELECT count(*)::int n FROM public.delivery_work WHERE state='leased'")).rows[0].n).toBe(3);
 await expect(f.pools.gateway.query('SELECT public.accept_max_inbound($1,$1,$2,$3,$4,$5)', ['999','message:999',new Date().toISOString(),'{"kind":"text","text":"test"}','a'.repeat(64)])).rejects.toThrow();
 await expect(f.pools.worker.query('SELECT public.guard_worker_restore_fence()')).rejects.toThrow();
 await expect(f.pools.delivery.query('SELECT public.guard_delivery_restore_fence()')).rejects.toThrow();
 await f.pools.migrator.query('SELECT public.reconcile_restore($1,$2,true)',[incident,snapshot]);
 expect((await f.postgres.pool.query('SELECT DISTINCT status FROM public.outbound_messages')).rows).toEqual([{status:'uncertain_restore'}]);
 expect((await f.postgres.pool.query('SELECT DISTINCT state,lease_generation,lease_owner FROM public.delivery_work')).rows).toEqual([{state:'cancelled',lease_generation:'8',lease_owner:null}]);
 expect((await f.pools.gateway.query('SELECT public.component_health() AS h')).rows[0].h.delivery.uncertain).toBe(3);
 await f.pools.migrator.query('SELECT public.reopen_restore($1)',[incident]);
 const fresh=await f.seed();expect((await f.postgres.pool.query('SELECT status FROM public.outbound_messages WHERE id=$1',[fresh.id])).rows[0].status).toBe('pending');
 // An old unprocessed inbound materialized after reopen remains quarantined.
 await f.postgres.pool.query('DELETE FROM public.delivery_work WHERE outbound_message_id=$1',[old.id]);
 await f.postgres.pool.query('DELETE FROM public.outbound_messages WHERE id=$1',[old.id]);
 await f.postgres.pool.query(`INSERT INTO public.outbound_messages(user_id,conversation_id,source_inbound_event_id,message_index,payload,dedupe_key)
 SELECT user_id,conversation_id,id,0,'{"version":1,"kind":"text","text":"late old response"}','response:'||id||':0:v1' FROM public.inbound_events WHERE user_id=$1`,[old.user_id]);
 expect((await f.postgres.pool.query('SELECT status FROM public.outbound_messages WHERE user_id=$1',[old.user_id])).rows[0].status).toBe('uncertain_restore');
 await expect(f.pools.scheduler.query('SELECT public.reconcile_restore($1,$2,true)',[randomUUID(),snapshot])).rejects.toThrow();
});
