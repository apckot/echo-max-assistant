import {beforeAll,afterAll,expect,test} from 'vitest';
import {taskFixture} from '../../support/task-fixture.js';
import {taskHarness,taskRequest,create} from '../../support/task-command-fixtures.js';
import {TaskQueries} from '../../../src/modules/tasks/application/task-queries.js';
import {PostgresTaskReadRunner} from '../../../src/infrastructure/postgres/tasks/task-read-model.js';
import {IanaTimeResolver} from '../../../src/infrastructure/time/iana-time-resolver.js';
let f:Awaited<ReturnType<typeof taskFixture>>,h:ReturnType<typeof taskHarness>;
const time=new IanaTimeResolver();const ctx=()=>({userId:f.a,capability:'task_read',timezone:'Europe/Moscow'});
function queries(at?:string){const db=at?{...f.database,tenantTransaction:(role,userId,fn)=>f.database.tenantTransaction(role,userId,tx=>fn({...tx,query:(sql,params)=>sql.includes('clock_timestamp() AS transaction_now')?Promise.resolve([{transaction_now:new Date(at)}]):tx.query(sql,params)}))}:f.database;return new TaskQueries(new PostgresTaskReadRunner(db),time);}
beforeAll(async()=>{f=await taskFixture();h=taskHarness(f);},120000);afterAll(async()=>{await f?.close();});
test.each([
 ['2026-03-29','2026-03-28T23:00:00.000Z','2026-03-29T22:00:00.000Z',23],
 ['2026-10-25','2026-10-24T22:00:00.000Z','2026-10-25T23:00:00.000Z',25],
])('Berlin %s day uses actual %ih interval and half-open instant bounds',async(day,start,end,hours)=>{
 expect(time.dayBoundary(day,'Europe/Berlin')).toBe(start);expect((Date.parse(end)-Date.parse(start))/3600000).toBe(hours);
 const marker='Berlin'+day,a=await create(h,f.a,{title:marker,scheduledAt:start,timezone:'America/New_York'});
 await create(h,f.a,{title:marker,scheduledAt:end});
 const near=await create(h,f.a,{title:marker,scheduledAt:new Date(Date.parse(end)-1).toISOString()});
 expect((await queries().list(ctx(),{view:'day',day,timezone:'Europe/Berlin',text:marker})).items.map(t=>t.id)).toEqual([a.id,near.id]);
 expect((await queries().get(ctx(),a.id)).timezone).toBe('America/New_York');
});
test.each([
 ['2018-11-04','America/Sao_Paulo','2018-11-04T03:00:00.000Z','2018-11-05T02:00:00.000Z','nonexistent_local_time'],
 ['2020-11-01','America/Havana','2020-11-01T04:00:00.000Z','2020-11-02T05:00:00.000Z','ambiguous_local_time'],
])('missing/double midnight %s survives PG read while meeting remains strict',async(day,zone,start,end,error)=>{
 expect(time.dayBoundary(day,zone)).toBe(start);expect(time.resolveLocalTime({date:day,time:'00:00',timezone:zone})).toEqual({error:{code:error}});
 const marker='Midnight'+zone,a=await create(h,f.a,{title:marker,scheduledAt:start}),b=await create(h,f.a,{title:marker,scheduledAt:new Date(Date.parse(start)+3600000).toISOString()});
 await create(h,f.a,{title:marker,scheduledAt:end});
 expect((await queries().list(ctx(),{view:'day',day,timezone:zone,text:marker})).items.map(t=>t.id)).toEqual([a.id,b.id]);
 if(zone==='America/Havana')expect(time.resolveLocalTime({date:day,time:'00:00',timezone:zone,offset:'-05:00'})).toHaveProperty('at','2020-11-01T05:00:00.000Z');
});
test('skipped day preserves literal dates and frozen cursor across its deadline boundary',async()=>{
 const marker='Skipped temporal',zone='Pacific/Apia',boundary='2011-12-30T10:00:00.000Z';expect(time.dayBoundary('2011-12-30',zone)).toBe(boundary);expect(time.dayBoundary('2011-12-31',zone)).toBe(boundary);
 const literal=await create(h,f.a,{title:marker,targetDate:'2011-12-30',deadline:{kind:'date',date:'2011-12-30'},timezone:zone});
 await create(h,f.a,{title:marker,scheduledAt:boundary,timezone:zone});
 expect((await queries().list(ctx(),{view:'day',day:'2011-12-30',timezone:zone,text:marker})).items.map(t=>t.id)).toEqual([literal.id]);
 for(let i=0;i<2;i++)await create(h,f.a,{title:marker,deadline:{kind:'date',date:'2011-12-28'},timezone:zone});
 const first=await queries('2011-12-30T09:59:59.999Z').list(ctx(),{view:'overdue',text:marker,limit:1});
 const second=await queries(boundary).list(ctx(),{view:'overdue',text:marker,limit:1,cursor:first.nextCursor});expect(second.asOf).toBe(first.asOf);expect(second.nextCursor).toBeNull();expect(second.items[0].id).not.toBe(first.items[0].id);
 expect((await queries(boundary).list(ctx(),{view:'overdue',text:marker})).items).toHaveLength(3);
 expect((await queries().get(ctx(),literal.id)).dueDate).toBe('2011-12-30');
});
test('date-only deadline crosses next-day boundary, supported range/leap dates roundtrip, profile update preserves snapshot/replay',async()=>{
 const request=taskRequest(f.a,[{kind:'create',localId:'a',title:'Snapshot deadline',deadline:{kind:'date',date:'2026-03-29'},timezone:'Europe/Berlin'}]);
 const first=await h.execute(request.context,request.group);
 await f.postgres.pool.query("UPDATE users SET timezone='America/New_York' WHERE id=$1",[f.a]);
 try{expect(await h.execute(request.context,request.group)).toEqual({...first,replayed:true});}finally{await f.postgres.pool.query("UPDATE users SET timezone='Europe/Moscow' WHERE id=$1",[f.a]);}
 expect((await queries('2026-03-29T21:59:59.999Z').list(ctx(),{view:'overdue',text:'Snapshot deadline'})).items).toEqual([]);
 expect((await queries('2026-03-29T22:00:00.000Z').list(ctx(),{view:'overdue',text:'Snapshot deadline'})).items).toHaveLength(1);
 for(const day of ['0001-01-01','2028-02-29','9999-12-31']){const task=await create(h,f.a,{targetDate:day,deadline:{kind:'date',date:day}});expect(await queries().get(ctx(),task.id)).toMatchObject({targetDate:day,dueDate:day});}
});
