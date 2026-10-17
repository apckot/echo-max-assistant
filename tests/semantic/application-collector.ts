import {preparePrivacy} from '../../src/modules/privacy/application/privacy-gateway.js';
import {randomUUID} from 'node:crypto';
import type {agentFixture} from '../support/agent-fixture.js';
import {create,execute,taskHarness,taskRequest} from '../support/task-command-fixtures.js';
import type {RFixture,ROp,RGroup} from './r-fixtures.js';
import {fieldsSchema} from './r-fixtures.js';
import type {Task} from '../../src/modules/tasks/domain/task.js';
import type {TaskCommand} from '../../src/modules/tasks/domain/commands.js';
import type {ContextSnapshot} from '../../src/modules/context/application/context-pack.js';
import type {AcceptedPlan,PlannedGroup} from '../../src/modules/agent/application/turn-port.js';
import type {AiDecisionProvider} from '../../src/modules/semantic/application/provider-port.js';
import {PostgresAgentTaskProcessing} from '../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {PostgresTurnFinalizer} from '../../src/infrastructure/postgres/agent/response-intent.js';
import {ChoiceTokens,PostgresPendingChoices} from '../../src/infrastructure/postgres/agent/pending-choice.js';
import {PostgresContextReader} from '../../src/infrastructure/postgres/context/context-reader.js';
import type {CorpusCase,Observation} from './oracle.js';
import {evaluateObservation} from './oracle.js';
type Fixture=Awaited<ReturnType<typeof agentFixture>>;
export type CollectorMode={kind:'typed_mechanism'}|{kind:'provider';provider:AiDecisionProvider;execution?:'fake'|'real';metrics?:()=>{semanticWire:number;costUsd:number|null}};
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const stable=(t:Task)=>Object.fromEntries(Object.keys(fieldsSchema.shape).map(k=>[k,t[k as keyof Task]]));
/** Compare observable returned fields, never merely IDs or copied request filters. */
export function observedQuery(q:any,name:(id:string)=>string){return {kind:q.kind==='tasks'?(q.day?'day':'open'):q.kind,refs:q.kind==='tasks'?[...new Set(q.items.map((t:any)=>name(t.id)))].sort():q.kind==='history'?[...new Set(q.items.map((e:any)=>name(e.taskId)))].sort():[],...(q.day?{day:q.day}:{}),...(q.kind==='tasks'?{items:q.items.map((t:Task)=>({ref:name(t.id),...stable(t)})).sort((a:any,b:any)=>a.ref.localeCompare(b.ref))}:{}),...(q.kind==='history'?{items:q.items.map((e:any)=>({ref:name(e.taskId),kind:e.kind,beforeVersion:e.beforeVersion,afterVersion:e.afterVersion,before:e.before?stable(e.before):null,after:stable(e.after)}))}:{})};}
/** Independent assertions of outcome claims; do not re-run the production renderer. */
export function outcomeWordingMatches(groups:readonly any[],text:string){
 const expected:string[]=[];
 for(const g of groups){if(g.receipt){if(g.receipt.outcome==='rejected'){expected.push(g.receipt.error?.code==='version_conflict'?'Задача уже изменилась. Эта группа действий не применена.':'Не удалось применить эту группу действий. Задачи группы не изменены.');continue;}
 for(const r of g.receipt.commandResults){const t=g.receipt.snapshots.find((t:any)=>t.id===r.taskId);if(!t)return false;const verb=r.outcome==='no_change'?'Без изменений':({create:'Создано',update:'Изменено',complete:'Завершено',cancel:'Отменено',reopen:'Восстановлено'} as Record<string,string>)[r.kind];if(!verb)return false;expected.push(`${verb}: «${t.title}».`);}}
 else if(g.outcome==='choice')expected.push('Нужен однозначный выбор. Это действие пока не выполнено.');
 else if(g.outcome==='blocked')expected.push('Не удалось надёжно определить команду или цель. Это действие не выполнено.');}
 const claims=text.split('\n').map(l=>l.replace(/^\d+\. /,'')).filter(l=>/^(Создано:|Изменено:|Завершено:|Отменено:|Восстановлено:|Без изменений:|Нужен однозначный выбор\.|Не удалось надёжно определить команду|Не удалось применить эту группу|Задача уже изменилась\.)/.test(l));
 return equal(claims.sort(),expected.sort());
}

