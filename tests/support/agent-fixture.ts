import {randomBytes,randomUUID} from 'node:crypto';
import {taskFixture} from './task-fixture.js';
import {PostgresConversationQueue} from '../../src/infrastructure/postgres/postgres-conversation-queue.js';
import {frame} from './semantic-frame.js';
import {projectLegacyQuotes} from './semantic-replay.js';
import {parseMeaningDraft} from '../../src/modules/semantic/domain/meaning-decision.js';
import {TurnStore} from '../../src/infrastructure/postgres/agent/turn-store.js';
import {PostgresTurnAuthority} from '../../src/infrastructure/postgres/agent/turn-claim.js';
import {ContextBuilder} from '../../src/modules/context/application/context-builder.js';
import {PostgresContextReader} from '../../src/infrastructure/postgres/context/context-reader.js';
import {TaskQueries} from '../../src/modules/tasks/application/task-queries.js';
import {PostgresTaskReadRunner} from '../../src/infrastructure/postgres/tasks/task-read-model.js';
import {IanaTimeResolver} from '../../src/infrastructure/time/iana-time-resolver.js';
import {TurnCoordinator} from '../../src/modules/agent/application/turn-coordinator.js';
import type {AiDecisionProvider} from '../../src/modules/semantic/application/provider-port.js';
let chatSequence=12000;
export async function agentFixture(){
 const f=await taskFixture(),queue=new PostgresConversationQueue(f.database),keys=[{version:1,key:randomBytes(32)}];
 const authority=new PostgresTurnAuthority(f.database,new TurnStore(f.database,keys),randomBytes(32));
 const time=new IanaTimeResolver(),tasks=new TaskQueries(new PostgresTaskReadRunner(f.database),time),context=new ContextBuilder(tasks,new PostgresContextReader(f.database));
 const fake:AiDecisionProvider={decide:async ctx=>({outcome:'ok',decision:parseMeaningDraft(projectLegacyQuotes(frame(ctx.pack.text).grounded.decision)),durationMs:1,model:'fake',usage:null})};
 const coordinator=(provider:AiDecisionProvider=fake)=>new TurnCoordinator(authority,context,tasks,time,provider,{profileDigest:'b'.repeat(64),externalAllowed:true,deadlineMs:7000});
 async function admit(text='Купи молоко',chat=String(++chatSequence),providerUser='301'){
  const key='message:agent:'+randomUUID();await f.gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',[providerUser,chat,key,'2026-09-11T12:48:33Z',JSON.stringify({kind:'text',text}),'a'.repeat(64)]);
  const event=(await f.postgres.pool.query('SELECT * FROM inbound_events WHERE provider_event_key=$1',[key])).rows[0];
  const lease=(await queue.claim({ownerId:randomUUID(),limit:100})).find(l=>l.conversationId===event.conversation_id)!;return {lease,event,chat};
 }
 return {...f,queue,authority,tasks,time,context,coordinator,fake,admit};
}
