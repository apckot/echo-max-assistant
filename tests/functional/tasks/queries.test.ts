import {afterAll,beforeAll,expect,test} from 'vitest';
import {TaskQueries} from '../../../src/modules/tasks/application/task-queries.js';
import {PostgresTaskReadRunner} from '../../../src/infrastructure/postgres/tasks/task-read-model.js';
import {IanaTimeResolver} from '../../../src/infrastructure/time/iana-time-resolver.js';
import {taskFixture} from '../../support/task-fixture.js';
import {taskHarness,taskRequest,create,execute} from '../../support/task-command-fixtures.js';
let f:Awaited<ReturnType<typeof taskFixture>>,h:ReturnType<typeof taskHarness>,q:TaskQueries;
const ctx=()=>({userId:f.a,capability:'task_read',timezone:'Europe/Moscow'});
beforeAll(async()=>{f=await taskFixture();h=taskHarness(f);q=new TaskQueries(new PostgresTaskReadRunner(f.database),new IanaTimeResolver());},120000);afterAll(async()=>{await f?.close();});
test('get and list are tenant scoped, open excludes terminal, exact literal substring search includes description',async()=>{
 const a=await create(h,f.a,{title:'Смета%_\\',description:'ТЕСТовый контекст'}),b=await create(h,f.b,{title:'Смета%_\\'});
 expect(await q.get(ctx(),a.id)).toEqual(a);expect(await q.get(ctx(),b.id)).toBeNull();
 expect((await q.list(ctx(),{text:'%_\\'})).items.map(t=>t.id)).toEqual([a.id]);
 expect((await q.list(ctx(),{text:'тестовый'})).items.map(t=>t.id)).toEqual([a.id]);
 await execute(h,taskRequest(f.a,[{kind:'complete',target:{taskId:a.id},expectedVersion:1}]));
 expect((await q.list(ctx(),{text:'Смета'})).items).toEqual([]);expect((await q.list(ctx(),{view:'all',statuses:['completed'],text:'Смета'})).items.map(t=>t.id)).toEqual([a.id]);
 for(const args of [{limit:101},{limit:0},{text:''},{view:'open',statuses:['completed']},{view:'day',day:'2026-10-14'}])expect(await q.list(ctx(),args)).toEqual({error:{code:'invalid_command'}});
});
test('day uses four OR predicates once, exact time boundaries and excludes undated',async()=>{
 const day='2026-10-19',zone='Europe/Moscow';
 const all=await create(h,f.a,{title:'Day-all',targetDate:day,scheduledAt:'2026-10-18T21:00:00Z',deadline:{kind:'instant',at:'2026-10-19T20:59:59.999Z'}});
 const date=await create(h,f.a,{title:'Day-date',deadline:{kind:'date',date:day}});
 await create(h,f.a,{title:'Day-end',scheduledAt:'2026-10-19T21:00:00Z'});await create(h,f.a,{title:'Day-undated'});
 const r=await q.list(ctx(),{view:'day',day,timezone:zone,text:'Day-'});expect(r.items.map(t=>t.id)).toEqual([all.id,date.id]);
 expect(await q.list(ctx(),{view:'day',day,timezone:'Mars/Olympus'})).toEqual({error:{code:'invalid_timezone'}});
});
test('keyset pages are bounded and fingerprint rejects changed queries or invalid cursors',async()=>{
 await execute(h,taskRequest(f.a,Array.from({length:20},(_,n)=>({kind:'create',localId:'p'+n,title:'Page marker'}))));
 const first=await q.list(ctx(),{text:'Page marker',limit:7});const second=await q.list(ctx(),{text:'Page marker',limit:7,cursor:first.nextCursor});const third=await q.list(ctx(),{text:'Page marker',limit:7,cursor:second.nextCursor});
 expect(new Set([...first.items,...second.items,...third.items].map(t=>t.id)).size).toBe(20);expect(third.nextCursor).toBeNull();
 expect(await q.list(ctx(),{text:'different',limit:7,cursor:first.nextCursor})).toEqual({error:{code:'invalid_command'}});
 expect(await q.list(ctx(),{cursor:'not-json'})).toEqual({error:{code:'invalid_command'}});
});
function atClock(at:string){const database={tenantTransaction:(role,userId,fn)=>f.database.tenantTransaction(role,userId,tx=>fn({...tx,query:(sql,params)=>sql.includes('clock_timestamp() AS transaction_now')?Promise.resolve([{transaction_now:new Date(at)}]):tx.query(sql,params)}))};return new TaskQueries(new PostgresTaskReadRunner(database),new IanaTimeResolver());}
test('continuation preserves first-page asOf across dueAt and date-only deadline crossings',async()=>{
 await execute(h,taskRequest(f.a,[{kind:'create',localId:'o1',title:'Clock marker',deadline:{kind:'instant',at:'2026-10-13T00:00:00Z'}},
 {kind:'create',localId:'o2',title:'Clock marker',deadline:{kind:'instant',at:'2026-10-13T01:00:00Z'}},
 {kind:'create',localId:'new1',title:'Clock marker',deadline:{kind:'instant',at:'2026-10-14T00:00:00Z'}},
 {kind:'create',localId:'new2',title:'Clock marker',deadline:{kind:'date',date:'2026-10-13'}}]));
 const first=await atClock('2026-10-13T20:59:59.000Z').list(ctx(),{view:'overdue',text:'Clock marker',limit:1});
 const second=await atClock('2026-10-14T01:00:00.000Z').list(ctx(),{view:'overdue',text:'Clock marker',limit:1,cursor:first.nextCursor});
 expect(second.asOf).toBe(first.asOf);expect(second.nextCursor).toBeNull();expect(new Set([first.items[0].id,second.items[0].id]).size).toBe(2);
 const fresh=await atClock('2026-10-14T01:00:00.000Z').list(ctx(),{view:'overdue',text:'Clock marker'});expect(fresh.items).toHaveLength(4);expect(fresh.asOf).not.toBe(first.asOf);
});
test('calendar boundaries handle missing/double midnight and fully skipped day independently of meetings',async()=>{
 const t=new IanaTimeResolver();
 expect(t.dayBoundary('2018-11-04','America/Sao_Paulo')).toBe('2018-11-04T03:00:00.000Z');
 expect(t.dayBoundary('2020-11-01','America/Havana')).toBe('2020-11-01T04:00:00.000Z');
 expect(t.dayBoundary('2011-12-30','Pacific/Apia')).toBe('2011-12-30T10:00:00.000Z');expect(t.dayBoundary('2011-12-31','Pacific/Apia')).toBe('2011-12-30T10:00:00.000Z');
 expect(t.resolveLocalTime({date:'2018-11-04',time:'00:00',timezone:'America/Sao_Paulo'})).toEqual({error:{code:'nonexistent_local_time'}});
 expect(t.resolveLocalTime({date:'2020-11-01',time:'00:00',timezone:'America/Havana'})).toEqual({error:{code:'ambiguous_local_time'}});
 const literal=await create(h,f.a,{title:'Skip marker',targetDate:'2011-12-30',timezone:'Pacific/Apia'});await create(h,f.a,{title:'Skip marker',scheduledAt:'2011-12-30T10:00:00Z',timezone:'Pacific/Apia'});
 expect((await q.list(ctx(),{view:'day',day:'2011-12-30',timezone:'Pacific/Apia',text:'Skip marker'})).items.map(t=>t.id)).toEqual([literal.id]);
});