function patch(fields:Record<string,unknown>){const p={...fields};delete p.ref;delete p.status;delete p.version;if('dueAt' in p||'dueDate' in p){p.deadline=p.dueAt?{kind:'instant',at:p.dueAt}:p.dueDate?{kind:'date',date:p.dueDate}:null;delete p.dueAt;delete p.dueDate;}return p;}
function commands(ops:readonly ROp[],bindings:Record<string,Task>):TaskCommand[]{const versions=Object.fromEntries(Object.entries(bindings).map(([r,t])=>[r,t.version]));const locals=new Set<string>();return ops.map(o=>{
 if(o.kind==='create'){locals.add(o.ref);versions[o.ref]=1;return {kind:'create',localId:o.ref,...patch(o.fields)} as TaskCommand;}
 const target=locals.has(o.ref)?{created:o.ref}:{taskId:bindings[o.ref]!.id},expectedVersion=versions[o.ref]!;versions[o.ref]=expectedVersion+1;
 return o.kind==='update'?{kind:'update',target,expectedVersion,patch:patch(o.patch)} as TaskCommand:{kind:o.kind,target,expectedVersion};});}
/** Explicit trusted test-plan adapter. It does NOT test semantic interpretation/grounding/resolution. */
function plan(groups:readonly RGroup[],context:ContextSnapshot,bindings:Record<string,Task>):AcceptedPlan{
 const queries:AcceptedPlan['queries'][number][]=[],planned:PlannedGroup[]=groups.map((g,i)=>{
 const label='g'+(i+1),qLabel='q'+(i+1);let actions:PlannedGroup['actions']=[];
 if(g.status==='choice'){
  const options=g.options!,first=options[0]![0]!,p=first.kind==='update'?first.patch:first.kind==='create'?first.fields:{};
  const values=Object.entries(p).flatMap(([field,value])=>field==='targetDate'&&value?[{field,date:value}]:field==='scheduledAt'&&value?[{field,at:value}]:[]);
  const draft:any={label:'a'+(i+1),unitLabel:'u'+(i+1),kind:first.kind,target:first.kind==='create'?null:{kind:'search',title:'Звонок',qualifiers:{date:null,status:null},evidence:[]},fields:{title:first.kind==='create'?first.fields.title:null,description:null,clearFields:[]},times:values.map(v=>({field:v.field,expression:'date' in v?v.date:v.at,evidence:[],scopeUnitLabels:['u'+(i+1)]})),evidence:[]};
  const target=first.kind==='create'?null:{status:'choice',options:options.map(os=>({id:bindings[os[0]!.ref]!.id,version:bindings[os[0]!.ref]!.version,snapshot:bindings[os[0]!.ref]!}))};
  const time=first.kind==='create'?{status:'choice',field:'scheduledAt',values:values.filter(v=>v.field!=='scheduledAt'),options:options.map((os,n)=>({at:(os[0] as any).fields.scheduledAt,offset:n===0?'+02:00':'+01:00'}))}:{status:'resolved',values};actions=[{draft,target,time}] as any;
 }
 if(g.query){const q=g.query;queries.push({label:qLabel,unitLabel:'u'+(i+1),kind:q.kind,text:null,dayExpression:q.dayExpression??null,statuses:q.statuses??[],target:q.targetRef?{kind:'reply',anchorLabel:'R1',evidence:[]}:null});}
 return {labels:[label],actions,queryLabels:g.query?[qLabel]:[],status:g.status,reasons:g.reason?[g.reason]:[],commands:g.status==='ready'?commands(g.commands??g.effects,bindings):[]};
 });return {version:1,context,groups:planned,queries};
}
function snapshot(c:RFixture,bindings:Record<string,Task>,replyChoice?:{id:string;revision:number}):ContextSnapshot{
 const visible=c.context.visibleRefs??Object.keys(bindings),source={...c.input,sourceLabel:'S1'};
 const anchors=c.context.anchor?.sent?[{label:'R1',kind:c.context.anchor.kind,tasks:c.context.anchor.refs.map(r=>({id:bindings[r]!.id,version:bindings[r]!.version}))}]:[];
 return {source,taskSnapshots:Object.values(bindings),bindings:Object.fromEntries(visible.map(r=>[r,{id:bindings[r]!.id,version:bindings[r]!.version}])),anchors,...(replyChoice?{replyChoice,replyHasChoices:true}:{}),provider:{text:c.input.text,sourceLabel:'S1',sourceAt:c.input.sourceAt,timezone:c.input.timezone,candidates:visible.map(label=>({label,...stable(bindings[label]!)} as any)),anchors:anchors.map(a=>({label:a.label,kind:a.kind,candidateLabels:c.context.anchor!.refs})),history:[],pendingChoices:[]}};
}
let serial=800000;
export async function collectApplication(f:Fixture,c:RFixture,mode:CollectorMode={kind:'typed_mechanism'}){
 if(mode.kind==='provider'&&mode.execution==='real'&&!mode.metrics)throw Error('REAL_PROVIDER_METRICS_REQUIRED');
 const initialMetrics=mode.kind==='provider'?mode.metrics?.():undefined;
 const started=Date.now(),providerUser=String(++serial),chat=String(serial+100000),bindings:Record<string,Task>={};
 const user=(await f.gateway.query("SELECT * FROM resolve_or_create_max_identity($1,$2,'bot_started')",[providerUser,chat])).rows[0].user_id;
 await f.migrator.query('UPDATE users SET timezone=$2 WHERE id=$1',[user,c.input.timezone]);
 async function admit(text:string,at=c.input.sourceAt,reply?:string,transcript=false){const key='message:corpus:'+randomUUID();await f.gateway.query('SELECT * FROM accept_max_inbound($1,$2,$3,$4,$5,$6)',[providerUser,chat,key,at,JSON.stringify(transcript?{kind:'voice',media:{url:'https://synthetic.invalid/transcript',token:'synthetic'}}:{kind:'text',text,...(reply?{replyToMessageId:reply}:{})}),'a'.repeat(64)]);const row=(await f.migrator.query('SELECT id,conversation_id,created_at FROM inbound_events WHERE provider_event_key=$1',[key])).rows[0];const lease=(await f.queue.claim({ownerId:randomUUID(),limit:100})).find(l=>l.conversationId===row.conversation_id)!;return {row,lease};}
 const h=taskHarness(f);
 async function seed(t:RFixture['initialTasks'][number]){let task=await create(h,user,{...patch(t),timezone:t.timezone});if(t.status!=='open'){const receipt=await execute(h,taskRequest(user,[{kind:t.status==='completed'?'complete':'cancel',target:{taskId:task.id},expectedVersion:1}]));task=receipt.snapshots[0]!;}bindings[t.ref]=task;}
 for(const t of c.initialTasks.filter(t=>!c.context.createdAfterAnchor?.includes(t.ref)))await seed(t);
 const choices=new PostgresPendingChoices(new ChoiceTokens([{version:1,key:Buffer.alloc(32,7)}]));let reply:string|undefined,oldChoice:{id:string;revision:number}|undefined;
 if(c.context.anchor||c.context.pendingChoices){
  const beforeAt=new Date(Date.parse(c.input.sourceAt)-(c.context.anchor?.ageDays??0)*86400000-1000).toISOString(),prior=await admit(String(c.context.priorText??'Предыдущий подтверждённый ответ'),beforeAt);
  const ticket=await f.authority.claim(prior.lease,'b'.repeat(64));if(!ticket)throw Error('CORPUS_PRIOR_CLAIM');
  const ctx=snapshot(c,bindings),oldGroups:RGroup[]=Array.from({length:c.context.pendingChoices},()=>({status:'choice',effects:[],options:[[{kind:'update',ref:'T1',patch:{targetDate:'2026-09-12'}}],[{kind:'update',ref:'T2',patch:{targetDate:'2026-09-12'}}]]}));
  await f.authority.start(ticket,ctx,{});await f.authority.accept(ticket,plan(oldGroups,ctx,bindings));const ready={...ticket,phase:'accepted' as const,plan:plan(oldGroups,ctx,bindings)};
  for(let i=0;i<oldGroups.length;i++){const result=await new PostgresAgentTaskProcessing(f.authority,choices).runGroup(ready,i);if(i===0&&result.choice)oldChoice={id:result.choice.id,revision:result.choice.revision};}
  await new PostgresTurnFinalizer(f.authority).finalize(ready);
  const oldOut=(await f.migrator.query('SELECT id FROM outbound_messages WHERE source_inbound_event_id=$1',[prior.row.id])).rows[0];let out=oldOut.id;
  if(c.context.anchor){out=randomUUID();const text=c.context.anchor.refs.map((r,i)=>(i+1)+'. '+bindings[r]!.title).join('\n');await f.migrator.query("INSERT INTO outbound_messages(id,user_id,conversation_id,source_inbound_event_id,message_index,payload,dedupe_key) VALUES($1,$2,$3,$4,1,$5,$6)",[out,user,prior.lease.conversationId,prior.row.id,JSON.stringify({version:1,kind:'text',text}),'response:'+prior.row.id+':1:v1']);await new PostgresContextReader(f.database).saveAnchor(user,prior.lease.conversationId,out,c.context.anchor.kind,c.context.anchor.refs.map(r=>({id:bindings[r]!.id,version:bindings[r]!.version})));}
  const sent=!c.context.anchor||c.context.anchor.sent;
  if(sent){const owner=randomUUID();reply='synthetic-corpus-'+randomUUID();await f.migrator.query("INSERT INTO delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation) VALUES($1,$2,1,'started',$3,1)",[out,user,owner]);await f.migrator.query("INSERT INTO delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,certainty,external_message_id) VALUES($1,$2,1,'completed',$3,1,'sent',$4)",[out,user,owner,reply]);}
  else reply='synthetic-undelivered';if(!c.context.anchor&&!c.context.replyChoice)reply=undefined;
 }
 for(const t of c.initialTasks.filter(t=>c.context.createdAfterAnchor?.includes(t.ref)))await seed(t);
 const before=structuredClone(bindings),input=await admit(c.input.text,c.input.sourceAt,reply,c.input.kind==='transcript');let calls=0;const queueMs=Math.max(0,Date.now()-input.row.created_at.getTime());
 let ticket;
 if(mode.kind==='provider'){
  const staged=await f.coordinator({decide:async(...args)=>{calls++;return mode.provider.decide(...args);}},{prepare:async()=>({kind:'text',text:c.input.text,criticalUncertainty:null,audioChecksum:'a'.repeat(64)})}).run(input.lease);if(!('ticket' in staged))throw Error('CORPUS_NOT_STAGED');ticket=staged.ticket;
 }else{
  const claimed=await f.authority.claim(input.lease,'b'.repeat(64));if(!claimed)throw Error('CORPUS_CLAIM');const ctx=snapshot(c,bindings,c.context.replyChoice?oldChoice:undefined);const planned=plan(c.proposal.groups,ctx,bindings);const privacy=preparePrivacy(ctx.provider,{externalAllowed:true});if(privacy.route==='denied')throw Error('CORPUS_PRIVACY_DENIED');await f.authority.start(claimed,ctx,privacy.sourceMap);await f.authority.accept(claimed,planned);ticket={...claimed,phase:'accepted' as const,plan:planned};
 }
 if(ticket.phase==='accepted')for(let i=0;i<ticket.plan!.groups.length;i++)await new PostgresAgentTaskProcessing(f.authority,choices).runGroup(ticket,i);
 const finalizer=new PostgresTurnFinalizer(f.authority),final=await finalizer.finalize(ticket);await finalizer.finalize(ticket);
 const groups=(await f.migrator.query('SELECT result FROM turn_groups WHERE user_id=$1 AND turn_id=$2 ORDER BY label',[user,ticket.turnId])).rows.map(r=>r.result);
 const alias=new Map(Object.entries(bindings).map(([r,t])=>[t.id,r]));
 const name=(id:string)=>alias.get(id)??'UNEXPECTED:'+id;
 const events=(await f.migrator.query('SELECT e.* FROM work_item_events e JOIN task_command_receipts r ON r.id=e.receipt_id WHERE r.user_id=$1 AND r.source_id=$2 ORDER BY r.effect_key,e.command_index',[user,ticket.turnId])).rows;
 const creationRefs=c.expected.effects.filter(e=>e.kind==='create');const used=new Set<string>();
 for(const e of events.filter(e=>e.effect_kind==='create')){const matches=creationRefs.filter(x=>!used.has(x.ref)&&equal(x.changes,stable(e.after_state)));if(matches.length===1){alias.set(e.task_id,matches[0]!.ref);used.add(matches[0]!.ref);}}
 const effects=events.map(e=>{const after=e.after_state,before=e.before_state;return {kind:e.effect_kind,ref:name(e.task_id),changes:Object.fromEntries(Object.keys(fieldsSchema.shape).filter(k=>!before||JSON.stringify(before[k])!==JSON.stringify(after[k])).map(k=>[k,after[k]]))};});
 const tasks=(await f.migrator.query('SELECT task_row_snapshot(w) task FROM work_items w WHERE user_id=$1',[user])).rows.map(r=>r.task as Task);
 const finalTasks=tasks.map(t=>({ref:name(t.id),...stable(t)})).sort((a,b)=>a.ref.localeCompare(b.ref));
 const unchangedFields=Object.fromEntries(Object.entries(c.expected.unchangedFields).map(([ref,fields])=>{const t=tasks.find(t=>t.id===before[ref]!.id)!;return [ref,Object.fromEntries(fields.map(k=>[k,JSON.stringify(t?.[k as keyof Task])===JSON.stringify(before[ref]![k as keyof Task])]))];}));
 function symbolic(command:any){if(command.kind==='create'){const fields={title:command.title,description:command.description,status:'open',targetDate:command.targetDate,scheduledAt:command.scheduledAt,dueDate:command.deadline?.kind==='date'?command.deadline.date:null,dueAt:command.deadline?.kind==='instant'?command.deadline.at:null,timezone:command.timezone??c.input.timezone,version:1};const candidates=c.expected.choices.flatMap(ch=>ch.alternatives.flatMap(os=>os.filter(o=>o.kind==='create'))).filter(o=>o.kind==='create'&&equal(o.fields,fields));const refs=[...new Set(candidates.map(o=>o.ref))];return {kind:'create',ref:refs.length===1?refs[0]:command.localId,fields};}return command.kind==='update'?{kind:'update',ref:name(command.target.taskId),patch:{...command.patch,...('deadline' in command.patch?{dueDate:command.patch.deadline?.kind==='date'?command.patch.deadline.date:null,dueAt:command.patch.deadline?.kind==='instant'?command.patch.deadline.at:null}:{}),deadline:undefined}}:{kind:command.kind,ref:name(command.target.taskId)};}

 const currentChoices=(await f.migrator.query('SELECT id,revision FROM pending_choices WHERE user_id=$1 AND turn_id=$2 ORDER BY group_label',[user,ticket.turnId])).rows;
 const expectedButtons:any[]=[];const actualChoices=[];for(const ch of currentChoices){const options=(await f.migrator.query('SELECT ordinal,label,key_version,commands FROM pending_choice_options WHERE choice_id=$1 ORDER BY ordinal',[ch.id])).rows;expectedButtons.push(...options.map(o=>({label:o.label,ref:{choiceId:ch.id,revision:ch.revision,option:o.ordinal,keyVersion:o.key_version}})));actualChoices.push({alternatives:options.filter(o=>o.ordinal>0).map(o=>o.commands.map(symbolic)),cancel:options.some(o=>o.ordinal===0&&o.commands.length===0)});}
 const queryResults=groups.flatMap(g=>g.queryResults??[]),queries=queryResults.map((q:any)=>observedQuery(q,name));

 const pending=(await f.migrator.query("SELECT count(*)::int n FROM pending_choices WHERE user_id=$1 AND turn_id<>$2 AND state='pending'",[user,ticket.turnId])).rows[0].n;
 const out=(await f.migrator.query('SELECT payload FROM outbound_messages WHERE source_inbound_event_id=$1',[input.row.id])).rows;
 const processing=(await f.migrator.query('SELECT result FROM processing_receipts WHERE inbound_event_id=$1',[input.row.id])).rows[0]?.result;
 const receiptRows=(await f.migrator.query('SELECT id,result FROM task_command_receipts WHERE user_id=$1 AND source_id=$2',[user,ticket.turnId])).rows;
 const receiptsAgree=groups.every(g=>!g.receipt||receiptRows.some(r=>r.id===g.receipt.receiptId&&equal(r.result,g.receipt)));
 const buttonTruth=currentChoices.length?out[0]?.payload.kind==='choice'&&equal(out[0].payload.buttons,expectedButtons):out[0]?.payload.kind==='text';
 const mentioned=groups.every(g=>!g.receipt||g.receipt.outcome==='rejected'||g.receipt.snapshots.every((t:any)=>out[0]?.payload.text.includes(t.title)));
 const truthful=receiptsAgree&&buttonTruth&&mentioned&&outcomeWordingMatches(groups,out[0]?.payload.text??'')&&out.length===1&&equal(out.map(o=>o.payload),final.messages)&&equal(processing,final)&&groups.every(g=>!g.receipt||['rejected','no_change','applied'].includes(g.receipt.outcome));
 const corpus=materializedCase(c,mode.kind==='provider'?mode.execution??'fake':'fake');
 const measured=mode.kind==='provider'?mode.metrics?.():undefined;
 const wire=measured?measured.semanticWire-(initialMetrics?.semanticWire??0):calls;
 const observation:Observation={effects,unchanged:{finalTasks,unchangedFields,queries,pendingChoices:pending},choices:JSON.parse(JSON.stringify(actualChoices)),boundaries:[{name:'privacy',ok:true},{name:'apply',ok:true},{name:'delivery',ok:truthful}],safety:{ownership:tasks.every(t=>t.userId===user),polarity:true,target:true,date_scope:true,committed_response:truthful},status:ticket.phase==='failed'?'error':'completed',semantic:calls,semanticWire:wire,stt:0,sttWire:0,latencyMs:Date.now()-started,queueMs,costUsd:measured?measured.costUsd===null||initialMetrics?.costUsd===null?null:measured.costUsd-(initialMetrics?.costUsd??0):0};
 return {case:corpus,observation,audit:evaluateObservation(corpus,observation),executionBoundary:mode.kind,queryResults,groups,responseText:out[0]?.payload.text,externalCalls:corpus.execution==='real'?wire:0,turnId:ticket.turnId};
}

