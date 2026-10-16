import type {AiDecisionProvider} from '../../src/modules/semantic/application/provider-port.js';
import {test,expect} from 'vitest';
import {choiceFixture} from '../support/choice-fixture.js';
import {PostgresAgentTaskProcessing} from '../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {PostgresTurnFinalizer} from '../../src/infrastructure/postgres/agent/response-intent.js';
import {parseMeaningDraft} from '../../src/modules/semantic/domain/meaning-decision.js';
import {frame} from '../support/semantic-frame.js';
import {projectLegacyQuotes} from '../support/semantic-replay.js';
const createProvider=(title:string):AiDecisionProvider=>({decide:async ctx=>{const draft=parseMeaningDraft(projectLegacyQuotes(frame(ctx.pack.text).grounded.decision));return {outcome:'ok' as const,decision:parseMeaningDraft({...draft,actions:draft.actions.map(a=>({...a,fields:{...a.fields,title}}))}),model:'fake',durationMs:0,usage:null};}});
async function finish(f:Awaited<ReturnType<typeof choiceFixture>>,input:Awaited<ReturnType<Awaited<ReturnType<typeof choiceFixture>>['admit']>>,provider=createProvider('Хлеб'),voice?:any){const staged=await f.coordinator(provider,voice).run(input.lease);if(staged.status!=='accepted')throw Error('stage '+staged.status);for(let i=0;i<staged.ticket.plan!.groups.length;i++)await new PostgresAgentTaskProcessing(f.authority,f.choices).runGroup(staged.ticket,i);return {staged,result:await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket)};}
test('three delivered choices never capture independent text or voice; only committed new intent supersedes exact reply',async()=>{
 const f=await choiceFixture();try{
 await f.confirm();const second=await f.anotherChoice(),third=await f.anotherChoice();await f.confirm('second-choice',second.out.id);await f.confirm('third-choice',third.out.id);
 const text=await f.admit('Купи хлеб',f.input.chat);await finish(f,text);expect((await f.migrator.query("SELECT count(*)::int n FROM pending_choices WHERE state='pending'")).rows[0].n).toBe(3);
 const voice=await f.admit('',f.input.chat,'301',{kind:'voice',media:{url:'https://synthetic.invalid/file',token:'synthetic'}});await finish(f,voice,createProvider('Масло'),{prepare:async()=>({kind:'text',text:'Купи масло',criticalUncertainty:null})});expect((await f.migrator.query("SELECT count(*)::int n FROM pending_choices WHERE state='pending'")).rows[0].n).toBe(3);
 const independent=(await f.migrator.query("SELECT title FROM work_items WHERE title IN('Хлеб','Масло') ORDER BY title")).rows;expect(independent).toEqual([{title:'Масло'},{title:'Хлеб'}]);
 }finally{await f.close();}
},120000);
test('unbound yes/ordinal never become consent or a task even with an incorrect fake create',async()=>{
 const f=await choiceFixture();try{await f.confirm();const before=(await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n;
 for(const text of ['Да','Второй','1','2','3','4','5','четвёртая','четвёртое','пятая','пятое']){const input=await f.admit(text,f.input.chat),done=await finish(f,input,createProvider('Wrong phantom'));expect(done.staged.ticket.plan!.groups.every(g=>g.status==='blocked')).toBe(true);}
 expect((await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n).toBe(before);expect((await f.migrator.query('SELECT state FROM pending_choices')).rows[0].state).toBe('pending');
 }finally{await f.close();}
},120000);
test('exact reply new intent replaces pending only after committed finalization; old token stays stale',async()=>{
 const f=await choiceFixture();try{await f.confirm();const input=await f.admit('Создай задачу купить хлеб',f.input.chat,'301',{kind:'text',text:'Создай задачу купить хлеб',replyToMessageId:'synthetic-choice-message'});
 const staged=await f.coordinator(createProvider('Хлеб')).run(input.lease);expect(staged.status).toBe('accepted');if(staged.status!=='accepted')throw Error('stage');await new PostgresAgentTaskProcessing(f.authority,f.choices).runGroup(staged.ticket,0);
 expect((await f.migrator.query('SELECT state FROM pending_choices')).rows[0].state).toBe('pending');await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket);expect((await f.migrator.query('SELECT state FROM pending_choices')).rows[0].state).toBe('superseded');
 const before=(await f.migrator.query('SELECT count(*) n FROM work_item_events')).rows;await f.processor.run((await f.callback()).lease);expect((await f.migrator.query('SELECT count(*) n FROM work_item_events')).rows).toEqual(before);
 }finally{await f.close();}
},120000);
test('stop during FakeAI cannot stage or apply a late new Task; restart finalizes safely without another AI call',async()=>{
 const f=await choiceFixture();try{const input=await f.admit('Купи молоко',f.input.chat);let entered!:()=>void,release!:()=>void,calls=0;const ready=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 const work=f.coordinator({decide:async(...args)=>{calls++;entered();await hold;return f.fake.decide(...args);}}).run(input.lease);await ready;await f.migrator.query("UPDATE conversations SET state='stopped' WHERE id=$1",[input.lease.conversationId]);release();const staged=await work.catch(()=>null);
 if(staged?.status==='accepted')await new PostgresAgentTaskProcessing(f.authority,f.choices).runGroup(staged.ticket,0);
 expect((await f.migrator.query('SELECT count(*)::int n FROM work_items')).rows[0].n).toBe(2);
 const resumed=await f.coordinator({decide:async()=>{throw Error('must not redispatch');}}).run(input.lease);expect(resumed.status).toBe('failed');if('ticket' in resumed)await new PostgresTurnFinalizer(f.authority).finalize(resumed.ticket);expect(calls).toBe(1);
 }finally{await f.close();}
},120000);
test('two real IANA fold alternatives persist typed commands and selected callback creates exactly one scheduled Task',async()=>{
 const f=await choiceFixture();try{
 await f.migrator.query("UPDATE users SET timezone='America/New_York' WHERE id=$1",[f.a]);const text='Создай задачу встреча 2026-11-01 в01:30',input=await f.admit(text,f.input.chat);
 const draft=parseMeaningDraft(projectLegacyQuotes(frame(text,'create',{field:'scheduledAt',expression:'2026-11-01 в01:30'}).grounded.decision));const decision=parseMeaningDraft({...draft,actions:draft.actions.map(a=>({...a,fields:{...a.fields,title:'Встреча'}}))});
 const staged=await f.coordinator({decide:async()=>({outcome:'ok',decision,model:'fake',durationMs:0,usage:null})}).run(input.lease);if(staged.status!=='accepted')throw Error('stage');
 const result=await new PostgresAgentTaskProcessing(f.authority,f.choices).runGroup(staged.ticket,0);expect(result.choice!.options).toHaveLength(3);expect(result.choice!.options.map(o=>o.label).join(' ')).toContain('UTC-04:00');expect(result.choice!.options.map(o=>o.label).join(' ')).toContain('UTC-05:00');
 await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket);const out=(await f.migrator.query('SELECT id FROM outbound_messages WHERE source_inbound_event_id=$1',[input.event.id])).rows[0];await f.confirm('fold-choice',out.id);
 const ref=result.choice!.options[1]!.ref,callback=await f.admit('',f.input.chat,'301',{kind:'button',callbackMessageId:'fold-choice',callbackPayload:'ch1.'+f.tokens.hash(f.tokens.encode(ref))});await f.processor.run(callback.lease);
 expect((await f.migrator.query("SELECT source_id FROM task_command_receipts WHERE effect_key LIKE 'choice:%'")).rows[0].source_id).toBe(staged.ticket.turnId);
 const tasks=(await f.migrator.query("SELECT scheduled_at FROM work_items WHERE title='Встреча'")).rows;expect(tasks).toHaveLength(1);expect(tasks[0].scheduled_at.toISOString()).toBe('2026-11-01T05:30:00.000Z');
 }finally{await f.close();}
},120000);
test('missing message binding, forged revision and another conversation never consume saved token',async()=>{
 const f=await choiceFixture();try{await f.confirm();const ref=f.group.choice!.options[1]!.ref,before=(await f.migrator.query('SELECT count(*) n FROM work_item_events')).rows;
 for(const kind of ['missing','revision','conversation']){
 const token=f.tokens.encode({...ref,revision:kind==='revision'?2:ref.revision});const input=await f.admit('',kind==='conversation'?'68701':f.input.chat,'301',{kind:'button',callbackPayload:'ch1.'+f.tokens.hash(token),...(kind==='missing'?{}:{callbackMessageId:'synthetic-choice-message'})});await f.processor.run(input.lease);expect((await f.migrator.query('SELECT count(*) n FROM work_item_events')).rows).toEqual(before);
 }
 expect((await f.migrator.query('SELECT state FROM pending_choices')).rows[0].state).toBe('pending');
 }finally{await f.close();}
},120000);
test('mixed committed Task plus pending choice is not a unique pronoun target even if model chooses its candidate label',async()=>{
 const f=await choiceFixture();try{const mixed=await f.anotherChoice(true);await f.confirm('mixed-choice',mixed.out.id);const input=await f.admit('Её заверши',f.input.chat,'301',{kind:'text',text:'Её заверши',replyToMessageId:'mixed-choice'});
 const base=parseMeaningDraft(projectLegacyQuotes(frame('Её заверши','complete').grounded.decision));const decision=parseMeaningDraft({...base,actions:base.actions.map(a=>({...a,target:{kind:'candidate',label:'T1',evidence:[{sourceLabel:'S1',quote:'Её'}]}}))});const provider:AiDecisionProvider={decide:async()=>({outcome:'ok',decision,model:'fake-adversary',durationMs:0,usage:null})};const staged=await f.coordinator(provider).run(input.lease);if(staged.status!=='accepted')throw Error('stage');expect(staged.ticket.plan!.groups[0]!.status).toBe('blocked');expect(staged.ticket.plan!.groups[0]!.commands).toEqual([]);
 expect((await f.migrator.query("SELECT status,version FROM work_items WHERE title='Молоко'")).rows).toEqual([{status:'open',version:1}]);
 }finally{await f.close();}
},120000);

