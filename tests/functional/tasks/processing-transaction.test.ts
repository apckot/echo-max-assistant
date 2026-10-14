import {beforeAll,afterAll,expect,test} from 'vitest';
import {taskFixture} from '../../support/task-fixture.js';
import {processingFixture} from '../../support/task-processing-fixture.js';
import {taskHarness,create} from '../../support/task-command-fixtures.js';
let f:Awaited<ReturnType<typeof taskFixture>>,p:ReturnType<typeof processingFixture>;
beforeAll(async()=>{f=await taskFixture();p=processingFixture(f);},120000);afterAll(async()=>{await f?.close();});
test('typed leased create commits state, event, both receipts, outbox and sequence together',async()=>{
 const input=await p.admit([{kind:'create',localId:'a',title:'Atomic'}]),before=await p.counts();
 const result=await p.runner(input).run(input.lease);expect(result).toMatchObject({kind:'actionable',value:{receiptType:'task_commands_v1',taskReceiptId:expect.any(String),messages:[{text:'Задачи: applied.'}]}});
 expect(await p.counts()).toEqual({tasks:before.tasks+1,events:before.events+1,task_receipts:before.task_receipts+1,processing:before.processing+1,outbox:before.outbox+1,delivery:before.delivery+1});
 const receipt=(await f.postgres.pool.query('SELECT source_kind,source_id FROM task_command_receipts WHERE id=$1',[result.value.taskReceiptId])).rows[0];expect(receipt).toEqual({source_kind:'turn',source_id:input.event.id});
 expect((await f.postgres.pool.query('SELECT next_apply_sequence FROM conversations WHERE id=$1',[input.lease.conversationId])).rows[0].next_apply_sequence).toBe('2');
});
test('outbox failure rolls back every task write and receipt; same lease can retry',async()=>{
 const input=await p.admit([{kind:'create',localId:'a',title:'Rollback'}]),before=await p.counts();let reached=false;
 const broken={...f.database,tenantTransaction:(role,userId,fn)=>f.database.tenantTransaction(role,userId,tx=>fn({...tx,query:async(sql,values)=>{if(sql.startsWith('INSERT INTO public.outbound_messages')){reached=true;throw Error('injected outbox');}return tx.query(sql,values);}}))};
 await expect(p.runner(input,broken).run(input.lease)).rejects.toThrow('injected outbox');expect(reached).toBe(true);expect(await p.counts()).toEqual(before);
 expect(await p.runner(input).run(input.lease)).toMatchObject({kind:'actionable'});
});
test('production foundation text still emits echo without task effect',async()=>{
 const input=await p.admit([{kind:'create',localId:'a',title:'Never'}]),before=await p.counts();
 expect(await p.runner(input,f.database,false).run(input.lease)).toMatchObject({value:{receiptType:'foundation_echo'}});
 expect(await p.counts()).toMatchObject({tasks:before.tasks,events:before.events,task_receipts:before.task_receipts});
});
test('user lock precedes conversation; deleting user and stale lease cannot commit',async()=>{
 const input=await p.admit([{kind:'create',localId:'a',title:'Denied'}]);const locks:string[]=[];
 const tracked={...f.database,tenantTransaction:(role,userId,fn)=>f.database.tenantTransaction(role,userId,tx=>fn({...tx,query:async(sql,values)=>{if(sql.includes('FOR SHARE')||sql.includes('FOR UPDATE'))locks.push(sql);return tx.query(sql,values);}}))};
 await p.runner(input,tracked).run(input.lease);expect(locks[0]).toContain('public.users');expect(locks[1]).toContain('public.conversations');
 const denied=await p.admit([{kind:'create',localId:'a',title:'Denied'}]);await f.postgres.pool.query("UPDATE users SET status='deleting' WHERE id=$1",[denied.lease.userId]);
 const before=await p.counts();await expect(p.runner(denied).run(denied.lease)).rejects.toThrow();expect(await p.counts()).toEqual(before);
 await f.postgres.pool.query("UPDATE users SET status='active' WHERE id=$1",[denied.lease.userId]);
 await expect(p.runner(denied).run({...denied.lease,leaseGeneration:denied.lease.leaseGeneration+1n})).rejects.toThrow();expect(await p.counts()).toEqual(before);
});
test('task processing result is closed and composite receipt FK denies foreign-tenant confirmation',async()=>{
 const task=await create(taskHarness(f),f.b);const foreign=(await f.postgres.pool.query('SELECT receipt_id FROM work_item_events WHERE task_id=$1',[task.id])).rows[0].receipt_id;
 const input=await p.admit([{kind:'create',localId:'a',title:'FK fixture'}]);
 const result={receiptType:'task_commands_v1',receiptVersion:1,taskReceiptId:foreign,messages:[{version:1,kind:'text',text:'fixture'}]};
 for(const bad of [{...result,taskReceiptId:null},{...result,taskReceiptId:'00000000-0000-0000-0000-000000000000'},{...result,extra:true},{...result,messages:[]},{...result,receiptVersion:2}])expect((await f.migrator.query('SELECT public.valid_processing_result($1::jsonb) valid',[JSON.stringify(bad)])).rows[0].valid).toBe(false);
 await expect(f.database.tenantTransaction('worker',input.lease.userId,tx=>tx.query(`INSERT INTO public.processing_receipts(user_id,conversation_id,inbound_event_id,receipt_type,receipt_version,result) VALUES($1,$2,$3,'task_commands_v1',1,$4)`,[input.lease.userId,input.lease.conversationId,input.event.id,JSON.stringify(result)]))).rejects.toMatchObject({code:'DB_FAILURE'});
});
