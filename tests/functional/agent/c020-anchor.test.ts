import {beforeAll,afterAll,test,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import third from '../../../docs/progress/stage-3-openai-probe-attempt-3-results.json';
import {probeCases} from '../../semantic/stage3-probe.js';
import {agentFixture} from '../../support/agent-fixture.js';
import {create,execute,taskHarness,taskRequest} from '../../support/task-command-fixtures.js';
import {ContextBuilder} from '../../../src/modules/context/application/context-builder.js';
import {PostgresContextReader} from '../../../src/infrastructure/postgres/context/context-reader.js';
import {TurnCoordinator} from '../../../src/modules/agent/application/turn-coordinator.js';
import {parseMeaningDraft} from '../../../src/modules/semantic/domain/meaning-decision.js';
import {PostgresAgentTaskProcessing} from '../../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {PostgresTurnFinalizer} from '../../../src/infrastructure/postgres/agent/response-intent.js';
import type {UserId} from '../../../src/shared/types/identity.js';
let f:Awaited<ReturnType<typeof agentFixture>>,serial=4400;
beforeAll(async()=>{f=await agentFixture();},120000);afterAll(async()=>{await f?.close();});
type Mode='sent'|'none'|'undelivered'|'multiple'|'ambiguous_reply'|'foreign'|'conversation'|'stale'|'wrong_label';
async function fixture(c:ReturnType<typeof probeCases>[number],mode:Mode='sent'){
 const providerUser=String(++serial),chat=String(serial+10000);
 const userId=(await f.gateway.query('SELECT * FROM public.resolve_or_create_max_identity($1,$2,\'bot_started\')',[providerUser,chat])).rows[0].user_id as UserId;
 const h=taskHarness(f),seeds=[];
 for(const candidate of c.pack.candidates)seeds.push(await create(h,userId,{title:candidate.title}));
 if(mode==='multiple'||mode==='ambiguous_reply'||mode==='wrong_label')seeds.push(await create(h,userId,{title:'Другая задача'}));
 const messageId='synthetic-anchor-'+randomUUID(),reply=c.pack.anchors.length&&mode!=='none';
 const input=await f.admit(c.pack.text,chat,providerUser,{kind:'text',text:c.pack.text,...(reply?{replyToMessageId:messageId}:{})});
 const reader=new PostgresContextReader(f.database);
 if(reply){
  let owner=userId,conversation=input.lease.conversationId,inbound=input.event.id;
  if(mode==='foreign'||mode==='conversation'){
   const other=await f.admit('Synthetic previous reply',undefined,mode==='foreign'?'302':providerUser);owner=other.lease.userId;conversation=other.lease.conversationId;inbound=other.event.id;
  }
  const outbound=randomUUID();
  await f.migrator.query(`INSERT INTO public.outbound_messages(id,user_id,conversation_id,source_inbound_event_id,provider,message_index,payload,dedupe_key) VALUES($1,$2,$3,$4,'max',1,'{"version":1,"kind":"text","text":"Synthetic previous reply"}',$5)`,[outbound,owner,conversation,inbound,'response:'+inbound+':1:v1']);
  const anchored=mode==='foreign'?[await create(h,owner,{title:'Чужая задача'})]:mode==='wrong_label'?[seeds[1]!]:seeds;
  await reader.saveAnchor(owner,conversation,outbound,mode==='multiple'?'list':c.pack.anchors[0]!.kind,anchored.map(t=>({id:t.id,version:t.version})));
  if(mode!=='undelivered'){
   await f.migrator.query(`INSERT INTO public.delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation) VALUES($1,$2,1,'started',$3,1)`,[outbound,owner,randomUUID()]);
   const attempt=(await f.migrator.query('SELECT lease_owner FROM delivery_attempts WHERE outbound_message_id=$1',[outbound])).rows[0];
   await f.migrator.query(`INSERT INTO public.delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,certainty,external_message_id) VALUES($1,$2,1,'completed',$3,1,'sent',$4)`,[outbound,owner,attempt.lease_owner,messageId]);
  }
 }
 if(mode==='stale'){
  await execute(h,taskRequest(userId,[{kind:'update',target:{taskId:seeds[0]!.id},expectedVersion:1,patch:{description:'Changed after delivery'}}]));
  seeds[0]=(await f.tasks.get({userId,capability:'task_read',timezone:c.pack.timezone},seeds[0]!.id)) as typeof seeds[number];
 }
 // Frozen synthetic candidate ordering/source labels reproduce the saved provider envelope.
 // The reader still proves delivery/tenant/conversation; public Tasks owns the actual effects.
 class SavedContext extends ContextBuilder{
  override async build(...args:Parameters<ContextBuilder['build']>){const built=await super.build(args[0],args[1],{...args[2],sourceLabel:c.pack.sourceLabel});return {...built,provider:{...built.provider,pendingChoices:c.pack.pendingChoices}};}
 }
 const context=new SavedContext({list:async()=>({items:seeds,nextCursor:null,asOf:c.pack.sourceAt}),get:f.tasks.get.bind(f.tasks)},reader);
 let savedReads=0;
 const coordinator=new TurnCoordinator(f.authority,context,f.tasks,f.time,{decide:async()=>{savedReads++;const decision=parseMeaningDraft(third.results.find(r=>r.id===c.id)!.result.decision);if(mode==='wrong_label'&&decision.actions[0]?.target?.kind==='candidate')return {outcome:'ok',decision:parseMeaningDraft({...decision,actions:[{...decision.actions[0],target:{...decision.actions[0].target,label:'T2'}}]}),model:'negative-label-corruption',durationMs:0,usage:null};return {outcome:'ok',decision,model:'saved-probe3-offline',durationMs:0,usage:null};}},{profileDigest:'b'.repeat(64),externalAllowed:true,deadlineMs:7000});
 return {input,seeds,userId,run:()=>coordinator.run(input.lease),reads:()=>savedReads};
}
test('saved C020 resolves only a confirmed unique reply task, retaining its delivered version',async()=>{
 const c=await fixture(probeCases().find(c=>c.id==='C020')!);const staged=await c.run();if(staged.status!=='accepted')throw Error('stage');
 expect(staged.ticket.plan!.groups[0]!.status).toBe('ready');expect(staged.ticket.plan!.groups[0]!.commands).toEqual([{kind:'complete',target:{taskId:c.seeds[0]!.id},expectedVersion:1}]);
 const result=await new PostgresAgentTaskProcessing(f.authority).runGroup(staged.ticket,0);expect(result.receipt!.snapshots[0]).toMatchObject({id:c.seeds[0]!.id,userId:c.userId,status:'completed',version:2});
});
test.each(['none','multiple','ambiguous_reply','foreign','conversation','undelivered','stale','wrong_label'] as const)('C020 refuses %s authority; never defaults to latest task',async mode=>{
 const c=await fixture(probeCases().find(c=>c.id==='C020')!,mode);const staged=await c.run();
 if(['foreign','conversation','undelivered'].includes(mode)){expect(staged.status).toBe('failed');expect(c.reads()).toBe(0);}else{if(staged.status!=='accepted')throw Error('stage');expect(staged.ticket.plan!.groups[0]!.status).not.toBe('ready');expect(staged.ticket.plan!.groups[0]!.commands).toEqual([]);}
 const page=await f.tasks.list({userId:c.userId,capability:'task_read',timezone:'Europe/Moscow'},{view:'all',limit:20});if('error' in page)throw Error('query');expect(page.items.every(t=>t.status==='open')).toBe(true);
});
test('all12 unmodified saved responses pass current coordinator/compiler/Tasks/finalizer locally, without AI calls',async()=>{
 const expected:Record<string,number>={C003:1,C024:1,C025:1,C013:0,C015:0,C016:2,C034:1,C020:1,C041:1,C043:0,C005:1,C064:1},rows=[];
 for(const scenario of probeCases()){
  const c=await fixture(scenario),staged=await c.run();if(staged.status!=='accepted')throw Error(scenario.id+': stage');const groups=staged.ticket.plan!.groups;
  expect.soft(groups.some(g=>g.status==='blocked'),scenario.id).toBe(false);expect.soft(groups.reduce((n,g)=>n+g.commands.length,0),scenario.id).toBe(expected[scenario.id]);
  if(scenario.id==='C034')expect.soft(groups.map(g=>g.status)).toEqual(['ready','choice']);
  const outcomes=[];for(let i=0;i<groups.length;i++)outcomes.push(await new PostgresAgentTaskProcessing(f.authority).runGroup(staged.ticket,i));
  expect.soft(outcomes.some(o=>o.outcome==='rejected'),scenario.id).toBe(false);await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket);
  const created=outcomes.flatMap(o=>o.receipt?.snapshots??[]).find(t=>!c.seeds.some(s=>s.id===t.id));
  if(['C003','C024','C034','C041','C005','C064'].includes(scenario.id)){
   expect.soft(created,scenario.id).toBeDefined();
   if(created)expect.soft(created).toMatchObject({status:'open',description:null,version:1,scheduledAt:scenario.id==='C024'?'2026-09-12T06:00:00.000Z':scenario.id==='C005'?'2026-09-11T08:00:00.000Z':null,dueAt:scenario.id==='C064'?'2026-09-12T06:00:00.000Z':null,dueDate:null,targetDate:scenario.id==='C024'||scenario.id==='C064'?'2026-09-12':null});
  }

  for(const [index,before] of c.seeds.entries()){
   const after=await f.tasks.get({userId:c.userId,capability:'task_read',timezone:'Europe/Moscow'},before.id);if(!after||'error' in after)throw Error('task');
   if(scenario.id==='C020'||scenario.id==='C016'&&index===0)expect.soft(after).toMatchObject({...before,status:'completed',version:2,completedAt:after.completedAt,updatedAt:after.updatedAt});
   else if(scenario.id==='C016')expect.soft(after).toMatchObject({...before,targetDate:'2026-09-12',version:2,updatedAt:after.updatedAt});
   else if(scenario.id==='C025')expect.soft(after).toMatchObject({...before,targetDate:'2026-09-12',scheduledAt:'2026-09-12T06:00:00.000Z',version:2,updatedAt:after.updatedAt});
   else expect.soft(after).toEqual(before);
  }
  rows.push({id:scenario.id,savedResponseReads:c.reads(),newAiCalls:0,groups:groups.map(g=>({status:g.status,commands:g.commands.map(c=>({kind:c.kind,...(c.kind==='update'?{patch:c.patch}:c.kind==='create'?{targetDate:c.targetDate,scheduledAt:c.scheduledAt,deadline:c.deadline}:{})})),reasons:g.reasons})),outcomes:outcomes.map(o=>o.outcome)});
 }
 if(process.env.ECHO_APPLICATION_REPLAY_REPORT)writeFileSync(process.env.ECHO_APPLICATION_REPLAY_REPORT,JSON.stringify({kind:'offline_saved_probe3_application_replay',newAiCalls:0,rows},null,2)+'\n');
 expect.soft(rows).toHaveLength(12);
},120000);
