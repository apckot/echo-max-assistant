import {randomUUID} from 'node:crypto';
import {agentFixture} from './agent-fixture.js';
import {create,taskHarness} from './task-command-fixtures.js';
import {parseMeaningDraft} from '../../src/modules/semantic/domain/meaning-decision.js';
import {ChoiceTokens,PostgresPendingChoices} from '../../src/infrastructure/postgres/agent/pending-choice.js';
import {PostgresAgentTaskProcessing} from '../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {PostgresTurnFinalizer} from '../../src/infrastructure/postgres/agent/response-intent.js';
import {PostgresChoiceProcessor} from '../../src/infrastructure/postgres/agent/choice-processing.js';
export async function choiceFixture(){
 const f=await agentFixture(),tokens=new ChoiceTokens([{version:1,key:Buffer.alloc(32,7)}]),choices=new PostgresPendingChoices(tokens);
 const tasks=[await create(taskHarness(f),f.a,{title:'Звонок поставщику'}),await create(taskHarness(f),f.a,{title:'Звонок коллеге'})];
 const text='Перенеси звонок на завтра',evidence=[{sourceLabel:'S1',quote:text}];
 const decision=parseMeaningDraft({version:2,units:[{label:'u1',kind:'action',speechAct:'request',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence,uncertainty:null}],actions:[{label:'a1',unitLabel:'u1',kind:'update',target:{kind:'search',title:'звонок',qualifiers:{date:null,status:null},evidence},fields:{title:null,description:null,clearFields:[]},times:[{field:'targetDate',expression:'завтра',evidence,scopeUnitLabels:['u1']}],evidence}],relations:[],queries:[],groups:[{label:'g1',unitLabels:['u1'],actionLabels:['a1'],queryLabels:[],outcome:'needs_choice',reason:'target'}]});
 const input=await f.admit(text),staged=await f.coordinator({decide:async()=>({outcome:'ok',decision,model:'fake',durationMs:1,usage:null})}).run(input.lease);if(staged.status!=='accepted')throw Error('fixture stage');
 const group=await new PostgresAgentTaskProcessing(f.authority,choices).runGroup(staged.ticket,0);
 await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket);
 const out=(await f.migrator.query('SELECT id,payload FROM outbound_messages WHERE source_inbound_event_id=$1',[input.event.id])).rows[0];
 async function confirm(mid='synthetic-choice-message',outboundId=out.id){
 const owner=randomUUID();await f.migrator.query(`INSERT INTO delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation) VALUES($1,$2,1,'started',$3,1)`,[outboundId,f.a,owner]);
 await f.migrator.query(`INSERT INTO delivery_attempts(outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,certainty,external_message_id) VALUES($1,$2,1,'completed',$3,1,'sent',$4)`,[outboundId,f.a,owner,mid]);return mid;
 }
 const processor=new PostgresChoiceProcessor(f.authority.ordered,choices);
 async function callback(option=1,mid='synthetic-choice-message',user='301',chat=input.chat){const ref=group.choice!.options[option]!.ref;return f.admit('',chat,user,{kind:'button',callbackPayload:'ch1.'+tokens.hash(tokens.encode(ref)),callbackMessageId:mid});}
 async function anotherChoice(extraCreate=false){
  const extraEvidence=[{sourceLabel:'S1',quote:'Купи молоко'}];
  const nextDecision=extraCreate?parseMeaningDraft({...decision,units:[...decision.units,{label:'u2',kind:'action',speechAct:'request',polarity:'positive',modality:'asserted',authoredByOwner:true,evidence:extraEvidence,uncertainty:null}],actions:[...decision.actions,{label:'a2',unitLabel:'u2',kind:'create',target:null,fields:{title:'Молоко',description:null,clearFields:[]},times:[],evidence:extraEvidence}],groups:[...decision.groups,{label:'g2',unitLabels:['u2'],actionLabels:['a2'],queryLabels:[],outcome:'execute',reason:null}]}):decision;
  const next=await f.admit(extraCreate?'Купи молоко и '+text:text,input.chat),staged=await f.coordinator({decide:async()=>({outcome:'ok',decision:nextDecision,model:'fake',durationMs:0,usage:null})}).run(next.lease);if(staged.status!=='accepted')throw Error('choice');
  const group=await new PostgresAgentTaskProcessing(f.authority,choices).runGroup(staged.ticket,0);
  for(let i=1;i<staged.ticket.plan!.groups.length;i++)await new PostgresAgentTaskProcessing(f.authority,choices).runGroup(staged.ticket,i);
  await new PostgresTurnFinalizer(f.authority).finalize(staged.ticket);const out=(await f.migrator.query('SELECT id,payload FROM outbound_messages WHERE source_inbound_event_id=$1',[next.event.id])).rows[0];return {input:next,group,out};
 }
 return {...f,anotherChoice,tokens,choices,tasks,input,group,out,confirm,processor,callback};
}
