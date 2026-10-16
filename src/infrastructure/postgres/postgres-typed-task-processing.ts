import type {ProcessingContinuation} from './postgres-atomic-processing.js';
import type {DbTx} from './database.js';
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
import type {GroupExecutor,GroupOutcome} from '../../modules/agent/application/group-runner.js';
/** Sole bridge binds immutable accepted commands to the currently locked source and assistantTurnId. */
export class PostgresAgentTaskProcessing implements GroupExecutor {
 constructor(private readonly authority:Pick<PostgresTurnAuthority,'guarded'>){}
 async runGroup(ticket:TurnTicket,index:number):Promise<GroupOutcome>{
  if(!Number.isInteger(index)||index<0||index>=10)throw Error('GROUP_INDEX_INVALID');
  return this.authority.guarded(ticket,async(tx,event)=>{
   const [accepted]=await tx.query<{plan:AcceptedPlan}>("SELECT d.plan FROM public.accepted_decisions d JOIN public.agent_runs r USING(user_id,turn_id) WHERE d.user_id=$1 AND d.turn_id=$2 AND r.phase='accepted'",[event.userId,ticket.turnId]);
   const group=accepted?.plan.groups[index];if(!group)throw Error('GROUP_NOT_ACCEPTED');const label=group.labels.join(':');
   const [previous]=await tx.query<{result:GroupOutcome}>('SELECT result FROM public.turn_groups WHERE user_id=$1 AND turn_id=$2 AND label=$3',[event.userId,ticket.turnId,label]);if(previous)return previous.result;
   let outcome:GroupOutcome;
   if(group.status!=='ready')outcome={label,outcome:group.status==='choice'?'choice':'blocked',receipt:null,reasons:group.reasons};
   else if(!group.commands.length)outcome={label,outcome:'respond',receipt:null,reasons:[]};
   else{
    const intents=group.commands.map(command=>({kind:command.kind,binding:command.kind==='create'?{created:command.localId}:command.target,affirmative:true,asserted:true,ownerAuthored:true,quoted:false}));
    const context=ownerTaskContext(event.userId,{kind:'turn',turnId:ticket.turnId},event.occurredAt.toISOString(),event.timezoneSnapshot,intents);
    const result=await new TaskCommands(new PostgresBoundTaskSessionRunner(tx,event,ticket.turnId),new IanaTimeResolver()).execute(context,{contractVersion:1,effectKey:'turn:'+ticket.turnId+':1:'+label,commands:group.commands});
    if('error' in result)throw Error('GROUP_TASK_ENVELOPE_REJECTED');
    outcome={label,outcome:result.receipt.outcome,receipt:result.receipt,reasons:result.receipt.error?[result.receipt.error.code]:[]};
   }
   await tx.query('INSERT INTO public.turn_groups(user_id,turn_id,label,outcome,receipt_id,result) VALUES($1,$2,$3,$4,$5,$6)',[event.userId,ticket.turnId,label,outcome.outcome,outcome.receipt?.receiptId??null,JSON.stringify(outcome)]);
   await tx.query('INSERT INTO public.turn_response_intents(user_id,turn_id) VALUES($1,$2) ON CONFLICT(user_id,turn_id) DO UPDATE SET revision=public.turn_response_intents.revision+1',[event.userId,ticket.turnId]);
   return outcome;
  });
 }
}
