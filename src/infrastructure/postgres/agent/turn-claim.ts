import {createHash,randomUUID} from 'node:crypto';
import type {Database,DbTx} from '../database.js';
import {PostgresOrderedHead} from '../postgres-ordered-head.js';
import {PostgresFencedConversation} from '../postgres-fenced-conversation.js';
import type {TurnAuthority,TurnTicket,AcceptedPlan} from '../../../modules/agent/application/turn-port.js';
import type {ConversationLease} from '../../../modules/intake/application/conversation-queue.js';
import type {InboundEvent} from '../../../modules/intake/domain/inbound-event.js';
import {TurnStore} from './turn-store.js';
import {sealSourceMap} from '../privacy/token-map.js';
export const sourceDigest=(event:InboundEvent)=>createHash('sha256').update(JSON.stringify([event.rawSha256,event.occurredAt.toISOString(),event.timezoneSnapshot,event.payload])).digest('hex');
export class PostgresTurnAuthority implements TurnAuthority {
 readonly ordered:PostgresOrderedHead;
 constructor(readonly database:Database,private readonly turns:TurnStore,private readonly mapKey:Buffer){this.ordered=new PostgresOrderedHead(new PostgresFencedConversation(database));}
 async peek(lease:ConversationLease){const result=await this.ordered.run(lease,async({event})=>({value:event.payload.kind,disposition:{kind:'keep' as const}}));return result.kind==='actionable'?result.value:null;}
 async claim(lease:ConversationLease,profileDigest:string):Promise<TurnTicket|null>{
  if(!/^[a-f0-9]{64}$/.test(profileDigest))throw Error('AGENT_PROFILE_INVALID');
  const result=await this.ordered.run(lease,async({event},tx)=>{
   const source={text:event.payload.kind==='text'?event.payload.text:'',sourceLabel:'S1',sourceAt:event.occurredAt.toISOString(),timezone:event.timezoneSnapshot,...('replyToMessageId' in event.payload?{replyMessageId:event.payload.replyToMessageId}:{})};
   const turn=await this.turns.beginWith(tx,{userId:event.userId,sourceKey:event.providerEventKey,sourceEventId:event.id,sourceConversationId:event.conversationId,snapshot:{source}});
   if(turn.completed)return {value:{turnId:turn.turnId,runId:'',event,lease,sourceDigest:sourceDigest(event),profileDigest,phase:'completed' as const,plan:null},disposition:{kind:'keep' as const}};
   await tx.query(`INSERT INTO public.agent_runs(user_id,turn_id,run_id,source_event_id,conversation_id,generation,source_digest,profile_digest,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'claimed') ON CONFLICT(user_id,turn_id) DO NOTHING`,[event.userId,turn.turnId,randomUUID(),event.id,event.conversationId,lease.leaseGeneration.toString(),sourceDigest(event),profileDigest]);
   const [run]=await tx.query<{run_id:string;phase:TurnTicket['phase'];source_digest:string;profile_digest:string;plan:AcceptedPlan|null}>('SELECT r.*,d.plan FROM public.agent_runs r LEFT JOIN public.accepted_decisions d USING(user_id,turn_id) WHERE r.user_id=$1 AND r.turn_id=$2 FOR UPDATE OF r',[event.userId,turn.turnId]);
   if(!run||run.source_digest!==sourceDigest(event)||run.profile_digest!==profileDigest)throw Error('AGENT_SOURCE_PROFILE_CHANGED');
   // A prior dispatch without durable acceptance is uncertain, even if its lease was still live.
   const phase=run.phase==='started'?'failed':run.phase;
   await tx.query("UPDATE public.agent_runs SET generation=$3,phase=$4,failure_code=CASE WHEN phase='started' THEN 'provider_uncertain' ELSE failure_code END WHERE user_id=$1 AND turn_id=$2",[event.userId,turn.turnId,lease.leaseGeneration.toString(),phase]);
   return {value:{turnId:turn.turnId,runId:run.run_id,event,lease,sourceDigest:run.source_digest,profileDigest:run.profile_digest,phase,plan:run.plan},disposition:{kind:'keep' as const}};
  });return result.kind==='actionable'?result.value:null;
 }
 async guarded<T>(ticket:TurnTicket,fn:(tx:DbTx,event:InboundEvent)=>Promise<T>,finish=false):Promise<T>{
  const result=await this.ordered.run(ticket.lease,async({event},tx)=>{
   if(sourceDigest(event)!==ticket.sourceDigest)throw Error('AGENT_SOURCE_CHANGED');
   if(ticket.phase==='completed'){const saved=await this.turns.beginWith(tx,{userId:event.userId,sourceKey:event.providerEventKey,snapshot:{},sourceEventId:event.id,sourceConversationId:event.conversationId});if(!saved.completed||saved.turnId!==ticket.turnId)throw Error('AGENT_DUPLICATE_INVALID');}
   const [run]=await tx.query<{generation:string;profile_digest:string;source_event_id:string;run_id:string}>('SELECT generation,profile_digest,source_event_id,run_id FROM public.agent_runs WHERE user_id=$1 AND turn_id=$2 FOR UPDATE',[event.userId,ticket.turnId]);
   if(ticket.phase!=='completed'&&(!run||run.run_id!==ticket.runId||run.generation!==ticket.lease.leaseGeneration.toString()||run.profile_digest!==ticket.profileDigest||run.source_event_id!==event.id))throw Error('AGENT_AUTHORITY_LOST');
   const value=await fn(tx,event);const [counter]=finish?await tx.query<{more:boolean}>('SELECT next_apply_sequence<next_inbound_sequence AS more FROM public.conversations WHERE user_id=$1 AND id=$2',[event.userId,event.conversationId]):[];return {value,disposition:finish?(counter?.more?{kind:'ready' as const}:{kind:'sleep' as const}):{kind:'keep' as const}};
  },{id:ticket.event.id,sequence:ticket.event.sequence});if(result.kind!=='actionable')throw Error('AGENT_HEAD_LOST');return result.value;
 }
 async start(ticket:TurnTicket,context:unknown,sourceMap:unknown){await this.guarded(ticket,async tx=>{
  const rows=await tx.query("UPDATE public.agent_runs SET phase='started',prepared_context=$3 WHERE user_id=$1 AND turn_id=$2 AND phase='claimed' RETURNING run_id",[ticket.event.userId,ticket.turnId,JSON.stringify(context)]);if(rows.length!==1)throw Error('AGENT_DISPATCH_ALREADY_STARTED');
  const expires=Date.now()+30*60000;await tx.query('INSERT INTO public.run_token_maps(user_id,run_id,ciphertext,expires_at) VALUES($1,$2,$3,$4)',[ticket.event.userId,ticket.runId,JSON.stringify(sealSourceMap(sourceMap,this.mapKey,expires)),new Date(expires)]);
 });}
 async accept(ticket:TurnTicket,plan:AcceptedPlan){await this.guarded(ticket,async tx=>{
  const changed=await tx.query("UPDATE public.agent_runs SET phase='accepted' WHERE user_id=$1 AND turn_id=$2 AND phase='started' RETURNING run_id",[ticket.event.userId,ticket.turnId]);if(changed.length!==1)throw Error('AGENT_STAGE_CLOSED');
  await tx.query('INSERT INTO public.accepted_decisions(user_id,turn_id,run_id,plan) VALUES($1,$2,$3,$4)',[ticket.event.userId,ticket.turnId,ticket.runId,JSON.stringify(plan)]);
 });}
 async fail(ticket:TurnTicket,reason:string){await this.guarded(ticket,async tx=>{await tx.query("UPDATE public.agent_runs SET phase='failed',failure_code=$3 WHERE user_id=$1 AND turn_id=$2 AND phase IN('claimed','started')",[ticket.event.userId,ticket.turnId,/^[a-z_]{1,80}$/.test(reason)?reason:'invalid_decision']);});}
}
