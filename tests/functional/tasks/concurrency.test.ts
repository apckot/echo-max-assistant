import {beforeAll,afterAll,expect,test} from 'vitest';
import {taskFixture} from '../../support/task-fixture.js';
import {taskHarness,taskRequest,create,execute} from '../../support/task-command-fixtures.js';
let f:Awaited<ReturnType<typeof taskFixture>>,h:ReturnType<typeof taskHarness>;
beforeAll(async()=>{f=await taskFixture();h=taskHarness(f);},120000);afterAll(async()=>{await f?.close();});
test('different commands racing on version1 produce one effect and one version_conflict',async()=>{
 const task=await create(h,f.a);
 const [a,b]=await Promise.all(['A','B'].map(title=>execute(h,taskRequest(f.a,[{kind:'update',target:{taskId:task.id},expectedVersion:1,patch:{title}}]))));
 expect([a.outcome,b.outcome].sort()).toEqual(['applied','rejected']);expect([a,b].find(x=>x.outcome==='rejected')!.error?.code).toBe('version_conflict');
 expect((await f.migrator.query('SELECT version FROM public.work_items WHERE id=$1',[task.id])).rows[0].version).toBe(2);
 expect((await f.migrator.query('SELECT count(*)::int n FROM public.work_item_events WHERE task_id=$1',[task.id])).rows[0].n).toBe(2);
});
