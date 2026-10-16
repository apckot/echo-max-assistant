import {createHash,createHmac,randomUUID} from 'node:crypto';
import type {DbTx} from '../database.js';
import type {InboundEvent} from '../../../modules/intake/domain/inbound-event.js';
import type {ChoiceOption} from '../../../modules/agent/application/choice-executor.js';
export interface ChoiceReference {readonly choiceId:string;readonly revision:number;readonly option:number;readonly keyVersion:number}
export interface SavedChoice {readonly id:string;readonly revision:number;readonly options:readonly {label:string;ref:ChoiceReference}[]}
/** Domain-separated pseudorandom256-bit tokens: only hashes persist; outbox stores internal refs. */
export class ChoiceTokens{
 constructor(private readonly keys:readonly {version:number;key:Buffer}[]){if(!keys.length||keys.some(k=>k.key.length!==32||!Number.isSafeInteger(k.version)||k.version<1))throw Error('CHOICE_KEYS_INVALID');}
 get version(){return this.keys[0]!.version;}
 encode(ref:ChoiceReference):string{const key=this.keys.find(k=>k.version===ref.keyVersion);if(!key)throw Error('CHOICE_KEY_UNAVAILABLE');return 'c1.'+createHmac('sha256',key.key).update('choice-token-v1\0'+JSON.stringify([ref.choiceId,ref.revision,ref.option])).digest('base64url');}
 hash(token:string){return createHash('sha256').update(token).digest('hex');}
}
export class PostgresPendingChoices{
 constructor(readonly tokens:ChoiceTokens){}
 async saveWith(tx:DbTx,event:InboundEvent,turnId:string,label:string,options:readonly ChoiceOption[]):Promise<SavedChoice>{
  if(options.length<2||options.length>5||options.some(o=>!o.commands.length||o.commands.length>20))throw Error('CHOICE_NOT_FINITE');
  const id=randomUUID();await tx.query('INSERT INTO public.pending_choices(id,user_id,conversation_id,turn_id,group_label) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,turn_id,group_label,revision) DO NOTHING',[id,event.userId,event.conversationId,turnId,label]);
  const [row]=await tx.query<{id:string;revision:number}>('SELECT id,revision FROM public.pending_choices WHERE user_id=$1 AND turn_id=$2 AND group_label=$3',[event.userId,turnId,label]);if(!row)throw Error('CHOICE_SOURCE_INVALID');
  if(row.id===id)for(const [ordinal,option] of [{label:'Отмена',commands:[]},...options].entries()){
   const ref={choiceId:id,revision:row.revision,option:ordinal,keyVersion:this.tokens.version};await tx.query('INSERT INTO public.pending_choice_options(user_id,choice_id,ordinal,label,key_version,token_hash,commands) VALUES($1,$2,$3,$4,$5,$6,$7)',[event.userId,id,ordinal,option.label,this.tokens.version,this.tokens.hash(this.tokens.encode(ref)),JSON.stringify(option.commands)]);
  }
  const rows=await tx.query<{ordinal:number;label:string;key_version:number}>('SELECT ordinal,label,key_version FROM public.pending_choice_options WHERE user_id=$1 AND choice_id=$2 ORDER BY ordinal',[event.userId,row.id]);
  return {id:row.id,revision:row.revision,options:rows.map(o=>({label:o.label,ref:{choiceId:row.id,revision:row.revision,option:o.ordinal,keyVersion:o.key_version}}))};
 }
}
