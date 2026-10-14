import {beforeAll,afterAll,expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {taskFixture} from '../../support/task-fixture.js';
import {taskHarness,taskRequest,create,execute} from '../../support/task-command-fixtures.js';
let f:Awaited<ReturnType<typeof taskFixture>>,h:ReturnType<typeof taskHarness>;
beforeAll(async()=>{f=await taskFixture();h=taskHarness(f);},120000);afterAll(async()=>{await f?.close();});
async function erase(userId:string,operationId:string,mode:string){return (await f.scheduler.query('SELECT public.erase_account($1,$2,$3,$4,$5) result',[userId,operationId,'self_service','privacy_request',mode])).rows[0].result;}
test('technical retention preserves terminal tasks, history and idempotency keys',async()=>{
 const a=await create(h,f.a);const r=taskRequest(f.a,[{kind:'cancel',target:{taskId:a.id},expectedVersion:1}]);const receipt=await execute(h,r);
 await f.scheduler.query('SELECT public.retain_technical_records(clock_timestamp(),100)');
 expect(await execute(h,r)).toEqual(receipt);expect((await f.migrator.query('SELECT count(*)::int n FROM public.work_item_events WHERE task_id=$1',[a.id])).rows[0].n).toBe(2);
});
test('preview/begin/finish erases all task data, preserves other tenant and leaves anonymous counts',async()=>{
 const a=await create(h,f.a,{title:'Private task content'}),b=await create(h,f.b);const operationId=randomUUID();
 const preview=await erase(f.a,operationId,'preview');expect(preview).toMatchObject({status:'preview',counts:{tasks:2,taskEvents:3,taskReceipts:3}});
 expect((await f.migrator.query('SELECT status FROM public.users WHERE id=$1',[f.a])).rows[0].status).toBe('active');
 expect(await erase(f.a,operationId,'begin')).toMatchObject({status:'pending'});
 const r=taskRequest(f.a,[{kind:'create',localId:'a',title:'Must not resurrect'}]);expect(await h.execute(r.context,r.group)).toEqual({error:{code:'account_unavailable'}});
 expect(await erase(f.a,operationId,'finish')).toMatchObject({status:'completed',counts:{tasks:2,taskEvents:3,taskReceipts:3}});
 expect(await erase(f.a,operationId,'finish')).toMatchObject({status:'completed'});
 for(const table of ['work_items','work_item_events','task_command_receipts'])expect((await f.migrator.query(`SELECT 1 FROM public.${table} WHERE user_id=$1`,[f.a])).rowCount).toBe(0);
 expect((await f.migrator.query('SELECT id FROM public.work_items WHERE user_id=$1',[f.b])).rows).toEqual([{id:b.id}]);
 const audit=(await f.scheduler.query('SELECT * FROM public.account_deletions WHERE operation_id=$1',[operationId])).rows[0];expect(audit).toMatchObject({user_id:null,status:'completed'});
 for(const privateValue of [f.a,a.id,'Private task content'])expect(JSON.stringify(audit)).not.toContain(privateValue);
 expect(await h.execute(r.context,r.group)).toEqual({error:{code:'account_unavailable'}});
});
test('ordinary roles cannot delete immutable facts via privacy GUC; only erasure procedure can',async()=>{
 for(const table of ['work_item_events','task_command_receipts'])await expect(f.database.tenantTransaction('worker',f.b,async tx=>{await tx.query("SELECT set_config('app.privacy_erasure','on',true)");await tx.query(`DELETE FROM public.${table}`);})).rejects.toThrow();
 await expect(f.scheduler.query("SET app.privacy_erasure='on'; DELETE FROM public.work_item_events")).rejects.toThrow();
});
