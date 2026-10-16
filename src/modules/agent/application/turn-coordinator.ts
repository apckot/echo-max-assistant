import type {TurnSourcePreparation,PreparedSource} from '../../media/application/transcript.js';
import {withDeadline} from '../../../shared/time/deadline.js';
import {compileGroups} from './group-runner.js';
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
export type StagedTurn={readonly status:'accepted'|'failed'|'duplicate';readonly ticket:TurnTicket}|{readonly status:'idle'|'busy'};
export class TurnCoordinator {
 private active=0;
 constructor(private readonly authority:TurnAuthority,private readonly context:ContextBuilder,private readonly tasks:TaskQueries,private readonly time:TemporalPort,private readonly provider:AiDecisionProvider,private readonly profile:CoordinatorProfile,private readonly sourcePreparation?:TurnSourcePreparation){}
 async run(lease:ConversationLease,parentSignal:AbortSignal=new AbortController().signal):Promise<StagedTurn>{
  if(this.active>=4)return {status:'busy'};this.active++;
  try{
   const ticket=await this.authority.claim(lease,this.profile.profileDigest);if(!ticket)return {status:'idle'};
   if(ticket.phase==='completed')return {status:'duplicate',ticket};
   if(ticket.phase==='accepted'||ticket.phase==='failed')return {status:ticket.phase,ticket};
   const event=ticket.event;
   let input:PreparedSource;
   if(event.payload.kind==='text')input={kind:'text',text:event.payload.text,criticalUncertainty:null};
   else if(event.payload.kind==='voice'&&this.sourcePreparation)input=await this.sourcePreparation.prepare(ticket,parentSignal);
   else input={kind:'denied',reason:'unsupported_source'};
   if(input.kind==='denied'){await this.authority.fail(ticket,input.reason);return {status:'failed',ticket};}
   const sourceInput=input;

   let plan:AcceptedPlan;
   // Local failures have safe classifications; DB authority failures are never swallowed or retried.
   let prepared:Awaited<ReturnType<ContextBuilder['build']>>;
   try{prepared=await this.context.build(event.userId,event.conversationId,{text:sourceInput.text,kind:sourceInput.audioChecksum?'transcript':'text',...(sourceInput.audioChecksum?{audioChecksum:sourceInput.audioChecksum}:{}),sourceLabel:'S1',sourceAt:event.occurredAt.toISOString(),timezone:event.timezoneSnapshot,...('replyToMessageId' in event.payload&&event.payload.replyToMessageId?{replyMessageId:event.payload.replyToMessageId}:{})});}
   catch{await this.authority.fail(ticket,'context_unavailable');return {status:'failed',ticket};}
   const privacy=preparePrivacy(prepared.provider,{externalAllowed:this.profile.externalAllowed});
   if(privacy.route==='denied'){await this.authority.fail(ticket,'privacy_denied');return {status:'failed',ticket};}
   if(parentSignal.aborted){await this.authority.fail(ticket,'processing_cancelled');return {status:'failed',ticket};}
   await this.authority.start(ticket,prepared,privacy.sourceMap);
   let result;try{result=await withDeadline(this.profile.deadlineMs,signal=>this.provider.decide(privacy.context,taskRegistry,2,new Date(Date.now()+this.profile.deadlineMs),signal),parentSignal);}catch{await this.authority.fail(ticket,'provider_uncertain');return {status:'failed',ticket};}
   if(result.outcome!=='ok'){await this.authority.fail(ticket,'provider_'+result.outcome);return {status:'failed',ticket};}
   try{
    const grounded=groundMeaningDraft(result.decision,privacy.sourceMap),normalizer=new TemporalNormalizer(this.time);
    const validated=validateDecision(grounded,prepared.source.sourceLabel,{source:prepared.source,time:normalizer});
    const resolver=new TargetResolver(prepared,taskTargetSearch(this.tasks,{userId:event.userId,capability:'task_read',timezone:prepared.source.timezone}));
    const resolved=await resolveDecision(validated,resolver,normalizer,prepared.source);
    const spans=sourceInput.criticalUncertainty??[];
    const overlaps=(e:{sourceLabel:string;start:number;end:number})=>e.sourceLabel===prepared.source.sourceLabel&&spans.some(span=>e.start<span.end&&span.start<e.end);
    const criticalUnits=new Set(grounded.decision.units.filter(u=>u.evidence.some(overlaps)).map(u=>u.label));
    const unbound=spans.some(span=>!grounded.decision.units.some(u=>u.evidence.some(e=>e.sourceLabel===prepared.source.sourceLabel&&e.start<span.end&&span.start<e.end)));
    const groups=resolved.map(group=>unbound||group.actions.some(a=>criticalUnits.has(a.draft.unitLabel)||[...a.draft.evidence,...a.draft.times.flatMap(t=>t.evidence),...(a.draft.target&&a.draft.target.kind!=='created'?a.draft.target.evidence:[])].some(overlaps))||group.queryLabels.some(label=>grounded.decision.queries.some(q=>q.label===label&&criticalUnits.has(q.unitLabel)))?{...group,status:'blocked' as const,reasons:[...group.reasons,'STT_CRITICAL_UNCERTAINTY']}:group);
    plan={version:1,context:prepared,groups:compileGroups(groups,prepared,event.userId,this.time),queries:grounded.decision.queries};
   }catch{await this.authority.fail(ticket,'invalid_decision');return {status:'failed',ticket};}
   await this.authority.accept(ticket,plan);return {status:'accepted',ticket:{...ticket,phase:'accepted',plan}};
  }finally{this.active--;}
 }
}
