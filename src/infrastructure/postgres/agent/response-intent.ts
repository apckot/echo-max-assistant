import type {PostgresTurnAuthority} from './turn-claim.js';
import type {TurnTicket,AcceptedPlan} from '../../../modules/agent/application/turn-port.js';
import type {AssistantInboundResult} from '../../../modules/intake/application/inbound-handler.js';
import type {GroupOutcome} from '../../../modules/agent/application/group-runner.js';
import type {TaskReceipt} from '../../../modules/tasks/application/task-commands.js';
import {renderResponse} from '../../../modules/agent/application/response-renderer.js';
import {PostgresContextReader} from '../context/context-reader.js';
export class PostgresTurnFinalizer {
 constructor(private readonly authority:PostgresTurnAuthority){}
 async finalize(ticket:TurnTicket):Promise<AssistantInboundResult>{
  const cached=await this.authority.database.tenantTransaction('worker',ticket.event.userId,tx=>tx.query<{result:AssistantInboundResult}>("SELECT result FROM public.processing_receipts WHERE inbound_event_id=$1 AND receipt_type='assistant_turn_v1' AND result->>'turnId'=$2",[ticket.event.id,ticket.turnId]));if(cached[0])return cached[0].result;
  return this.authority.guarded(ticket,async(tx,event)=>{
   const [run]=await tx.query<{phase:string;failure_code:string|null;plan:AcceptedPlan|null}>('SELECT r.phase,r.failure_code,d.plan FROM public.agent_runs r LEFT JOIN public.accepted_decisions d USING(user_id,turn_id) WHERE r.user_id=$1 AND r.turn_id=$2',[event.userId,ticket.turnId]);
   const duplicate=ticket.phase==='completed';if(!duplicate&&!['accepted','failed'].includes(run?.phase??''))throw Error('FINALIZER_NOT_READY');
   const rows=await tx.query<{result:GroupOutcome;receipt:TaskReceipt|null}>('SELECT g.result,r.result AS receipt FROM public.turn_groups g LEFT JOIN public.task_command_receipts r ON r.id=g.receipt_id AND r.user_id=g.user_id WHERE g.user_id=$1 AND g.turn_id=$2 ORDER BY g.created_at,g.label',[event.userId,ticket.turnId]);
   if(!duplicate&&run?.phase==='accepted'&&(rows.length!==run.plan?.groups.length||run.plan.groups.some(g=>!rows.some(row=>row.result.label===g.labels.join(':')))))throw Error('FINALIZER_GROUPS_INCOMPLETE');
   const groups=rows.map(row=>{if(row.result.receipt&&!row.receipt)throw Error('FINALIZER_RECEIPT_MISSING');return {...row.result,receipt:row.receipt};});
   const rendered=duplicate?null:renderResponse(groups,run?.phase==='failed'?run.failure_code??'failed':null);
   const activeChoices=groups.flatMap(g=>g.choice?[g.choice]:[]);
   const message=rendered&&activeChoices.length>0?{version:1 as const,kind:'choice' as const,text:rendered.message.text,buttons:activeChoices.flatMap(c=>c.options)}:rendered?.message;
   const result:AssistantInboundResult={receiptType:'assistant_turn_v1',receiptVersion:1,turnId:ticket.turnId,responseRevision:1,messages:message?[message]:[]};
   await tx.query('INSERT INTO public.processing_receipts(user_id,conversation_id,inbound_event_id,receipt_type,receipt_version,result) VALUES($1,$2,$3,$4,1,$5)',[event.userId,event.conversationId,event.id,'assistant_turn_v1',JSON.stringify(result)]);
   if(rendered){
    const [out]=await tx.query<{id:string}>(`INSERT INTO public.outbound_messages(user_id,conversation_id,source_inbound_event_id,provider,message_index,payload,dedupe_key,assistant_turn_id) VALUES($1,$2,$3,'max',0,$4,$5,$6) RETURNING id`,[event.userId,event.conversationId,event.id,JSON.stringify(message),'turn:'+ticket.turnId+':final:v1',ticket.turnId]);
    await tx.query('INSERT INTO public.delivery_work(outbound_message_id,user_id) VALUES($1,$2)',[out!.id,event.userId]);
    for(const choice of activeChoices)await tx.query('UPDATE public.pending_choices SET outbound_id=$3 WHERE user_id=$1 AND id=$2 AND outbound_id IS NULL',[event.userId,choice.id,out!.id]);
    if(rendered.tasks.length>0)await new PostgresContextReader(this.authority.database).saveAnchorWith(tx,event.userId,event.conversationId,out!.id,rendered.anchorKind,rendered.tasks);
   }
   await tx.query("INSERT INTO public.turn_response_intents(user_id,turn_id,state) SELECT $1,$2,'finalized' WHERE EXISTS(SELECT 1 FROM public.agent_turn_content WHERE user_id=$1 AND turn_id=$2) ON CONFLICT(user_id,turn_id) DO UPDATE SET state='finalized'",[event.userId,ticket.turnId]);
   const replaced=run?.plan?.context.replyChoice;
   if(replaced&&groups.some(g=>g.choice||g.receipt&&['applied','no_change'].includes(g.receipt.outcome)))await tx.query("UPDATE public.pending_choices SET state='superseded' WHERE user_id=$1 AND conversation_id=$2 AND id=$3 AND revision=$4 AND state='pending'",[event.userId,event.conversationId,replaced.id,replaced.revision]);
   await tx.query("UPDATE public.agent_turn_keys SET completed=true WHERE user_id=$1 AND turn_id=$2",[event.userId,ticket.turnId]);
   await tx.query('UPDATE public.agent_turn_content SET finalized_at=COALESCE(finalized_at,clock_timestamp()) WHERE user_id=$1 AND turn_id=$2',[event.userId,ticket.turnId]);
   await tx.query("UPDATE public.inbound_events SET processing_status=$3,failure_code=$4,processed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2",[event.userId,event.id,duplicate?'ignored':run?.phase==='failed'?'failed':'applied',run?.phase==='failed'?'processing_error':null]);
   const advanced=await tx.query('UPDATE public.conversations SET next_apply_sequence=next_apply_sequence+1,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND next_apply_sequence=$3 RETURNING id',[event.userId,event.conversationId,event.sequence.toString()]);if(advanced.length!==1)throw Error('FINALIZER_POINTER_LOST');
   return result;
  },true);
 }
}
