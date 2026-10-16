import type {Database,DbTx} from '../database.js';
import type {UserId} from '../../../shared/types/identity.js';
import type {ContextReader} from '../../../modules/context/application/context-port.js';
import type {DeliveredAnchor,TaskBinding} from '../../../modules/context/application/context-pack.js';
export class PostgresContextReader implements ContextReader {
 constructor(private readonly db:Database){}
 async anchor(userId:UserId,conversationId:string,messageId:string):Promise<DeliveredAnchor|null>{return this.db.tenantTransaction('worker',userId,async tx=>{const rows=await tx.query<{kind:'reply'|'list';tasks:TaskBinding[]}>('SELECT * FROM public.delivered_context($1,$2)',[messageId,conversationId]);return rows.length===1?{label:rows[0]!.kind==='list'?'L1':'R1',kind:rows[0]!.kind,tasks:rows[0]!.tasks}:null;});}
 async replyChoices(userId:UserId,conversationId:string,messageId:string){return this.db.tenantTransaction('worker',userId,tx=>tx.query<{id:string;revision:number}>('SELECT id,revision FROM public.choice_context($1,$2)',[conversationId,messageId]));}
 async pending(userId:UserId,conversationId:string){return this.db.tenantTransaction('worker',userId,async tx=>{const rows=await tx.query<{topic:string}>('SELECT topic FROM public.choice_context($1,NULL)',[conversationId]);return rows.map((row,i)=>({label:'P'+(i+1),topic:row.topic}));});}
 async history(userId:UserId,conversationId:string,sourceAt:string){return this.db.tenantTransaction('worker',userId,async tx=>{const rows=await tx.query<{user_text:string;assistant_text:string}>('SELECT * FROM public.delivered_history($1,$2)',[conversationId,sourceAt]);return rows.reverse().flatMap(r=>[{role:'user' as const,text:r.user_text},{role:'assistant' as const,text:r.assistant_text}]);});}
 async saveAnchor(userId:UserId,conversationId:string,outboundId:string,kind:'reply'|'list',tasks:readonly TaskBinding[]){
  await this.db.tenantTransaction('worker',userId,tx=>this.saveAnchorWith(tx,userId,conversationId,outboundId,kind,tasks));
 }
 async saveAnchorWith(tx:DbTx,userId:UserId,conversationId:string,outboundId:string,kind:'reply'|'list',tasks:readonly TaskBinding[]){
  return saveContextAnchorWith(tx,userId,conversationId,outboundId,kind,tasks);
 }
}
export async function saveContextAnchorWith(tx:DbTx,userId:UserId,conversationId:string,outboundId:string,kind:'reply'|'list',tasks:readonly TaskBinding[]){
  if(!tasks.length||tasks.length>100)throw new Error('CONTEXT_ANCHOR_INVALID');
   const out=await tx.query('SELECT id FROM public.outbound_messages WHERE id=$1 AND conversation_id=$2',[outboundId,conversationId]);if(out.length!==1)throw new Error('CONTEXT_ANCHOR_INVALID');
   await tx.query('INSERT INTO public.context_anchors(user_id,conversation_id,outbound_id,kind) VALUES($1,$2,$3,$4)',[userId,conversationId,outboundId,kind]);
   for(const [i,t] of tasks.entries())await tx.query('INSERT INTO public.context_anchor_tasks(user_id,outbound_id,ordinal,task_id,task_version) VALUES($1,$2,$3,$4,$5)',[userId,outboundId,i+1,t.id,t.version]);
}
