import {randomUUID} from 'node:crypto';
import {PostgresConversationQueue} from '../../src/infrastructure/postgres/postgres-conversation-queue.js';
import {PostgresAtomicProcessing} from '../../src/infrastructure/postgres/postgres-atomic-processing.js';
import {PostgresOrderedHead} from '../../src/infrastructure/postgres/postgres-ordered-head.js';
import {PostgresFencedConversation} from '../../src/infrastructure/postgres/postgres-fenced-conversation.js';
import {PostgresTypedTaskProcessing} from '../../src/infrastructure/postgres/postgres-typed-task-processing.js';
import {ProcessInbound} from '../../src/modules/intake/application/process-inbound.js';
import {FoundationInboundHandler} from '../../src/modules/intake/application/inbound-handler.js';
import {taskRequest} from './task-command-fixtures.js';
import type {taskFixture} from './task-fixture.js';
let serial=9800;
export function processingFixture(f:Awaited<ReturnType<typeof taskFixture>>){
 const queue=new PostgresConversationQueue(f.database),ownerId=randomUUID();
 async function admit(commands:readonly unknown[],providerUser='301',chat=String(++serial)){
  const key='message:typed:'+randomUUID();
  await f.gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',[providerUser,chat,key,'2026-10-14T09:00:00Z',JSON.stringify({kind:'text',text:'typed fixture'}),'a'.repeat(64)]);
  const event=(await f.postgres.pool.query('SELECT * FROM public.inbound_events WHERE provider_event_key=$1',[key])).rows[0];
  const lease=(await queue.claim({ownerId,limit:100})).find(l=>l.conversationId===event.conversation_id)!;
  const request=taskRequest(lease.userId,commands,'turn:'+event.id);
  return {lease,event,request};
 }
 function runner(input:Awaited<ReturnType<typeof admit>>,db=f.database,typed=true){
  const bridge=new PostgresTypedTaskProcessing(()=>({group:input.request.group,intents:input.request.context.intents}));
  return new ProcessInbound(new PostgresAtomicProcessing(new PostgresOrderedHead(new PostgresFencedConversation(db)),typed?bridge:undefined),new FoundationInboundHandler());
 }
 async function counts(){return (await f.postgres.pool.query(`SELECT
 (SELECT count(*)::int FROM work_items) tasks,(SELECT count(*)::int FROM work_item_events) events,
 (SELECT count(*)::int FROM task_command_receipts) task_receipts,(SELECT count(*)::int FROM processing_receipts) processing,
 (SELECT count(*)::int FROM outbound_messages) outbox,(SELECT count(*)::int FROM delivery_work) delivery`)).rows[0];}
 return {queue,ownerId,admit,runner,counts};
}
