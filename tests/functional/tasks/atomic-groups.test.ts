import {afterAll,beforeAll,expect,test} from 'vitest';
import {TaskCommands} from '../../../src/modules/tasks/application/task-commands.js';
import {PostgresTaskSessionRunner} from '../../../src/infrastructure/postgres/tasks/task-session.js';
import {IanaTimeResolver} from '../../../src/infrastructure/time/iana-time-resolver.js';
import {taskFixture} from '../../support/task-fixture.js';
import {taskHarness,taskRequest,create,execute} from '../../support/task-command-fixtures.js';
let f:Awaited<ReturnType<typeof taskFixture>>,h:ReturnType<typeof taskHarness>;
beforeAll(async()=>{f=await taskFixture();h=taskHarness(f);},120000);afterAll(async()=>{await f?.close();});
async function counts(){return (await f.migrator.query('SELECT (SELECT count(*)::int FROM public.work_items) tasks,(SELECT count(*)::int FROM public.work_item_events) events,(SELECT count(*)::int FROM public.task_command_receipts) receipts')).rows[0];}
test('create local reference plus update commits final snapshot and two command-indexed events',async()=>{
 const before=await counts();const receipt=await execute(h,taskRequest(f.a,[{kind:'create',localId:'a',title:'Первое'},{kind:'update',target:{created:'a'},expectedVersion:1,patch:{title:'Второе'}}]));
 expect(receipt).toMatchObject({outcome:'applied',snapshots:[{title:'Второе',version:2}],commandResults:[{index:0,afterVersion:1},{index:1,afterVersion:2}]});
 expect(receipt.localIdMap.a).toBe(receipt.snapshots[0].id);expect(await counts()).toEqual({tasks:before.tasks+1,events:before.events+2,receipts:before.receipts+1});
});
test('reopen then update and no_change before applied preserve sequential versions and original command indexes',async()=>{
 const task=await create(h,f.a);await execute(h,taskRequest(f.a,[{kind:'complete',target:{taskId:task.id},expectedVersion:1}]));
 const receipt=await execute(h,taskRequest(f.a,[{kind:'reopen',target:{taskId:task.id},expectedVersion:2},{kind:'update',target:{taskId:task.id},expectedVersion:3,patch:{title:'Дело'}},{kind:'cancel',target:{taskId:task.id},expectedVersion:3}]));
 expect(receipt.snapshots[0]).toMatchObject({status:'cancelled',version:4});
 expect(receipt.commandResults.map(c=>c.outcome)).toEqual(['applied','no_change','applied']);
 expect((await f.migrator.query('SELECT command_index FROM public.work_item_events WHERE receipt_id=$1 ORDER BY command_index',[receipt.receiptId])).rows).toEqual([{command_index:0},{command_index:2}]);
});
test('invalid final command and stale second target roll back all earlier effects',async()=>{
 const a=await create(h,f.a),b=await create(h,f.a);const before=await counts();
 for(const commands of [[{kind:'create',localId:'x',title:'Unsaved'},{kind:'cancel',target:{taskId:a.id},expectedVersion:9}],
 [{kind:'update',target:{taskId:a.id},expectedVersion:1,patch:{title:'Unsaved'}},{kind:'cancel',target:{taskId:b.id},expectedVersion:9}]]){
 const receipt=await execute(h,taskRequest(f.a,commands));expect(receipt).toMatchObject({outcome:'rejected',snapshots:[],commandResults:[],localIdMap:{},error:{code:'version_conflict',index:1}});
 }
 expect(await counts()).toEqual({tasks:before.tasks,events:before.events,receipts:before.receipts+2});
 expect((await f.migrator.query('SELECT title,version FROM public.work_items WHERE id=$1',[a.id])).rows[0]).toEqual({title:'Дело',version:1});
});
test('local references are group-local, backward-only and labels unique;20 allowed21 rejected',async()=>{
 for(const commands of [[{kind:'update',target:{created:'a'},expectedVersion:1,patch:{title:'X'}},{kind:'create',localId:'a',title:'Y'}],
 [{kind:'create',localId:'a',title:'X'},{kind:'create',localId:'a',title:'Y'}],
 [{kind:'cancel',target:{created:'a'},expectedVersion:1}]])expect((await execute(h,taskRequest(f.a,commands))).error?.code).toBe('invalid_local_reference');
 const twenty=Array.from({length:20},(_,n)=>({kind:'create',localId:'a'+n,title:'Дело'}));expect((await execute(h,taskRequest(f.a,twenty))).snapshots).toHaveLength(20);
 const r=taskRequest(f.a,[...twenty,{kind:'create',localId:'last',title:'X'}]);expect(await h.execute(r.context,r.group)).toEqual({error:{code:'group_limit_exceeded'}});
});
test('policy failure rolls back whole group, reverse target order has no deadlock',async()=>{
 const a=await create(h,f.a),b=await create(h,f.a),before=await counts();const runner=new PostgresTaskSessionRunner(f.database);
 const failing={run:(ctx,fn)=>runner.run(ctx,s=>fn({...s,effectsPolicy:{apply:async()=>{throw new Error('policy failed');}}}))};
 const r=taskRequest(f.a,[{kind:'cancel',target:{taskId:a.id},expectedVersion:1},{kind:'cancel',target:{taskId:b.id},expectedVersion:1}]);
 await expect(new TaskCommands(failing,new IanaTimeResolver()).execute(r.context,r.group)).rejects.toThrow('policy failed');expect(await counts()).toEqual(before);
 const receipts=await Promise.all([[a,b],[b,a]].map(tasks=>execute(h,taskRequest(f.a,tasks.map(t=>({kind:'cancel',target:{taskId:t.id},expectedVersion:1}))))));
 expect(receipts.map(r=>r.outcome).sort()).toEqual(['applied','rejected']);
});
