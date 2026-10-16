import type {ResolvedGroup} from '../../semantic/application/decision-validator.js';
import {TemporalNormalizer} from '../../semantic/application/temporal-normalizer.js';
import type {ContextSnapshot} from '../../context/application/context-pack.js';
import type {TemporalPort} from '../../tasks/application/temporal-port.js';
import type {Task} from '../../tasks/domain/task.js';
import type {TaskEvent} from '../../tasks/application/query-types.js';
import type {TaskReceipt} from '../../tasks/application/task-commands.js';
import type {TaskCommand,TaskPatch,TaskTarget} from '../../tasks/domain/commands.js';
import type {UserId} from '../../../shared/types/identity.js';
import {createTask,transition} from '../../tasks/domain/transitions.js';
import type {PlannedGroup,TurnTicket} from './turn-port.js';
export type QueryOutcome={readonly kind:'tasks';readonly day:string|null;readonly items:readonly Task[];readonly asOf:string;readonly nextCursor:string|null}|{readonly kind:'history';readonly items:readonly TaskEvent[];readonly asOf:string}|{readonly kind:'capabilities';readonly text:string}|{readonly kind:'unavailable';readonly reason:string};
import type {SavedChoice} from './choice-executor.js';
export interface GroupOutcome {readonly choice?:SavedChoice;readonly label:string;readonly outcome:'applied'|'no_change'|'rejected'|'blocked'|'choice'|'respond';readonly receipt:TaskReceipt|null;readonly reasons:readonly string[];readonly queryResults?:readonly QueryOutcome[]}
export interface GroupExecutor {runGroup(ticket:TurnTicket,index:number):Promise<GroupOutcome>}
export class GroupRunner {
 constructor(private readonly executor:GroupExecutor){}
 async run(ticket:TurnTicket):Promise<readonly GroupOutcome[]>{const results:GroupOutcome[]=[];for(let i=0;i<(ticket.plan?.groups.length??0);i++)results.push(await this.executor.runGroup(ticket,i));return results;}
}
/** Converts validated fields only; lifecycle/schedule/version rules remain the public Tasks domain's rules. */
export function compileGroups(groups:readonly ResolvedGroup[],context:ContextSnapshot,userId:UserId,time:TemporalPort):readonly PlannedGroup[]{
 const dates=new TemporalNormalizer(time);
 return groups.map(group=>{
  if(group.status!=='ready')return {...group,commands:[]};
  const commands:TaskCommand[]=[],tasks=new Map((context.taskSnapshots??[]).map(t=>[t.id,t])),locals=new Map<string,string>();
  const pending=[...group.actions];let serial=0;
  const reject=(code:string):PlannedGroup=>({...group,status:'blocked',reasons:[...group.reasons,'TASK_'+code],commands:[]});
  while(pending.length){
   const index=pending.findIndex(a=>a.target?.status!=='created'||locals.has(a.target.actionLabel!));if(index<0)return reject('dependency');
   const action=pending.splice(index,1)[0]!,draft=action.draft;if(action.time.status!=='resolved')return reject('time');
   const patch:TaskPatch={...(draft.fields.title!==null?{title:draft.fields.title}:{}),...(draft.fields.description!==null?{description:draft.fields.description}:{})};
   for(const field of draft.fields.clearFields)Object.assign(patch,{[field]:null});
   for(const value of action.time.values){if(value.field==='targetDate'&&'date' in value)Object.assign(patch,{targetDate:value.date});else if(value.field==='scheduledAt'&&'at' in value)Object.assign(patch,{scheduledAt:value.at});else if(value.field==='deadline')Object.assign(patch,{deadline:'date' in value?{kind:'date',date:value.date}:{kind:'instant',at:value.at}});}
   // Explicit date in a new timed task / a full appointment reschedule also gives its list day.
   for(const [i,value] of action.time.values.entries())if('at' in value&&(value.field==='scheduledAt'||draft.kind==='create')){const date=dates.dateExpression(draft.times[i]!.expression,context.source);if(date&&patch.targetDate===undefined)Object.assign(patch,{targetDate:date});}
   if(draft.kind==='create'){
    const command:TaskCommand={kind:'create',localId:draft.label,title:draft.fields.title!,description:patch.description??null,targetDate:patch.targetDate??null,scheduledAt:patch.scheduledAt??null,deadline:patch.deadline??null,timezone:context.source.timezone};
    let id:string;do{id='ffffffff-ffff-4fff-8fff-'+String(++serial).padStart(12,'0');}while(tasks.has(id));
    const planned=createTask(command,{id,userId,timezone:context.source.timezone,recordedAt:context.source.sourceAt,scheduledLocalDate:command.scheduledAt?time.localDate(command.scheduledAt,context.source.timezone):null});if('code' in planned)return reject(planned.code);
    tasks.set(id,planned.task);locals.set(draft.label,id);commands.push(command);continue;
   }
   const target=action.target;if(!target||!['resolved','created'].includes(target.status))return reject('target');
   const bindings=target.status==='resolved'?target.targets:target.status==='created'?[{id:locals.get(target.actionLabel!)!,version:1}]:[];
   for(const binding of bindings){const captured='snapshot' in binding?binding.snapshot:undefined;if(captured&&(captured.userId!==userId||captured.id!==binding.id||captured.version!==binding.version))return reject('target_snapshot');const task=tasks.get(binding.id)??captured;if(!task)return reject('target_not_found');
    const reference:TaskTarget=target.status==='created'?{created:target.actionLabel!}:{taskId:binding.id};
    // First use is checked against its captured (including delivered-anchor) version, later uses the domain's simulated version.
    const touched=commands.some(c=>c.kind!=='create'&&JSON.stringify(c.target)===JSON.stringify(reference));
    const expectedVersion=touched?task.version:binding.version;
    const command:TaskCommand=draft.kind==='update'?{kind:'update',target:reference,expectedVersion,patch}:{kind:draft.kind,target:reference,expectedVersion};
    const scheduledAt=command.kind==='update'&&command.patch.scheduledAt!==undefined?command.patch.scheduledAt:task.scheduledAt;
    const planned=transition(task,{...command,target:{taskId:binding.id}},{recordedAt:context.source.sourceAt,scheduledLocalDate:scheduledAt?time.localDate(scheduledAt,task.timezone):null});if('code' in planned)return reject(planned.code);
    tasks.set(binding.id,planned.task);commands.push(command);
   }
  }
  return commands.length>20?reject('group_limit_exceeded'):{...group,commands};
 });
}
