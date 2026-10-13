import type { UserId } from '../../../shared/types/identity.js';
import type { CreateTask, ExistingTaskCommand, TaskCommand } from './commands.js';
import { MAX_TASK_VERSION, type Task, type TaskError } from './task.js';
import { normalizeCommand, validateSchedule } from './validation.js';
export interface TransitionFacts {readonly recordedAt:string;readonly scheduledLocalDate:string|null}
export interface TaskChange {readonly kind:TaskCommand['kind'];readonly taskId:string;readonly userId:UserId;
 readonly before:Task|null;readonly after:Task;readonly beforeVersion:number|null;readonly afterVersion:number}
export type TransitionResult = {readonly outcome:'applied'|'no_change';readonly task:Task;readonly change?:TaskChange}|TaskError;
function applied(before:Task|null,after:Task,kind:TaskCommand['kind']):TransitionResult {
 return {outcome:'applied',task:after,change:{kind,taskId:after.id,userId:after.userId,before,after,
  beforeVersion:before?.version??null,afterVersion:after.version}};
}
export function createTask(command:CreateTask,facts:TransitionFacts&{readonly id:string;readonly userId:UserId;readonly timezone:string}):TransitionResult {
 const valid=normalizeCommand(command);if('code' in valid)return valid;
 const task:Task={id:facts.id,userId:facts.userId,title:command.title,description:command.description,
  status:'open',targetDate:command.targetDate,scheduledAt:command.scheduledAt,
  dueDate:command.deadline?.kind==='date'?command.deadline.date:null,
  dueAt:command.deadline?.kind==='instant'?command.deadline.at:null,timezone:command.timezone??facts.timezone,version:1,
  createdAt:facts.recordedAt,updatedAt:facts.recordedAt,completedAt:null,cancelledAt:null};
 const error=validateSchedule(task,facts.scheduledLocalDate);return error??applied(null,task,'create');
}
export function transition(task:Task,command:ExistingTaskCommand,facts:TransitionFacts):TransitionResult {
 const normalized=normalizeCommand(command);if('code' in normalized)return normalized;
 if(normalized.kind==='create')return {code:'invalid_command'};
 command=normalized;
 if('taskId' in command.target&&command.target.taskId!==task.id)return {code:'task_not_found'};
 if(command.expectedVersion!==task.version)return {code:'version_conflict'};
 if(command.kind==='update'&&task.status!=='open'||command.kind==='complete'&&task.status==='cancelled'||
  command.kind==='cancel'&&task.status==='completed')return {code:'invalid_transition'};
 let after:Task;
 if(command.kind==='update'){
  const {deadline,...patch}=command.patch;
  after={...task,...patch,...('deadline' in command.patch?{dueDate:deadline?.kind==='date'?deadline.date:null,
   dueAt:deadline?.kind==='instant'?deadline.at:null}:{})};
 }else if(command.kind==='reopen')after={...task,status:'open',completedAt:null,cancelledAt:null};
 else if(command.kind==='complete')after=task.status==='completed'?task:{...task,status:'completed',completedAt:facts.recordedAt};
 else after=task.status==='cancelled'?task:{...task,status:'cancelled',cancelledAt:facts.recordedAt};
 if(Object.keys(task).every(key=>task[key as keyof Task]===after[key as keyof Task]))return {outcome:'no_change',task};
 const error=validateSchedule(after,facts.scheduledLocalDate);if(error)return error;
 if(task.version===MAX_TASK_VERSION)return {code:'version_exhausted'};
 return applied(task,{...after,version:task.version+1,updatedAt:facts.recordedAt},command.kind);
}
