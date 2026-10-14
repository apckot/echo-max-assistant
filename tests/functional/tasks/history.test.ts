import {beforeAll,afterAll,expect,test} from 'vitest';
import {TaskQueries} from '../../../src/modules/tasks/application/task-queries.js';
import {PostgresTaskReadRunner} from '../../../src/infrastructure/postgres/tasks/task-read-model.js';
import {IanaTimeResolver} from '../../../src/infrastructure/time/iana-time-resolver.js';
import {taskFixture} from '../../support/task-fixture.js';
import {taskHarness,taskRequest,create,execute} from '../../support/task-command-fixtures.js';
let f:Awaited<ReturnType<typeof taskFixture>>,h:ReturnType<typeof taskHarness>,q:TaskQueries;
const ctx=()=>({userId:f.a,capability:'task_read',timezone:'Europe/Moscow'});
beforeAll(async()=>{f=await taskFixture();h=taskHarness(f);q=new TaskQueries(new PostgresTaskReadRunner(f.database),new IanaTimeResolver());},120000);afterAll(async()=>{await f?.close();});
test('history exposes immutable before/after, actors and sources, skips no_change/replay/rejected',async()=>{
 const task=await create(h,f.a);const r=taskRequest(f.a,[{kind:'update',target:{taskId:task.id},expectedVersion:1,patch:{title:'Изменено'}},{kind:'complete',target:{taskId:task.id},expectedVersion:2},{kind:'reopen',target:{taskId:task.id},expectedVersion:3}]);
 await execute(h,r);await execute(h,r);await execute(h,taskRequest(f.a,[{kind:'update',target:{taskId:task.id},expectedVersion:4,patch:{title:'Изменено'}}]));await execute(h,taskRequest(f.a,[{kind:'cancel',target:{taskId:task.id},expectedVersion:1}]));
 const page=await q.history(ctx(),{taskId:task.id});expect(page.items.map(e=>e.afterVersion)).toEqual([4,3,2,1]);
 expect(page.items[0]).toMatchObject({kind:'reopen',before:{status:'completed',version:3},after:{status:'open',version:4},actor:'owner',source:{kind:'typed',operationId:r.context.source.operationId},sourceOccurredAt:'2026-10-14T09:00:00.000Z'});
 expect(await q.history({...ctx(),userId:f.b},{taskId:task.id})).toEqual({error:{code:'task_not_found'}});
 expect(await q.history(ctx(),{taskId:task.id,limit:101})).toEqual({error:{code:'invalid_command'}});
});
test('history and changes keyset pagination have no gaps at equal recorded timestamps and include terminal tasks',async()=>{
 const task=await create(h,f.a);await execute(h,taskRequest(f.a,[{kind:'complete',target:{taskId:task.id},expectedVersion:1},{kind:'reopen',target:{taskId:task.id},expectedVersion:2},{kind:'cancel',target:{taskId:task.id},expectedVersion:3}]));
 const first=await q.history(ctx(),{taskId:task.id,limit:2});const next=await q.history(ctx(),{taskId:task.id,limit:2,cursor:first.nextCursor});expect([...first.items,...next.items].map(e=>e.afterVersion)).toEqual([4,3,2,1]);
 expect(next.nextCursor).toBeNull();
 const all=[];let cursor=null;let asOf=null;
 do{const page=await q.changes(ctx(),{limit:2,cursor});all.push(...page.items);cursor=page.nextCursor;if(asOf)expect(page.asOf).toBe(asOf);asOf=page.asOf;}while(cursor);
 expect(new Set(all.map(e=>e.eventId)).size).toBe(all.length);expect(all.filter(e=>e.taskId===task.id).map(e=>e.kind).sort()).toEqual(['cancel','complete','create','reopen']);
 expect(await q.changes(ctx(),{since:'2026-10-20T00:00:00Z'})).toMatchObject({items:[]});
 expect((await q.changes({...ctx(),userId:f.b},{})).items).toEqual([]);
 const page=await q.changes(ctx(),{limit:1});expect(await q.changes(ctx(),{limit:2,cursor:page.nextCursor})).toEqual({error:{code:'invalid_command'}});
});
