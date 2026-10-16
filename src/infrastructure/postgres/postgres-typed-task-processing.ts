import type {ProcessingContinuation} from './postgres-atomic-processing.js';
import type {DbTx,Database} from './database.js';
import type {InboundEvent} from '../../modules/intake/domain/inbound-event.js';
import type {HandleInboundResult} from '../../modules/intake/application/inbound-handler.js';
import type {ExplicitTaskIntent} from '../../modules/tasks/application/context.js';
import {ownerTaskContext} from '../../modules/tasks/application/context.js';
import {TaskCommands} from '../../modules/tasks/application/task-commands.js';
import {PostgresBoundTaskSessionRunner} from './tasks/task-session.js';
import {IanaTimeResolver} from '../time/iana-time-resolver.js';
export interface PreparedTypedTask {readonly group:unknown;readonly intents:readonly ExplicitTaskIntent[]}
// Test injection only. Production runtime keeps FoundationInboundHandler without this continuation.
export class PostgresTypedTaskProcessing implements ProcessingContinuation {
 constructor(private readonly prepared:(event:InboundEvent)=>PreparedTypedTask){}
 async continue(tx:DbTx,event:InboundEvent,_prepared:HandleInboundResult):Promise<HandleInboundResult>{
  const input=this.prepared(event);
  const context=ownerTaskContext(event.userId,{kind:'turn',turnId:event.id},event.occurredAt.toISOString(),event.timezoneSnapshot,input.intents);
  const result=await new TaskCommands(new PostgresBoundTaskSessionRunner(tx,event),new IanaTimeResolver()).execute(context,input.group);
  if('error' in result)throw new Error('Typed task envelope or authority rejected');
  return {receiptType:'task_commands_v1',receiptVersion:1,taskReceiptId:result.receipt.receiptId,
   messages:[{version:1,kind:'text',text:`Задачи: ${result.receipt.outcome}${result.receipt.error?' ('+result.receipt.error.code+')':''}.`}]};
 }
}

import type {PostgresTurnAuthority} from './agent/turn-claim.js';
import type {TurnTicket,AcceptedPlan} from '../../modules/agent/application/turn-port.js';
import type {GroupExecutor,GroupOutcome,QueryOutcome} from '../../modules/agent/application/group-runner.js';
/** Sole bridge binds immutable accepted commands to the currently locked source and assistantTurnId. */
export class PostgresAgentTaskProcessing implements GroupExecutor {
 constructor(private readonly authority:Pick<PostgresTurnAuthority,'guarded'>,private readonly choices?:import('./agent/pending-choice.js').PostgresPendingChoices){}
 async runGroup(ticket:TurnTicket,index:number):Promise<GroupOutcome>{
  if(!Number.isInteger(index)||index<0||index>=10)throw Error('GROUP_INDEX_INVALID');
  return this.authority.guarded(ticket,async(tx,event)=>{
   const [accepted]=await tx.query<{plan:AcceptedPlan}>("SELECT d.plan FROM public.accepted_decisions d JOIN public.agent_runs r USING(user_id,turn_id) WHERE d.user_id=$1 AND d.turn_id=$2 AND r.phase='accepted'",[event.userId,ticket.turnId]);
   const group=accepted?.plan.groups[index];if(!group)throw Error('GROUP_NOT_ACCEPTED');const label=group.labels.join(':');
   const [previous]=await tx.query<{result:GroupOutcome}>('SELECT result FROM public.turn_groups WHERE user_id=$1 AND turn_id=$2 AND label=$3',[event.userId,ticket.turnId,label]);if(previous)return previous.result;
   let outcome:GroupOutcome;
   if(group.status==='choice'&&this.choices){
    const options=choiceOptions(group,accepted!.plan.context,event.userId,new IanaTimeResolver());
    outcome=options.length?{label,outcome:'choice',receipt:null,reasons:group.reasons,choice:await this.choices.saveWith(tx,event,ticket.turnId,label,options)}:{label,outcome:'blocked',receipt:null,reasons:['CHOICE_UNREPRESENTABLE']};
   }else if(group.status!=='ready')outcome={label,outcome:group.status==='choice'?'choice':'blocked',receipt:null,reasons:group.reasons};
   else if(!group.commands.length)outcome={label,outcome:'respond',receipt:null,reasons:[]};
   else{
    const intents=group.commands.map(command=>({kind:command.kind,binding:command.kind==='create'?{created:command.localId}:command.target,affirmative:true,asserted:true,ownerAuthored:true,quoted:false}));
    const context=ownerTaskContext(event.userId,{kind:'turn',turnId:ticket.turnId},event.occurredAt.toISOString(),event.timezoneSnapshot,intents);
    const result=await new TaskCommands(new PostgresBoundTaskSessionRunner(tx,event,ticket.turnId),new IanaTimeResolver()).execute(context,{contractVersion:1,effectKey:'turn:'+ticket.turnId+':1:'+label,commands:group.commands});
    if('error' in result)throw Error('GROUP_TASK_ENVELOPE_REJECTED');
    outcome={label,outcome:result.receipt.outcome,receipt:result.receipt,reasons:result.receipt.error?[result.receipt.error.code]:[]};
   }
   if(group.status==='ready'&&group.queryLabels.length&&outcome.outcome!=='rejected')outcome={...outcome,queryResults:await readAgentQueries(tx,event,accepted!.plan,group.queryLabels)};
   await tx.query('INSERT INTO public.turn_groups(user_id,turn_id,label,outcome,receipt_id,result) VALUES($1,$2,$3,$4,$5,$6)',[event.userId,ticket.turnId,label,outcome.outcome,outcome.receipt?.receiptId??null,JSON.stringify(outcome)]);
   await tx.query('INSERT INTO public.turn_response_intents(user_id,turn_id) VALUES($1,$2) ON CONFLICT(user_id,turn_id) DO UPDATE SET revision=public.turn_response_intents.revision+1',[event.userId,ticket.turnId]);
   return outcome;
  });
 }
}

