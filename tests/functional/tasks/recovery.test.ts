import {beforeAll,afterAll,expect,test} from 'vitest';
import {createDatabase} from '../../../src/infrastructure/postgres/database.js';
import {taskFixture} from '../../support/task-fixture.js';
import {processingFixture} from '../../support/task-processing-fixture.js';
import {taskHarness,taskRequest} from '../../support/task-command-fixtures.js';
import {TaskCommands} from '../../../src/modules/tasks/application/task-commands.js';
import {PostgresTaskSessionRunner} from '../../../src/infrastructure/postgres/tasks/task-session.js';
import {IanaTimeResolver} from '../../../src/infrastructure/time/iana-time-resolver.js';
let f:Awaited<ReturnType<typeof taskFixture>>,p:ReturnType<typeof processingFixture>;
beforeAll(async()=>{f=await taskFixture();p=processingFixture(f);},120000);afterAll(async()=>{await f?.close();});
const restart=()=>createDatabase({worker:f.worker.options.connectionString,workerTransactionTimeoutMs:5000});
test('real PG backend disconnect after outbox rolls everything back; independent restarted session retries once',async()=>{
 const input=await p.admit([{kind:'create',localId:'a',title:'Disconnect'}]),before=await p.counts();let killed=false;
 const broken={...f.database,tenantTransaction:(role,userId,fn)=>f.database.tenantTransaction(role,userId,tx=>fn({...tx,query:async(sql,values)=>{
 const rows=await tx.query(sql,values);if(sql.startsWith('INSERT INTO public.delivery_work')){const [pid]=await tx.query('SELECT pg_backend_pid() pid');await f.postgres.pool.query('SELECT pg_terminate_backend($1)',[pid.pid]);killed=true;await tx.query('SELECT 1');}return rows;}}))};
 await expect(p.runner(input,broken).run(input.lease)).rejects.toThrow();expect(killed).toBe(true);expect(await p.counts()).toEqual(before);
 const fresh=restart();try{expect(await p.runner(input,fresh).run(input.lease)).toMatchObject({kind:'actionable'});}finally{await fresh.close();}
 expect(await p.counts()).toEqual({tasks:before.tasks+1,events:before.events+1,task_receipts:before.task_receipts+1,processing:before.processing+1,outbox:before.outbox+1,delivery:before.delivery+1});
});
test('real COMMIT succeeds but acknowledgement fixture fails; restarted processing cannot repeat effects',async()=>{
 const input=await p.admit([{kind:'create',localId:'a',title:'Committed'}]),before=await p.counts();
 const lost={...f.database,tenantTransaction:async(role,userId,fn)=>{await f.database.tenantTransaction(role,userId,fn);throw Error('lost COMMIT acknowledgement');}};
 await expect(p.runner(input,lost).run(input.lease)).rejects.toThrow('lost COMMIT acknowledgement');
 const after=await p.counts();expect(after).toEqual({tasks:before.tasks+1,events:before.events+1,task_receipts:before.task_receipts+1,processing:before.processing+1,outbox:before.outbox+1,delivery:before.delivery+1});
 const original=(await f.postgres.pool.query('SELECT result FROM task_command_receipts WHERE effect_key=$1',[input.request.group.effectKey])).rows[0].result;
 await f.postgres.pool.query('UPDATE conversation_work SET available_at=clock_timestamp() WHERE conversation_id=$1',[input.lease.conversationId]);
 const lease=(await p.queue.claim({ownerId:p.ownerId,limit:100})).find(l=>l.conversationId===input.lease.conversationId)!;
 const fresh=restart();try{expect(await p.runner(input,fresh).run(lease)).toEqual({kind:'drained'});}finally{await fresh.close();}
 expect(await p.counts()).toEqual(after);expect((await f.postgres.pool.query('SELECT result FROM task_command_receipts WHERE effect_key=$1',[input.request.group.effectKey])).rows[0].result).toEqual(original);
});
test('standalone lost COMMIT acknowledgement replay returns original immutable receipt from a new session',async()=>{
 const request=taskRequest(f.a,[{kind:'create',localId:'a',title:'Standalone'}]);
 const lost={...f.database,tenantTransaction:async(role,userId,fn)=>{await f.database.tenantTransaction(role,userId,fn);throw Error('lost ACK');}};
 await expect(new TaskCommands(new PostgresTaskSessionRunner(lost),new IanaTimeResolver()).execute(request.context,request.group)).rejects.toThrow('lost ACK');
 const original=(await f.postgres.pool.query('SELECT result FROM task_command_receipts WHERE effect_key=$1',[request.group.effectKey])).rows[0].result,before=await p.counts();
 const fresh=restart();try{expect(await new TaskCommands(new PostgresTaskSessionRunner(fresh),new IanaTimeResolver()).execute(request.context,request.group)).toEqual({receipt:original,replayed:true});}finally{await fresh.close();}
 expect(await p.counts()).toEqual(before);
});
test('profile timezone alias snapshot survives bound authority validation',async()=>{
 await f.postgres.pool.query("UPDATE users SET timezone='Asia/Kolkata' WHERE id=$1",[f.a]);
 try{const input=await p.admit([{kind:'create',localId:'a',title:'Zone'}]);expect(await p.runner(input).run(input.lease)).toMatchObject({kind:'actionable',value:{receiptType:'task_commands_v1'}});}
 finally{await f.postgres.pool.query("UPDATE users SET timezone='Europe/Moscow' WHERE id=$1",[f.a]);}
});
