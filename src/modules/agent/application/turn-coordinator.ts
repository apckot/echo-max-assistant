import {withDeadline} from '../../../shared/time/deadline.js';
import type {TurnAuthority,TurnTicket,AcceptedPlan} from './turn-port.js';
import type {ConversationLease} from '../../intake/application/conversation-queue.js';
import type {ContextBuilder} from '../../context/application/context-builder.js';
import type {TaskQueries} from '../../tasks/application/task-queries.js';
import type {TemporalPort} from '../../tasks/application/temporal-port.js';
import type {AiDecisionProvider} from '../../semantic/application/provider-port.js';
import {taskRegistry} from '../../semantic/application/provider-port.js';
import {preparePrivacy} from '../../privacy/application/privacy-gateway.js';
import {groundMeaningDraft} from '../../semantic/application/quote-grounding.js';
import {validateDecision,resolveDecision} from '../../semantic/application/decision-validator.js';
import {TargetResolver,taskTargetSearch} from '../../semantic/application/target-resolver.js';
import {TemporalNormalizer} from '../../semantic/application/temporal-normalizer.js';
export interface CoordinatorProfile {readonly profileDigest:string;readonly externalAllowed:boolean;readonly deadlineMs:number}
export type StagedTurn={readonly status:'accepted'|'failed';readonly ticket:TurnTicket}|{readonly status:'idle'|'busy'};
export class TurnCoordinator {
 private active=0;
 constructor(private readonly authority:TurnAuthority,private readonly context:ContextBuilder,private readonly tasks:TaskQueries,private readonly time:TemporalPort,private readonly provider:AiDecisionProvider,private readonly profile:CoordinatorProfile){}
 async run(lease:ConversationLease):Promise<StagedTurn>{
  if(this.active>=4)return {status:'busy'};this.active++;
  try{
   const ticket=await this.authority.claim(lease,this.profile.profileDigest);if(!ticket)return {status:'idle'};
   if(ticket.phase==='accepted'||ticket.phase==='failed')return {status:ticket.phase,ticket};
   const event=ticket.event;
   if(event.payload.kind!=='text'){await this.authority.fail(ticket,'unsupported_source');return {status:'failed',ticket};}
   let plan:AcceptedPlan;
   // Local failures have safe classifications; DB authority failures are never swallowed or retried.
   let prepared:Awaited<ReturnType<ContextBuilder['build']>>;
   try{prepared=await this.context.build(event.userId,event.conversationId,{text:event.payload.text,sourceLabel:'S1',sourceAt:event.occurredAt.toISOString(),timezone:event.timezoneSnapshot,...(event.payload.replyToMessageId?{replyMessageId:event.payload.replyToMessageId}:{})});}
   catch{await this.authority.fail(ticket,'context_unavailable');return {status:'failed',ticket};}
   const privacy=preparePrivacy(prepared.provider,{externalAllowed:this.profile.externalAllowed});
   if(privacy.route==='denied'){await this.authority.fail(ticket,'privacy_denied');return {status:'failed',ticket};}
   await this.authority.start(ticket,prepared,privacy.sourceMap);
   let result;try{result=await withDeadline(this.profile.deadlineMs,signal=>this.provider.decide(privacy.context,taskRegistry,2,new Date(Date.now()+this.profile.deadlineMs),signal));}catch{await this.authority.fail(ticket,'provider_uncertain');return {status:'failed',ticket};}
   if(result.outcome!=='ok'){await this.authority.fail(ticket,'provider_'+result.outcome);return {status:'failed',ticket};}
   try{
    const grounded=groundMeaningDraft(result.decision,privacy.sourceMap),normalizer=new TemporalNormalizer(this.time);
    const validated=validateDecision(grounded,prepared.source.sourceLabel,{source:prepared.source,time:normalizer});
    const resolver=new TargetResolver(prepared,taskTargetSearch(this.tasks,{userId:event.userId,capability:'task_read',timezone:prepared.source.timezone}));
    const groups=await resolveDecision(validated,resolver,normalizer,prepared.source);
    plan={version:1,context:prepared,groups,queries:grounded.decision.queries};
   }catch{await this.authority.fail(ticket,'invalid_decision');return {status:'failed',ticket};}
   await this.authority.accept(ticket,plan);return {status:'accepted',ticket:{...ticket,phase:'accepted',plan}};
  }finally{this.active--;}
 }
}
