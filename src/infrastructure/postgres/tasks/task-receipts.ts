import { createHash } from 'node:crypto';
import type { DbTx } from '../database.js';
import type { CanonicalTaskPayload, StoredTaskReceipt, TaskReceipt } from '../../../modules/tasks/application/ports.js';
import type { TaskExecutionContext } from '../../../modules/tasks/application/context.js';
function sorted(value:unknown):unknown {
 if(Array.isArray(value))return value.map(sorted);
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>[key,sorted(v)]));
 return value;
}
export function fingerprint(payload:CanonicalTaskPayload):{hash:string;canonicalPayload:CanonicalTaskPayload}{
 const canonicalPayload=sorted(payload) as CanonicalTaskPayload;
 return {hash:createHash('sha256').update(JSON.stringify(canonicalPayload),'utf8').digest('hex'),canonicalPayload};
}
export async function findReceipt(tx:DbTx,userId:string,key:string):Promise<StoredTaskReceipt|null>{
 const [row]=await tx.query<{payload_hash:string;canonical_payload:CanonicalTaskPayload;result:TaskReceipt}>(
  'SELECT payload_hash,canonical_payload,result FROM public.task_command_receipts WHERE user_id=$1 AND effect_key=$2',[userId,key]);
 return row?{payloadHash:row.payload_hash,canonicalPayload:row.canonical_payload,receipt:row.result}:null;
}
export async function persistReceipt(tx:DbTx,context:TaskExecutionContext,receipt:TaskReceipt,payload:CanonicalTaskPayload,hash:string):Promise<void>{
 await tx.query(`INSERT INTO public.task_command_receipts(id,user_id,effect_key,payload_hash,canonical_payload,result,source_kind,source_id,actor,source_occurred_at,timezone_snapshot)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[receipt.receiptId,context.userId,receipt.effectKey,hash,JSON.stringify(payload),JSON.stringify(receipt),context.source.kind,
 context.source.kind==='typed'?context.source.operationId:context.source.turnId,context.actor,context.sourceOccurredAt,payload.timezoneSnapshot]);
}
