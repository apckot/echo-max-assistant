import {afterAll,beforeAll,expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {taskFixture} from '../../support/task-fixture.js';
import {TaskCommands} from '../../../src/modules/tasks/application/task-commands.js';
import {PostgresTaskSessionRunner} from '../../../src/infrastructure/postgres/tasks/task-session.js';
import {IanaTimeResolver} from '../../../src/infrastructure/time/iana-time-resolver.js';
let f:Awaited<ReturnType<typeof taskFixture>>,runner:PostgresTaskSessionRunner,commands:TaskCommands;
beforeAll(async()=>{f=await taskFixture();runner=new PostgresTaskSessionRunner(f.database);commands=new TaskCommands(runner,new IanaTimeResolver());},120000);
afterAll(async()=>{await f?.close();});
function request(effectKey=randomUUID()){
 const sourceId=randomUUID();
 return {context:{userId:f.a,actor:'owner',capability:'task_write',source:{kind:'typed',operationId:sourceId},sourceOccurredAt:'2026-10-13T12:00:00Z',timezoneSnapshot:'Europe/Moscow',
 intents:[{kind:'create',binding:{created:'a'},affirmative:true,asserted:true,ownerAuthored:true,quoted:false}]},
 group:{contractVersion:1,effectKey,commands:[{kind:'create',localId:'a',title:'  Дело  '}]}};
}
async function counts(){return (await f.migrator.query(`SELECT (SELECT count(*)::int FROM public.work_items) tasks,
 (SELECT count(*)::int FROM public.work_item_events) events,(SELECT count(*)::int FROM public.task_command_receipts) receipts,
 (SELECT count(*)::int FROM public.outbound_messages) outbox`)).rows[0];}
test('typed create has optional dates, one immutable receipt/event and no delivery',async()=>{
 const r=request();const before=await counts();const result=await commands.execute(r.context,r.group);
 expect(result.replayed).toBe(false);expect(result.receipt.outcome).toBe('applied');
 expect(result.receipt.snapshots[0]).toMatchObject({title:'Дело',status:'open',version:1,timezone:'Europe/Moscow',targetDate:null,scheduledAt:null,dueAt:null,dueDate:null});
 expect(await counts()).toEqual({tasks:before.tasks+1,events:before.events+1,receipts:before.receipts+1,outbox:before.outbox});
 expect((await f.migrator.query('SELECT after_state FROM public.work_item_events WHERE task_id=$1',[result.receipt.snapshots[0].id])).rows[0].after_state).toEqual(result.receipt.snapshots[0]);
});
test('same payload replay returns original UUID and snapshot without changing counts',async()=>{
 const r=request();const first=await commands.execute(r.context,r.group);const before=await counts();
 expect(await commands.execute(r.context,r.group)).toEqual({receipt:first.receipt,replayed:true});expect(await counts()).toEqual(before);
 // Equivalent defaults/key order and normalized instant/text do not change fingerprint.
 const normalized={...r.group,commands:[{deadline:null,targetDate:null,description:null,scheduledAt:null,title:'Дело',kind:'create',localId:'a'}]};
 expect((await commands.execute({...r.context,sourceOccurredAt:'2026-10-13T12:00:00.000Z'},normalized)).receipt).toEqual(first.receipt);
 expect((await commands.execute(r.context,{...r.group,commands:[{...r.group.commands[0],timezone:'Europe/Moscow'}]})).receipt).toEqual(first.receipt);
});
test('distinct keys create identical titles and changed payload/evidence/source conflicts',async()=>{
 const r=request();const first=await commands.execute(r.context,r.group);
 const second=await commands.execute(r.context,{...r.group,effectKey:randomUUID()});expect(second.receipt.snapshots[0].id).not.toBe(first.receipt.snapshots[0].id);
 const before=await counts();
 for(const [ctx,group] of [[r.context,{...r.group,commands:[{...r.group.commands[0],title:'Changed'}]}],
 [{...r.context,source:{kind:'typed',operationId:randomUUID()}},r.group],
 [{...r.context,intents:[{...r.context.intents[0],quoted:true}]},r.group]]){
 expect(await commands.execute(ctx,group)).toEqual({error:{code:'idempotency_conflict'}});
 }
 expect(await counts()).toEqual(before);
});
test('concurrent same key yields exactly one effect and two identical receipts',async()=>{
 const r=request();const before=await counts();const [a,b]=await Promise.all([commands.execute(r.context,r.group),commands.execute(r.context,r.group)]);
 expect(a.receipt).toEqual(b.receipt);expect([a.replayed,b.replayed].sort()).toEqual([false,true]);
 expect(await counts()).toMatchObject({tasks:before.tasks+1,events:before.events+1,receipts:before.receipts+1});
});
test('failure after event before receipt rolls back; retry can create once',async()=>{
 const r=request();const before=await counts();
 const failing={run:(context,fn)=>runner.run(context,session=>fn({...session,persistReceipt:async()=>{throw new Error('injected receipt failure');}}))};
 await expect(new TaskCommands(failing,new IanaTimeResolver()).execute(r.context,r.group)).rejects.toThrow('injected receipt failure');
 expect(await counts()).toEqual(before);
 const first=await commands.execute(r.context,r.group);expect(first.receipt.outcome).toBe('applied');
 expect((await commands.execute(r.context,r.group)).replayed).toBe(true);
});
test('valid command rejected by schedule or evidence has replayable rejected receipt without task effects',async()=>{
 for(const reject of ['schedule','evidence']){
 const r=request();if(reject==='schedule')r.group.commands[0]={...r.group.commands[0],scheduledAt:'2026-10-14T12:00:00Z',deadline:{kind:'instant',at:'2026-10-14T11:00:00Z'}};
 else r.context.intents[0].affirmative=false;
 const before=await counts();const first=await commands.execute(r.context,r.group);
 expect(first.receipt).toMatchObject({outcome:'rejected',commandResults:[],snapshots:[],localIdMap:{},error:{code:reject==='schedule'?'invalid_schedule':'invalid_evidence',index:0}});
 expect(await counts()).toMatchObject({tasks:before.tasks,events:before.events,receipts:before.receipts+1});
 expect(await commands.execute(r.context,r.group)).toEqual({receipt:first.receipt,replayed:true});
 }
});
test('snapshot timezone is explicit, invalid times and untrusted envelope never create',async()=>{
 const r=request();r.group.commands[0]={...r.group.commands[0],timezone:'Europe/Berlin',scheduledAt:'2026-10-14T15:00:00+03:00'};
 expect((await commands.execute(r.context,r.group)).receipt.snapshots[0]).toMatchObject({timezone:'Europe/Berlin',scheduledAt:'2026-10-14T12:00:00.000Z'});
 const before=await counts();expect(await commands.execute({...r.context,userId:'foreign-provider-id'},r.group)).toHaveProperty('error');
 expect(await commands.execute(r.context,{...r.group,commands:[]})).toHaveProperty('error');
 expect(await counts()).toEqual(before);
});
test('deleting user and restore fence deny creation before any receipt or effect',async()=>{
 const r=request();const before=await counts();await f.migrator.query("UPDATE public.users SET status='deleting' WHERE id=$1",[f.a]);
 expect(await commands.execute(r.context,r.group)).toEqual({error:{code:'account_unavailable'}});expect(await counts()).toEqual(before);
 await f.migrator.query("UPDATE public.users SET status='active' WHERE id=$1",[f.a]);
 await f.migrator.query('UPDATE public.system_state SET restore_fence=true');
 try{await expect(commands.execute(r.context,r.group)).rejects.toThrow();expect(await counts()).toEqual(before);}
 finally{await f.migrator.query('UPDATE public.system_state SET restore_fence=false');}
});
test('accepted timezone casing and aliases canonicalize before fingerprint and storage',async()=>{
 const r=request();r.context.timezoneSnapshot='europe/moscow';
 const first=await commands.execute(r.context,r.group);expect(first.receipt.snapshots[0].timezone).toBe('Europe/Moscow');
 expect(await commands.execute({...r.context,timezoneSnapshot:'Europe/Moscow'},r.group)).toEqual({receipt:first.receipt,replayed:true});
 for(const input of ['US/Eastern','Asia/Kolkata']){
 const alias=request();alias.group.commands[0]={...alias.group.commands[0],timezone:input};
 const stored=(await commands.execute(alias.context,alias.group)).receipt.snapshots[0];
 expect((await f.migrator.query('SELECT public.task_valid_timezone($1) AS valid',[stored.timezone])).rows[0].valid).toBe(true);
 expect(new IanaTimeResolver().localDate('2026-10-13T23:00:00.000Z',stored.timezone)).toBe(input==='US/Eastern'?'2026-10-13':'2026-10-14');
 }
});
