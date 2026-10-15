import {createHmac,randomUUID} from 'node:crypto';
import type {Database,DbTx} from '../database.js';
import type {UserId} from '../../../shared/types/identity.js';
export interface TurnInput {userId:UserId;sourceKey:string;snapshot:unknown;sourceEventId?:string;sourceConversationId?:string}
export interface DedupKey {readonly version:number;readonly key:Uint8Array}
export class TurnStore {
 private readonly keys:readonly DedupKey[];
 constructor(private readonly db:Database,keys:readonly DedupKey[]){if(!keys.length||keys.some(k=>!Number.isInteger(k.version)||k.version<1||k.key.length<32)||new Set(keys.map(k=>k.version)).size!==keys.length)throw new Error('TURN_KEYS_INVALID');this.keys=keys.map(k=>({version:k.version,key:Uint8Array.from(k.key)}));}
 async begin(input:TurnInput){return this.db.tenantTransaction('worker',input.userId,tx=>this.beginWith(tx,input));}
 async beginWith(tx:DbTx,input:TurnInput){
  if(Boolean(input.sourceEventId)!==Boolean(input.sourceConversationId))throw new Error('TURN_SOURCE_INVALID');
  if(!input.sourceKey||input.sourceKey.length>4096)throw new Error('TURN_SOURCE_INVALID');
  const digests=this.keys.map(k=>({version:k.version,digest:createHmac('sha256',k.key).update(JSON.stringify([input.userId,input.sourceKey])).digest('hex')}));

   // Serialise rotation/replay across all active HMAC versions, without storing source identifiers.
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[input.userId]);
   for(const d of digests){const rows=await tx.query<{turn_id:string;completed:boolean;snapshot:unknown}>('SELECT k.turn_id,k.completed,c.snapshot FROM public.agent_turn_keys k LEFT JOIN public.agent_turn_content c USING(user_id,turn_id) WHERE k.user_id=$1 AND k.key_version=$2 AND k.source_digest=$3',[input.userId,d.version,d.digest]);if(rows[0])return {turnId:rows[0].turn_id,completed:rows[0].completed,snapshot:rows[0].snapshot??null,replayed:true};}
   const turnId=randomUUID(),d=digests[0]!;
   await tx.query('INSERT INTO public.agent_turn_keys(user_id,turn_id,key_version,source_digest) VALUES($1,$2,$3,$4)',[input.userId,turnId,d.version,d.digest]);
   await tx.query('INSERT INTO public.agent_turn_content(user_id,turn_id,source_event_id,source_conversation_id,snapshot) VALUES($1,$2,$3,$4,$5)',[input.userId,turnId,input.sourceEventId??null,input.sourceConversationId??null,JSON.stringify(input.snapshot)]);
   return {turnId,completed:false,snapshot:structuredClone(input.snapshot),replayed:false};
 }
 async finalize(userId:UserId,turnId:string){await this.db.tenantTransaction('worker',userId,async tx=>{await tx.query('UPDATE public.agent_turn_keys SET completed=true WHERE user_id=$1 AND turn_id=$2',[userId,turnId]);await tx.query('UPDATE public.agent_turn_content SET finalized_at=COALESCE(finalized_at,clock_timestamp()) WHERE user_id=$1 AND turn_id=$2',[userId,turnId]);});}
}