test('delivered callback confirmation preserves exact Task/version anchor for a subsequent pronoun command',async()=>{
 const f=await choiceFixture();try{await f.confirm();const callback=await f.callback();await f.processor.run(callback.lease);
 const out=(await f.migrator.query('SELECT id FROM outbound_messages WHERE source_inbound_event_id=$1',[callback.event.id])).rows[0];await f.confirm('callback-confirmation',out.id);
 const input=await f.admit('Её заверши',f.input.chat,'301',{kind:'text',text:'Её заверши',replyToMessageId:'callback-confirmation'});
 const base=parseMeaningDraft(projectLegacyQuotes(frame('Её заверши','complete').grounded.decision));
 const decision=parseMeaningDraft({...base,actions:base.actions.map(a=>({...a,target:{kind:'candidate',label:'T1',evidence:[{sourceLabel:'S1',quote:'Её'}]}}))});
 const staged=await f.coordinator({decide:async()=>({outcome:'ok',decision,model:'fake',durationMs:0,usage:null})}).run(input.lease);
 expect(staged.status).toBe('accepted');if(staged.status!=='accepted')throw Error('missing callback anchor');
 const result=await new PostgresAgentTaskProcessing(f.authority,f.choices).runGroup(staged.ticket,0);expect(result.outcome).toBe('applied');await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket);
 const selected=(await f.migrator.query('SELECT commands FROM pending_choice_options WHERE choice_id=$1 AND ordinal=1',[f.group.choice!.id])).rows[0].commands[0].target.taskId;
 expect((await f.migrator.query('SELECT status,version FROM work_items WHERE id=$1',[selected])).rows).toEqual([{status:'completed',version:3}]);
 expect((await f.migrator.query('SELECT status,version FROM work_items WHERE id<>$1',[selected])).rows).toEqual([{status:'open',version:1}]);
 }finally{await f.close();}
},120000);