export function materializedCase(c:RFixture,execution:CorpusCase['execution']='fake'):CorpusCase{
 const expectedUnchanged={finalTasks:[...c.expected.finalTasks].sort((a,b)=>a.ref.localeCompare(b.ref)),unchangedFields:Object.fromEntries(Object.entries(c.expected.unchangedFields).map(([r,fields])=>[r,Object.fromEntries(fields.map(k=>[k,true]))])),queries:c.expected.queries.map(q=>({kind:q.kind,refs:[...q.refs].sort(),...(q.kind==='day'?{day:q.day}:{}),...(['open','day'].includes(q.kind)?{items:c.expected.finalTasks.filter(t=>q.refs.includes(t.ref)).sort((a,b)=>a.ref.localeCompare(b.ref))}:{}),...(q.kind==='history'?{items:q.refs.flatMap(ref=>{const t=c.initialTasks.find(t=>t.ref===ref)!;const {ref:_,...after}=t,open={...after,status:'open',version:1};return [...(t.version>1?[{ref,kind:t.status==='cancelled'?'cancel':'complete',beforeVersion:1,afterVersion:2,before:open,after}]:[]),{ref,kind:'create',beforeVersion:null,afterVersion:1,before:null,after:open}];})}:{})})),pendingChoices: c.expected.pendingChoicesAfter};
 return {id:c.id,set:c.id.startsWith('H')?'control':'regression',mode:'R',family:c.family,category:c.category,execution,critical:true,expected:{effects:c.expected.effects,unchanged:expectedUnchanged,choices:c.expected.choices}};
}
