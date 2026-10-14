import {beforeAll,afterAll,expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {taskFixture} from '../../support/task-fixture.js';
import {processingFixture} from '../../support/task-processing-fixture.js';
import {taskHarness,create,taskRequest} from '../../support/task-command-fixtures.js';
let f:Awaited<ReturnType<typeof taskFixture>>,p:ReturnType<typeof processingFixture>;
beforeAll(async()=>{f=await taskFixture();p=processingFixture(f);},120000);afterAll(async()=>{await f?.close();});
test('two conversations compete for version1: one effect and one rejected confirmation',async()=>{
 const task=await create(taskHarness(f),f.a),a=await p.admit([{kind:'complete',target:{taskId:task.id},expectedVersion:1}]),b=await p.admit([{kind:'cancel',target:{taskId:task.id},expectedVersion:1}]);
 const before=await p.counts();const result=await Promise.all([p.runner(a).run(a.lease),p.runner(b).run(b.lease)]);
 expect(result.map(r=>r.value.messages[0].text).sort()).toEqual(['Задачи: applied.','Задачи: rejected (version_conflict).']);
 expect(await p.counts()).toEqual({tasks:before.tasks,events:before.events+1,task_receipts:before.task_receipts+2,processing:before.processing+2,outbox:before.outbox+2,delivery:before.delivery+2});
});
test('expired live lease after all writes rolls back; independent renew cannot revive it',async()=>{
 const input=await p.admit([{kind:'create',localId:'a',title:'Expired'}]),before=await p.counts();let renewal:Promise<unknown>|undefined;
 const expired={...f.database,tenantTransaction:(role,userId,fn)=>f.database.tenantTransaction(role,userId,tx=>fn({...tx,query:async(sql,values)=>{
 const rows=await tx.query(sql,values);if(sql.startsWith('INSERT INTO public.delivery_work')){renewal=p.queue.renew(input.lease);await tx.query("UPDATE conversation_work SET lease_until=clock_timestamp()-interval '1 second' WHERE conversation_id=$1",[input.lease.conversationId]);}return rows;}}))};
 await expect(p.runner(input,expired).run(input.lease)).rejects.toMatchObject({name:'ConversationLeaseLostError'});await renewal;expect(await p.counts()).toEqual(before);
 // Expire the durable original lease too; a new renewal cannot bring it back.
 await f.postgres.pool.query("UPDATE conversation_work SET lease_until=clock_timestamp()-interval '1 second' WHERE conversation_id=$1",[input.lease.conversationId]);expect(await p.queue.renew(input.lease)).toBeNull();
});
test('restore fence activation waits for admitted transaction; subsequent writers are denied',async()=>{
 const input=await p.admit([{kind:'create',localId:'a',title:'Before fence'}]);let fenced:Promise<unknown>|undefined;
 const tracked={...f.database,tenantTransaction:(role,userId,fn)=>f.database.tenantTransaction(role,userId,tx=>fn({...tx,query:async(sql,values)=>{const rows=await tx.query(sql,values);if(sql.startsWith('INSERT INTO public.delivery_work'))fenced=f.postgres.pool.query('UPDATE system_state SET restore_fence=true');return rows;}}))};
 await p.runner(input,tracked).run(input.lease);await fenced;
 const before=await p.counts();try{const request=taskRequest(f.a,[{kind:'create',localId:'a',title:'Denied'}]);await expect(taskHarness(f).execute(request.context,request.group)).rejects.toThrow();expect(await p.counts()).toEqual(before);}finally{await f.postgres.pool.query('UPDATE system_state SET restore_fence=false');}
});
test('erasure races admitted bound and standalone writes without deadlock; erased key cannot resurrect',async()=>{
 const input=await p.admit([{kind:'create',localId:'a',title:'Erase'}],'302');const operation=randomUUID();let begin:Promise<unknown>|undefined,standalone:Promise<unknown>|undefined;
 const request=taskRequest(f.b,[{kind:'create',localId:'a',title:'Concurrent'}]);
 const tracked={...f.database,tenantTransaction:(role,userId,fn)=>f.database.tenantTransaction(role,userId,tx=>fn({...tx,query:async(sql,values)=>{const rows=await tx.query(sql,values);if(sql.startsWith('INSERT INTO public.delivery_work')){
 standalone=taskHarness(f).execute(request.context,request.group);
 begin=f.scheduler.query("SELECT public.erase_account($1,$2,'self_service','privacy_request','begin')",[f.b,operation]);}return rows;}}))};
 await p.runner(input,tracked).run(input.lease);await Promise.all([begin,standalone]);
 await f.scheduler.query("SELECT public.erase_account($1,$2,'self_service','privacy_request','finish')",[f.b,operation]);
 for(const table of ['work_items','work_item_events','task_command_receipts','processing_receipts','outbound_messages'])expect((await f.postgres.pool.query(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`,[f.b])).rows[0].n).toBe(0);
 expect(await taskHarness(f).execute(request.context,request.group)).toEqual({error:{code:'account_unavailable'}});
});
