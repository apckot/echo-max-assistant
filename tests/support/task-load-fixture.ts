import {createHash} from 'node:crypto';
import {fingerprint} from '../../src/infrastructure/postgres/tasks/task-receipts.js';
import type {taskFixture} from './task-fixture.js';
import type {UserId} from '../../src/shared/types/identity.js';
export const loadSeed='echo-task-domain-v1';
export function seedId(value:string){const hex=createHash('md5').update(loadSeed+':'+value).digest('hex').split('');hex[12]='4';hex[16]='8';const s=hex.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
export async function seedTaskLoad(f:Awaited<ReturnType<typeof taskFixture>>,tenants:number,perTenant:number,onProgress?:(tenants:number)=>void){
 const users=Array.from({length:tenants},(_,n)=>seedId('user:'+n) as UserId);
 // Independent tenants seed concurrently; each checked-out connection owns its temporary table.
 // Set-based fixture seeding keeps every real constraint/trigger enabled.
 async function seedTenant(n:number){
  const client=await f.migrator.connect(),user=users[n];
  try{
  await client.query(`CREATE TEMP TABLE IF NOT EXISTS load_seed(task_id uuid,receipt_id uuid,event_id uuid,user_id uuid,title text,payload jsonb,hash text)`);
  await client.query('BEGIN');
  try{
   await client.query('INSERT INTO public.users(id) VALUES($1)',[user]);
   await client.query('TRUNCATE load_seed');
   const ids=Array.from({length:perTenant},(_,i)=>seedId('task:'+n+':'+i));
   const receipts=Array.from({length:perTenant},(_,i)=>seedId('receipt:'+n+':'+i));
   const events=Array.from({length:perTenant},(_,i)=>seedId('event:'+n+':'+i));
   const payloads=ids.map((_,i)=>fingerprint({contractVersion:1,commands:[{kind:'create',localId:'a',title:'Load item '+(i+1),description:null,targetDate:null,scheduledAt:null,deadline:null,timezone:'Europe/Moscow'}],actor:'owner',source:{kind:'typed',operationId:receipts[i]},sourceOccurredAt:'2026-10-14T09:00:00.000Z',timezoneSnapshot:'Europe/Moscow',intents:[{kind:'create',binding:{created:'a'},affirmative:true,asserted:true,ownerAuthored:true,quoted:false}]}));
   await client.query(`INSERT INTO load_seed SELECT task_id,receipt_id,event_id,$4::uuid,'Load item '||ordinality,payload,hash FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$5::jsonb[],$6::text[]) WITH ORDINALITY AS x(task_id,receipt_id,event_id,payload,hash,ordinality)`,[ids,receipts,events,user,payloads.map(p=>JSON.stringify(p.canonicalPayload)),payloads.map(p=>p.hash)]);
   await client.query(`INSERT INTO public.work_items(id,user_id,title,status,timezone,version,created_at,updated_at)
    SELECT task_id,user_id,title,'open','Europe/Moscow',1,'2026-10-14T09:00:00Z','2026-10-14T09:00:00Z' FROM load_seed`);
   await client.query(`INSERT INTO public.task_command_receipts(id,user_id,effect_key,payload_hash,canonical_payload,result,source_kind,source_id,actor,source_occurred_at,timezone_snapshot)
    SELECT s.receipt_id,s.user_id,'seed:'||s.task_id,s.hash,s.payload,
    jsonb_build_object('receiptId',s.receipt_id,'contractVersion',1,'effectKey','seed:'||s.task_id,'outcome','applied','commandResults',
     jsonb_build_array(jsonb_build_object('index',0,'kind','create','taskId',s.task_id,'beforeVersion',null,'afterVersion',1,'outcome','applied')),
     'localIdMap',jsonb_build_object('a',s.task_id),'snapshots',jsonb_build_array(public.task_row_snapshot(w)),'error',null),
    'typed',s.receipt_id,'owner','2026-10-14T09:00:00Z','Europe/Moscow' FROM load_seed s JOIN public.work_items w ON w.id=s.task_id`);
   await client.query(`INSERT INTO public.work_item_events(id,user_id,task_id,receipt_id,command_index,effect_kind,before_version,after_version,before_state,after_state,recorded_at)
    SELECT s.event_id,s.user_id,s.task_id,s.receipt_id,0,'create',null,1,null,public.task_row_snapshot(w),w.updated_at FROM load_seed s JOIN public.work_items w ON w.id=s.task_id`);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  }finally{client.release();}
 }
 const preparationClients=Math.min(10,tenants);
 for(let start=0;start<tenants;start+=preparationClients){await Promise.all(Array.from({length:Math.min(preparationClients,tenants-start)},(_,i)=>seedTenant(start+i)));onProgress?.(Math.min(tenants,start+preparationClients));}
 await f.migrator.query('ANALYZE public.work_items');await f.migrator.query('ANALYZE public.work_item_events');await f.migrator.query('ANALYZE public.task_command_receipts');
 return users;
}
