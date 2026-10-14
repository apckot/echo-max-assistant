import type { TaskCommandGroup } from '../domain/commands.js';
import { createTask, transition, type TaskChange } from '../domain/transitions.js';
import type { Task, TaskError } from '../domain/task.js';
import type { TaskExecutionContext } from './context.js';
import { validateEvidence } from './evidence.js';
import type { TaskReceipt, TemporalPort } from './ports.js';
export interface TaskGroupPlan {readonly changes:readonly (TaskChange&{readonly commandIndex:number})[];readonly receipt:TaskReceipt}
// Checkpoint40 deliberately publishes only a single-create typed harness. Existing-target
// persistence and multi-command groups are iterations41/42, not an alternate writer here.
export function planCreate(context:TaskExecutionContext,group:TaskCommandGroup,id:string,receiptId:string,
 recordedAt:string,temporal:TemporalPort):TaskGroupPlan|TaskError {
 if(group.commands.length!==1||group.commands[0]!.kind!=='create')return {code:'invalid_command'};
 const command=group.commands[0]!;
 const evidence=validateEvidence(context,command);if(evidence)return {...evidence,index:0};
 const timezone=command.timezone??context.timezoneSnapshot;
 if(!temporal.validTimezone(timezone))return {code:'invalid_timezone',index:0};
 const result=createTask(command,{id,userId:context.userId,timezone,recordedAt,
 scheduledLocalDate:command.scheduledAt?temporal.localDate(command.scheduledAt,timezone):null});
 if('code' in result)return {...result,index:0};
 const task:Task=result.task;
 return {changes:[{...result.change!,commandIndex:0}],receipt:{receiptId,contractVersion:1,effectKey:group.effectKey,outcome:'applied',
 commandResults:[{index:0,kind:'create',taskId:id,beforeVersion:null,afterVersion:1,outcome:'applied'}],
 localIdMap:{[command.localId]:id},snapshots:[task],error:null}};
}

export function planSingle(context:TaskExecutionContext,group:TaskCommandGroup,locked:readonly Task[],id:string,receiptId:string,recordedAt:string,temporal:TemporalPort):TaskGroupPlan|TaskError {
 if(group.commands.length!==1)return {code:'invalid_command'};
 const command=group.commands[0]!;if(command.kind==='create')return planCreate(context,group,id,receiptId,recordedAt,temporal);
 const evidence=validateEvidence(context,command);if(evidence)return {...evidence,index:0};
 if(!('taskId' in command.target))return {code:'invalid_local_reference',index:0};
 const taskId=command.target.taskId;const task=locked.find(t=>t.id===taskId);if(!task)return {code:'task_not_found',index:0};
 const scheduledAt=command.kind==='update'&&'scheduledAt' in command.patch?command.patch.scheduledAt:task.scheduledAt;
 const timezone=command.kind==='update'?command.patch.timezone??task.timezone:task.timezone;
 const result=transition(task,command,{recordedAt,scheduledLocalDate:scheduledAt?temporal.localDate(scheduledAt,timezone):null});
 if('code' in result)return {...result,index:0};
 return {changes:result.change?[{...result.change,commandIndex:0}]:[],receipt:{receiptId,contractVersion:1,effectKey:group.effectKey,outcome:result.outcome,
 commandResults:[{index:0,kind:command.kind,taskId:task.id,beforeVersion:task.version,afterVersion:result.task.version,outcome:result.outcome}],localIdMap:{},snapshots:[result.task],error:null}};
}
