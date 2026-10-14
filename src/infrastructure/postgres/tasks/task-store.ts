import type { DbTx } from '../database.js';
import type { TaskChange } from '../../../modules/tasks/domain/transitions.js';
import { taskInsertValues } from './task-row.js';
export async function persistTaskChanges(tx:DbTx,changes:readonly (TaskChange&{eventId:string;commandIndex:number})[],receiptId:string):Promise<void>{
 for(const change of changes){
  if(change.before===null){
  await tx.query(`INSERT INTO public.work_items(id,user_id,title,description,status,target_date,scheduled_at,due_date,due_at,timezone,version,created_at,updated_at,completed_at,cancelled_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,taskInsertValues(change.after));
  }else{
   const rows=await tx.query(`UPDATE public.work_items SET title=$3,description=$4,status=$5,target_date=$6,scheduled_at=$7,due_date=$8,due_at=$9,timezone=$10,version=$11,updated_at=$13,completed_at=$14,cancelled_at=$15
    WHERE id=$1 AND user_id=$2 AND version=$16 AND created_at=$12 RETURNING id`,[...taskInsertValues(change.after),change.before.version]);
   if(rows.length!==1)throw new Error('Task CAS invariant failed');
  }
  await tx.query(`INSERT INTO public.work_item_events(id,user_id,task_id,receipt_id,command_index,effect_kind,before_version,after_version,before_state,after_state,recorded_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[change.eventId,change.userId,change.taskId,receiptId,change.commandIndex,change.kind,change.beforeVersion,change.afterVersion,change.before?JSON.stringify(change.before):null,JSON.stringify(change.after),change.after.updatedAt]);
 }
}
