import type { DbTx } from '../database.js';
import type { TaskChange } from '../../../modules/tasks/domain/transitions.js';
import { taskInsertValues } from './task-row.js';
export async function persistTaskCreates(tx:DbTx,changes:readonly (TaskChange&{eventId:string})[],receiptId:string):Promise<void>{
 for(const [index,change] of changes.entries()){
  if(change.kind!=='create'||change.before!==null)throw new Error('Checkpoint40 supports task creation only');
  await tx.query(`INSERT INTO public.work_items(id,user_id,title,description,status,target_date,scheduled_at,due_date,due_at,timezone,version,created_at,updated_at,completed_at,cancelled_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,taskInsertValues(change.after));
  await tx.query(`INSERT INTO public.work_item_events(id,user_id,task_id,receipt_id,command_index,effect_kind,before_version,after_version,before_state,after_state,recorded_at)
   VALUES($1,$2,$3,$4,$5,'create',NULL,1,NULL,$6,$7)`,[change.eventId,change.userId,change.taskId,receiptId,index,JSON.stringify(change.after),change.after.createdAt]);
 }
}
