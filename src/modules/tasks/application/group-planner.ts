import type { TaskCommandGroup } from '../domain/commands.js';
import { createTask,transition,type TaskChange } from '../domain/transitions.js';
import type { Task,TaskError } from '../domain/task.js';
import type { TaskExecutionContext } from './context.js';
import { validateEvidence } from './evidence.js';
import type { TaskReceipt,TaskCommandResult,TemporalPort } from './ports.js';
export interface TaskGroupPlan {readonly changes:readonly (TaskChange&{readonly commandIndex:number})[];readonly receipt:TaskReceipt}
export function planGroup(context:TaskExecutionContext,group:TaskCommandGroup,locked:readonly Task[],newIds:ReadonlyMap<string,string>,receiptId:string,
 recordedAt:string,temporal:TemporalPort):TaskGroupPlan|TaskError {
 const tasks=new Map(locked.map(t=>[t.id,t]));const locals=new Map<string,string>();const touched=new Map<string,Task>();
 const changes:(TaskChange&{commandIndex:number})[]=[];const results:TaskCommandResult[]=[];
 for(const [index,command] of group.commands.entries()){
  const evidence=validateEvidence(context,command,index);if(evidence)return {...evidence,index};
  let result:ReturnType<typeof transition>;let beforeVersion:number|null=null;let id:string;
  if(command.kind==='create'){
   if(locals.has(command.localId)||!newIds.has(command.localId))return {code:'invalid_local_reference',index};
   id=newIds.get(command.localId)!;locals.set(command.localId,id);const timezone=command.timezone??context.timezoneSnapshot;
   if(!temporal.validTimezone(timezone))return {code:'invalid_timezone',index};
   result=createTask(command,{id,userId:context.userId,timezone,recordedAt,
    scheduledLocalDate:command.scheduledAt?temporal.localDate(command.scheduledAt,timezone):null});
  }else{
   const target=command.target;
   if('created' in target&&!locals.has(target.created))return {code:'invalid_local_reference',index};
   id='taskId' in target?target.taskId:locals.get(target.created)!;
   const task=tasks.get(id);if(!task)return {code:'task_not_found',index};beforeVersion=task.version;
   const scheduledAt=command.kind==='update'&&'scheduledAt' in command.patch?command.patch.scheduledAt:task.scheduledAt;
   const timezone=command.kind==='update'?command.patch.timezone??task.timezone:task.timezone;
   if(!temporal.validTimezone(timezone))return {code:'invalid_timezone',index};
   result=transition(task,{...command,target:{taskId:id}},{recordedAt,scheduledLocalDate:scheduledAt?temporal.localDate(scheduledAt,timezone):null});
  }
  if('code' in result)return {...result,index};
  tasks.set(id,result.task);touched.set(id,result.task);
  if(result.change)changes.push({...result.change,commandIndex:index});
  results.push({index,kind:command.kind,taskId:id,beforeVersion,afterVersion:result.task.version,outcome:result.outcome});
 }
 return {changes,receipt:{receiptId,contractVersion:1,effectKey:group.effectKey,outcome:changes.length?'applied':'no_change',
 commandResults:results,localIdMap:Object.fromEntries(locals),snapshots:[...touched.values()],error:null}};
}
