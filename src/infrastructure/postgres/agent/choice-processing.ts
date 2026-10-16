import type {PostgresOrderedHead} from '../postgres-ordered-head.js';
import type {DbTx} from '../database.js';
import type {InboundEvent} from '../../../modules/intake/domain/inbound-event.js';
import type {ConversationLease} from '../../../modules/intake/application/conversation-queue.js';
import type {TaskCommand} from '../../../modules/tasks/domain/commands.js';
import type {GroupOutcome} from '../../../modules/agent/application/group-runner.js';
import {renderResponse} from '../../../modules/agent/application/response-renderer.js';
import {executeChoiceCommands} from '../postgres-typed-task-processing.js';
import {PostgresOutbox} from '../postgres-outbox.js';
import type {PostgresPendingChoices} from './pending-choice.js';
export class PostgresChoiceProcessor{
 constructor(private readonly ordered:PostgresOrderedHead,private readonly choices:PostgresPendingChoices){}
 async run(lease:ConversationLease){return this.ordered.run(lease,async({event},tx)=>{
  if(event.payload.kind!=='button')throw Error('CHOICE_CALLBACK_REQUIRED');
  const [choice]=await tx.query<{id:string;revision:number;state:string;selected:number|null;result:GroupOutcome|null;ordinal:number;commands:TaskCommand[];live:boolean;delivered:boolean}>(`SELECT c.*,o.ordinal,o.commands,c.expires_at>clock_timestamp() AS live,
   public.verified_choice_delivery(c.id,$4,$2) AS delivered
   FROM public.pending_choices c JOIN public.pending_choice_options o ON o.user_id=c.user_id AND o.choice_id=c.id
   WHERE c.user_id=$1 AND c.conversation_id=$2 AND o.token_hash=$3 FOR UPDATE OF c`,[event.userId,event.conversationId,/^ch1\.[a-f0-9]{64}$/.test(event.payload.callbackPayload)?event.payload.callbackPayload.slice(4):'',event.payload.callbackMessageId??'']);
  let message:string|undefined='Кнопка устарела или недоступна. Задачи не изменены.',canonical:{id:string;revision:number}|undefined;
  if(choice?.delivered){
   if(['consumed','cancelled'].includes(choice.state)&&choice.selected===choice.ordinal)message=undefined;
   else if(choice.state==='pending'&&choice.live){
    const receipt=choice.ordinal===0?null:await executeChoiceCommands(tx,event,choice.commands,'choice:'+choice.id+':'+choice.revision);
    const result:GroupOutcome={label:'choice',outcome:receipt?.outcome??'no_change',receipt,reasons:[]};
    message=receipt?renderResponse([result]).message.text:'Выбор отменён. Задачи не изменены.';
    await tx.query('UPDATE public.pending_choices SET state=$3,selected=$4,result=$5,receipt_id=$6 WHERE user_id=$1 AND id=$2',[event.userId,choice.id,choice.ordinal===0?'cancelled':'consumed',choice.ordinal,JSON.stringify(result),receipt?.receiptId??null]);canonical={id:choice.id,revision:choice.revision};
   }else if(choice.state==='pending'&&!choice.live)await tx.query("UPDATE public.pending_choices SET state='expired' WHERE user_id=$1 AND id=$2",[event.userId,choice.id]);
  }
  const result={receiptType:'foundation_echo' as const,receiptVersion:1 as const,messages:message?[{version:1 as const,kind:'text' as const,text:message}]:[]};
  await tx.query("INSERT INTO public.processing_receipts(user_id,conversation_id,inbound_event_id,receipt_type,receipt_version,result) VALUES($1,$2,$3,'foundation_echo',1,$4)",[event.userId,event.conversationId,event.id,JSON.stringify(result)]);
  if(canonical){
   const [out]=await tx.query<{id:string}>(`INSERT INTO public.outbound_messages(user_id,conversation_id,source_inbound_event_id,provider,message_index,payload,dedupe_key,choice_id,choice_revision) VALUES($1,$2,$3,'max',0,$4,$5,$6,$7) RETURNING id`,[event.userId,event.conversationId,event.id,JSON.stringify(result.messages[0]),'choice:'+canonical.id+':'+canonical.revision+':result:v1',canonical.id,canonical.revision]);
   await tx.query('INSERT INTO public.delivery_work(outbound_message_id,user_id) VALUES($1,$2)',[out!.id,event.userId]);
  }else await new PostgresOutbox(tx).save(event,result.messages);
  const [next]=await tx.query<{more:boolean}>('UPDATE public.conversations SET next_apply_sequence=next_apply_sequence+1 WHERE user_id=$1 AND id=$2 AND next_apply_sequence=$3 RETURNING next_apply_sequence<next_inbound_sequence AS more',[event.userId,event.conversationId,event.sequence.toString()]);if(!next)throw Error('CHOICE_HEAD_LOST');
  await tx.query("UPDATE public.inbound_events SET processing_status='applied',processed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2",[event.userId,event.id]);
  return {value:result,disposition:next.more?{kind:'ready' as const}:{kind:'sleep' as const}};
 });}
}
