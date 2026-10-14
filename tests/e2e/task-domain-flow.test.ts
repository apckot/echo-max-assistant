import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {taskFixture} from '../support/task-fixture.js';
import {processingFixture} from '../support/task-processing-fixture.js';
import {createDatabase} from '../../src/infrastructure/postgres/database.js';
import {TaskQueries} from '../../src/modules/tasks/application/task-queries.js';
import {PostgresTaskReadRunner} from '../../src/infrastructure/postgres/tasks/task-read-model.js';
import {IanaTimeResolver} from '../../src/infrastructure/time/iana-time-resolver.js';
import {PostgresDeliveryQueue} from '../../src/infrastructure/postgres/postgres-delivery-queue.js';
import {PostgresDeliveryAdmission} from '../../src/infrastructure/postgres/postgres-delivery-admission.js';
import {PostgresDeliveryCompletion} from '../../src/infrastructure/postgres/postgres-delivery-completion.js';
import {DeliveryWorker} from '../../src/modules/delivery/application/delivery-worker.js';
test('typed create/move/complete/reopen/search/history survives restart, rejection, duplicate processing and delivery retry',async()=>{
 const f=await taskFixture();const p=processingFixture(f);let fresh;let delivery;
 try{
 const initial=await p.admit([{kind:'create',localId:'a',title:'Typed flow'}]);const applied=await p.runner(initial).run(initial.lease);
 const receipt=(await f.postgres.pool.query('SELECT result FROM task_command_receipts WHERE id=$1',[applied.value.taskReceiptId])).rows[0].result;const id=receipt.snapshots[0].id;
 fresh=createDatabase({worker:f.worker.options.connectionString});
 for(const command of [{kind:'update',target:{taskId:id},expectedVersion:1,patch:{targetDate:'2026-10-20',scheduledAt:'2026-10-20T09:00:00Z'}},
 {kind:'complete',target:{taskId:id},expectedVersion:2},{kind:'reopen',target:{taskId:id},expectedVersion:3}]){
 const input=await p.admit([command]);expect(await p.runner(input,fresh).run(input.lease)).toMatchObject({kind:'actionable',value:{messages:[{text:'Задачи: applied.'}]}});}
 const q=new TaskQueries(new PostgresTaskReadRunner(fresh),new IanaTimeResolver()),ctx={userId:f.a,capability:'task_read',timezone:'Europe/Moscow'};
 expect((await q.list(ctx,{text:'typed flow'})).items).toMatchObject([{id,version:4,status:'open',targetDate:'2026-10-20'}]);
 expect((await q.history(ctx,{taskId:id})).items.map(e=>e.afterVersion)).toEqual([4,3,2,1]);
 expect(await q.get({...ctx,userId:f.b},id)).toBeNull();
 const rejected=await p.admit([{kind:'create',localId:'bad',title:'Unsaved'},{kind:'cancel',target:{taskId:id},expectedVersion:1}]);
 expect(await p.runner(rejected,fresh).run(rejected.lease)).toMatchObject({value:{messages:[{text:'Задачи: rejected (version_conflict).'}]}});
 const before=await p.counts();await expect(p.runner(initial,fresh).run(initial.lease)).rejects.toThrow();expect(await p.counts()).toEqual(before);
 delivery=createDatabase({delivery:f.delivery.options.connectionString});const queue=new PostgresDeliveryQueue(delivery);let sends=0;
 const worker=new DeliveryWorker(new PostgresDeliveryAdmission(delivery),{send:async()=>++sends===1?{status:'not_sent',code:'preconnection_failure',retryable:true}:{status:'sent',externalMessageId:'typed-fixture-confirmed'}},new PostgresDeliveryCompletion(delivery),()=>0);
 const first=(await queue.claim({ownerId:randomUUID(),limit:1}))[0];expect(await worker.run(first)).toMatchObject({completion:{status:'retry'}});
 await new Promise(resolve=>setTimeout(resolve,650)); // real retry + conversation send spacing

 const next=(await queue.claim({ownerId:randomUUID(),limit:100})).find(l=>l.outboundMessageId===first.outboundMessageId);expect(await worker.run(next)).toMatchObject({completion:{status:'sent'}});
 await expect(worker.run(next)).rejects.toThrow('Delivery lease lost');expect(sends).toBe(2);expect(await p.counts()).toEqual(before);
 expect((await q.get(ctx,id)).version).toBe(4);
 }finally{await delivery?.close();await fresh?.close();await f.close();}
},120000);
