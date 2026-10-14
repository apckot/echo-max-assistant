import {afterAll,beforeAll,expect,test} from 'vitest';
import {taskFixture} from '../../support/task-fixture.js';
import {taskHarness,taskRequest,create,execute} from '../../support/task-command-fixtures.js';
let f:Awaited<ReturnType<typeof taskFixture>>,h:ReturnType<typeof taskHarness>;
beforeAll(async()=>{f=await taskFixture();h=taskHarness(f);},120000);afterAll(async()=>{await f?.close();});
const cases=[['open','update','applied'],['open','complete','applied'],['open','cancel','applied'],['open','reopen','no_change'],
['completed','update','invalid_transition'],['completed','complete','no_change'],['completed','cancel','invalid_transition'],['completed','reopen','applied'],
['cancelled','update','invalid_transition'],['cancelled','complete','invalid_transition'],['cancelled','cancel','no_change'],['cancelled','reopen','applied']];
test.each(cases)('persistent %s + %s yields %s',async(status,kind,want)=>{
 let task=await create(h,f.a,{targetDate:'2026-10-16',scheduledAt:'2026-10-16T12:00:00Z'});
 if(status!=='open')task=(await execute(h,taskRequest(f.a,[{kind:status==='completed'?'complete':'cancel',target:{taskId:task.id},expectedVersion:1}]))).snapshots[0]!;
 const before=(await f.migrator.query('SELECT count(*)::int n FROM public.work_item_events WHERE task_id=$1',[task.id])).rows[0].n;
 const receipt=await execute(h,taskRequest(f.a,[{kind,target:{taskId:task.id},expectedVersion:task.version,...(kind==='update'?{patch:{title:'Изменено'}}:{})}]));
 if(want==='invalid_transition'){expect(receipt.outcome).toBe('rejected');expect(receipt.error?.code).toBe(want);expect(receipt.snapshots).toEqual([]);}
 else{expect(receipt.outcome).toBe(want);expect(receipt.snapshots[0]).toMatchObject({id:task.id,version:task.version+(want==='applied'?1:0),scheduledAt:task.scheduledAt});
 if(kind==='reopen')expect(receipt.snapshots[0]).toMatchObject({status:'open',completedAt:null,cancelledAt:null});}
 expect((await f.migrator.query('SELECT count(*)::int n FROM public.work_item_events WHERE task_id=$1',[task.id])).rows[0].n).toBe(before+(want==='applied'?1:0));
});
test('patch clears only explicit null, equal values are no_change and stale no-op conflicts',async()=>{
 const task=await create(h,f.a,{description:'Контекст',targetDate:'2026-10-16',scheduledAt:'2026-10-16T12:00:00Z',deadline:{kind:'instant',at:'2026-10-17T12:00:00Z'}});
 const moved=(await execute(h,taskRequest(f.a,[{kind:'update',target:{taskId:task.id},expectedVersion:1,patch:{targetDate:'2026-10-17',description:null,deadline:null}}]))).snapshots[0]!;
 expect(moved).toMatchObject({version:2,targetDate:'2026-10-17',description:null,dueAt:null,scheduledAt:task.scheduledAt});
 const equal=await execute(h,taskRequest(f.a,[{kind:'update',target:{taskId:task.id},expectedVersion:2,patch:{title:'Дело'}}]));expect(equal.outcome).toBe('no_change');expect(equal.snapshots[0]).toEqual(moved);
 const complete=await execute(h,taskRequest(f.a,[{kind:'complete',target:{taskId:task.id},expectedVersion:2}]));expect(complete.snapshots[0].completedAt).not.toBeNull();
 expect((await execute(h,taskRequest(f.a,[{kind:'complete',target:{taskId:task.id},expectedVersion:2}]))).error?.code).toBe('version_conflict');
 const reopened=await execute(h,taskRequest(f.a,[{kind:'reopen',target:{taskId:task.id},expectedVersion:3}]));expect(reopened.snapshots[0]).toMatchObject({version:4,scheduledAt:task.scheduledAt,completedAt:null});
});
test('foreign UUID is indistinguishable from missing and mutation replay returns its historical snapshot',async()=>{
 const task=await create(h,f.a);const r=taskRequest(f.a,[{kind:'update',target:{taskId:task.id},expectedVersion:1,patch:{title:'Первое'}}]);
 const receipt=await execute(h,r);await execute(h,taskRequest(f.a,[{kind:'complete',target:{taskId:task.id},expectedVersion:2}]));
 expect(await execute(h,r)).toEqual(receipt);
 const foreign=await execute(h,taskRequest(f.b,[{kind:'cancel',target:{taskId:task.id},expectedVersion:3}]));expect(foreign).toMatchObject({outcome:'rejected',snapshots:[],error:{code:'task_not_found'}});
});
