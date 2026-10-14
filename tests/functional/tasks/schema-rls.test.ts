import {beforeAll,afterAll,expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {taskFixture} from '../../support/task-fixture.js';
let f:Awaited<ReturnType<typeof taskFixture>>;
beforeAll(async()=>{f=await taskFixture();},120000);
afterAll(async()=>{await f?.close();});
const taskId=randomUUID(),receiptId=randomUUID(),sourceId=randomUUID();
function snapshot(userId:string){return {id:taskId,userId,title:'Дело',description:null,status:'open',targetDate:null,scheduledAt:null,dueDate:null,dueAt:null,timezone:'Europe/Moscow',version:1,
 createdAt:'2026-10-13T12:00:00.000Z',updatedAt:'2026-10-13T12:00:00.000Z',completedAt:null,cancelledAt:null};}
async function insertTriplet(tx:{query:Function},tenant:string,eventTenant=tenant){
 const after=snapshot(tenant);
 const result={receiptId,contractVersion:1,effectKey:'schema:create',outcome:'applied',commandResults:[{index:0,kind:'create',taskId,beforeVersion:null,afterVersion:1,outcome:'applied'}],localIdMap:{a:taskId},snapshots:[after],error:null};
 await tx.query(`INSERT INTO public.work_items(id,user_id,title,timezone,created_at,updated_at) VALUES($1,$2,'Дело','Europe/Moscow','2026-10-13T12:00:00Z','2026-10-13T12:00:00Z')`,[taskId,tenant]);
 await tx.query(`INSERT INTO public.work_item_events(id,user_id,task_id,receipt_id,command_index,effect_kind,before_version,after_version,before_state,after_state)
 VALUES($1,$2,$3,$4,0,'create',NULL,1,NULL,$5)`,[randomUUID(),eventTenant,taskId,receiptId,JSON.stringify(after)]);
 await tx.query(`INSERT INTO public.task_command_receipts(id,user_id,effect_key,payload_hash,canonical_payload,result,source_kind,source_id,actor,source_occurred_at,timezone_snapshot)
 VALUES($1,$2,'schema:create',$3,$4,$5,'typed',$6,'owner','2026-10-13T12:00:00Z','Europe/Moscow')`,[receiptId,tenant,'a'.repeat(64),JSON.stringify({contractVersion:1,commands:[{kind:'create'}],actor:'owner',source:{kind:'typed',operationId:sourceId},sourceOccurredAt:'2026-10-13T12:00:00.000Z',timezoneSnapshot:'Europe/Moscow',intents:[]}),JSON.stringify(result),sourceId]);
}
test('task schema exposes forced tenant RLS and permits only an atomic state/event/receipt triplet',async()=>{
 expect((await f.migrator.query('SELECT schema_version FROM public.system_state')).rows[0].schema_version).toBe(25);
 const client=await f.worker.connect();
 try {await client.query('BEGIN');await client.query("SELECT set_config('app.user_id',$1,true)",[f.a]);
 await insertTriplet({query:async(sql:string,params:unknown[])=>{return (await client.query(sql,params)).rows;}},f.a);
 await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 expect(await f.database.tenantTransaction('worker',f.a,tx=>tx.query('SELECT id FROM public.work_items'))).toEqual([{id:taskId}]);
 for(const table of ['work_items','work_item_events','task_command_receipts']){
 expect(await f.database.tenantTransaction('worker',f.b,tx=>tx.query(`SELECT id FROM public.${table}`))).toEqual([]);
 expect((await f.worker.query(`SELECT id FROM public.${table}`)).rows).toEqual([]);
 for(const pool of [f.gateway,f.delivery,f.scheduler])await expect(pool.query(`SELECT id FROM public.${table}`)).rejects.toMatchObject({code:'42501'});
 }
});
test('cross-tenant FK and WITH CHECK reject unrelated task/event links',async()=>{
 await expect(f.database.tenantTransaction('worker',f.b,tx=>tx.query(`INSERT INTO public.work_item_events(id,user_id,task_id,receipt_id,command_index,effect_kind,after_version,after_state)
 VALUES($1,$2,$3,$4,0,'create',1,$5)`,[randomUUID(),f.b,taskId,receiptId,JSON.stringify(snapshot(f.b))]))).rejects.toThrow();
 await expect(f.database.tenantTransaction('worker',f.a,tx=>tx.query('UPDATE public.work_items SET user_id=$1 WHERE id=$2',[f.b,taskId]))).rejects.toThrow();
});
test('immutable facts reject UPDATE and DELETE including privacy GUC spoofing',async()=>{
 for(const table of ['work_item_events','task_command_receipts'])for(const op of ['UPDATE','DELETE']){
 await expect(f.database.tenantTransaction('worker',f.a,async tx=>{
 await tx.query("SELECT set_config('app.privacy_erasure','on',true)");
 await tx.query(op==='UPDATE'?`UPDATE public.${table} SET user_id=user_id`:`DELETE FROM public.${table}`);
 })).rejects.toThrow();
 }
 await expect(f.migrator.query('UPDATE public.work_item_events SET after_version=2')).rejects.toMatchObject({code:'55000'});
});
test('invalid schedule, calendar, text, snapshot and orphan current state cannot commit',async()=>{
 for(const assignment of ["due_date='infinity'","scheduled_at='infinity'","due_at='2026-10-14T00:00:00.0001Z'","timezone='Mars/Olympus'","title=E'bad\\nline'","target_date='0001-01-01 BC'","completed_at=now()"])
 await expect(f.database.tenantTransaction('worker',f.a,tx=>tx.query(`UPDATE public.work_items SET ${assignment} WHERE id=$1`,[taskId]))).rejects.toThrow();
 await expect(f.database.tenantTransaction('worker',f.a,tx=>tx.query("INSERT INTO public.work_items(id,user_id,title,timezone) VALUES($1,$2,'orphan','UTC')",[randomUUID(),f.a]))).rejects.toThrow();
 await expect(f.database.tenantTransaction('worker',f.a,tx=>tx.query("UPDATE public.work_items SET title='No matching event' WHERE id=$1",[taskId]))).rejects.toThrow();
 expect((await f.migrator.query('SELECT public.valid_task_snapshot($1::jsonb) AS valid',[JSON.stringify({...snapshot(f.a),unexpected:true})])).rows[0].valid).toBe(false);
});
test('receipt JSON rejects malformed results, local identity maps and nonclosed error codes',async()=>{
 const base={receiptId,contractVersion:1,effectKey:'probe',outcome:'applied',commandResults:[{index:0,kind:'create',taskId,beforeVersion:null,afterVersion:1,outcome:'applied'}],localIdMap:{a:taskId},snapshots:[snapshot(f.a)],error:null};
 const bad=[{...base,localIdMap:{a:'not-a-uuid'}},{...base,localIdMap:{'bad local label':taskId}},
 {...base,commandResults:[{...base.commandResults[0],beforeVersion:'oops'}]},
 {...base,commandResults:[base.commandResults[0],base.commandResults[0]]},
 {...base,outcome:'rejected',commandResults:[],localIdMap:{},snapshots:[],error:{code:'invented'}},
 {...base,outcome:'rejected',commandResults:[],localIdMap:{},snapshots:[],error:{code:'invalid_schedule',privateText:'secret'}}];
 for(const receipt of bad)expect((await f.migrator.query('SELECT public.valid_task_receipt($1::jsonb) AS valid',[JSON.stringify(receipt)])).rows[0].valid).toBe(false);
});
test('receipt validator rejects JSON null scalars and runtime CHECK never accepts SQL NULL',async()=>{
 const base={receiptId:randomUUID(),contractVersion:1,effectKey:'null:probe',outcome:'applied',commandResults:[{index:0,kind:'create',taskId,beforeVersion:null,afterVersion:1,outcome:'applied'}],localIdMap:{a:taskId},snapshots:[snapshot(f.a)],error:null};
 const rejected={...base,outcome:'rejected',commandResults:[],localIdMap:{},snapshots:[],error:{code:null}};
 for(const receipt of [{...base,outcome:null},{...base,effectKey:null},{...base,commandResults:[{...base.commandResults[0],kind:null}]},
 {...base,commandResults:[{...base.commandResults[0],outcome:null}]},rejected]){
 expect((await f.migrator.query('SELECT public.valid_task_receipt($1::jsonb) AS valid',[JSON.stringify(receipt)])).rows[0].valid).toBe(false);
 }
 await expect(f.database.tenantTransaction('worker',f.a,tx=>tx.query(`INSERT INTO public.task_command_receipts(id,user_id,effect_key,payload_hash,canonical_payload,result,source_kind,source_id,actor,source_occurred_at,timezone_snapshot)
 VALUES($1,$2,'null:probe',$3,'{}',$4,'typed',$5,'owner',now(),'UTC')`,[rejected.receiptId,f.a,'a'.repeat(64),JSON.stringify(rejected),sourceId]))).rejects.toThrow();
});