import {TaskQueries} from '../../modules/tasks/application/task-queries.js';
import {PostgresTaskReadRunner} from './tasks/task-read-model.js';
import {TemporalNormalizer} from '../../modules/semantic/application/temporal-normalizer.js';
import {TargetResolver,taskTargetSearch} from '../../modules/semantic/application/target-resolver.js';
export const agentTaskQueries=(database:Pick<Database,'tenantTransaction'>)=>new TaskQueries(new PostgresTaskReadRunner(database),new IanaTimeResolver());
async function readAgentQueries(tx:DbTx,event:InboundEvent,plan:AcceptedPlan,labels:readonly string[]):Promise<readonly QueryOutcome[]>{
 const bound:Pick<Database,'tenantTransaction'>={tenantTransaction:async(role,user,fn)=>{if(role!=='worker'||user!==event.userId)throw Error('QUERY_TENANT_MISMATCH');return fn(tx);}};
 const queries=agentTaskQueries(bound),time=new IanaTimeResolver(),normalizer=new TemporalNormalizer(time),context={userId:event.userId,capability:'task_read' as const,timezone:plan.context.source.timezone};
 const resolver=new TargetResolver(plan.context,taskTargetSearch(queries,context));const results:QueryOutcome[]=[];
 for(const label of labels){const q=plan.queries.find(q=>q.label===label);if(!q)throw Error('QUERY_NOT_ACCEPTED');
  if(q.kind==='capabilities'){results.push({kind:'capabilities',text:'Могу создавать, изменять, завершать, отменять и восстанавливать задачи, показывать списки и историю.'});continue;}
  if(q.kind==='history'){
   if(!q.target){results.push({kind:'unavailable',reason:'target'});continue;}
   const target=await resolver.resolve(q.target,label);if(target.status!=='resolved'||target.targets.length!==1){results.push({kind:'unavailable',reason:'target'});continue;}
   const page=await queries.history(context,{taskId:target.targets[0]!.id,limit:20});results.push('error' in page?{kind:'unavailable',reason:page.error.code}:{kind:'history',items:page.items,asOf:page.asOf});continue;
  }
  const day=q.kind==='day'?(q.dayExpression?normalizer.dateExpression(q.dayExpression,plan.context.source):time.localDate(plan.context.source.sourceAt,context.timezone)):null;
  if(q.kind==='day'&&!day||q.kind==='find'&&!q.text){results.push({kind:'unavailable',reason:'read_args'});continue;}
  const page=await queries.list(context,{view:q.kind==='day'?'day':q.kind==='find'||q.statuses.length?'all':'open',...(day?{day,timezone:context.timezone}:{}),...(q.text?{text:q.text}:{}),...(q.statuses.length?{statuses:q.statuses}:{}),limit:20});
  results.push('error' in page?{kind:'unavailable',reason:page.error.code}:{kind:'tasks',day,items:page.items,asOf:page.asOf,nextCursor:page.nextCursor});
 }
 return results;
}

import {choiceOptions} from '../../modules/agent/application/choice-executor.js';
export async function executeChoiceCommands(tx:DbTx,event:InboundEvent,commands:readonly import('../../modules/tasks/domain/commands.js').TaskCommand[],effectKey:string){
 const intents=commands.map(c=>({kind:c.kind,binding:c.kind==='create'?{created:c.localId}:c.target,affirmative:true,asserted:true,ownerAuthored:true,quoted:false}));
 const context=ownerTaskContext(event.userId,{kind:'turn',turnId:event.id},event.occurredAt.toISOString(),event.timezoneSnapshot,intents);
 const result=await new TaskCommands(new PostgresBoundTaskSessionRunner(tx,event),new IanaTimeResolver()).execute(context,{contractVersion:1,effectKey,commands});if('error' in result)throw Error('CHOICE_TASK_ENVELOPE');return result.receipt;
}
