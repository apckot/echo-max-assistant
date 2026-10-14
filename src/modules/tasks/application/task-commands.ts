import { z } from 'zod';
import { normalizeCommand, normalizeInstant } from '../domain/validation.js';
import type { TaskCommand } from '../domain/commands.js';
import { parseExecutionContext } from './evidence.js';
import { planGroup } from './group-planner.js';
import type { CanonicalTaskPayload, TaskExecutionResult, TaskReceipt, TaskSessionRunner, TemporalPort } from './ports.js';
const envelope=z.object({contractVersion:z.literal(1),effectKey:z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/),commands:z.array(z.unknown()).min(1).max(20)}).strict();
export class TaskCommands {
 constructor(private readonly runner:TaskSessionRunner,private readonly temporal:TemporalPort){}
 async execute(contextInput:unknown,groupInput:unknown):Promise<TaskExecutionResult>{
  const context=parseExecutionContext(contextInput);if('code' in context)return {error:context};
  if(context.source.kind!=='typed')return {error:{code:'invalid_command'}};
  const occurred=normalizeInstant(context.sourceOccurredAt);if(typeof occurred!=='string')return {error:occurred};
  const timezoneSnapshot=this.temporal.canonicalTimezone(context.timezoneSnapshot);if(!timezoneSnapshot)return {error:{code:'invalid_timezone'}};
  const shape=envelope.safeParse(groupInput);if(!shape.success)return {error:{code:shape.error.issues.some(i=>i.path[0]==='commands'&&i.code==='too_big')?'group_limit_exceeded':'invalid_command'}};
  const commands:TaskCommand[]=[];
  for(const raw of shape.data.commands){const value=normalizeCommand(raw);if('code' in value)return {error:value};commands.push(value.kind==='create'?{...value,timezone:value.timezone??context.timezoneSnapshot}:value);}
  const group={...shape.data,commands};
  const stableContext={...context,sourceOccurredAt:occurred,timezoneSnapshot};
  // Zod parsed DTOs are independent of the caller's mutable input before awaiting DB work.
  const initialPayload:CanonicalTaskPayload={contractVersion:1,commands,actor:context.actor,source:context.source,
   sourceOccurredAt:occurred,timezoneSnapshot,intents:context.intents};
  return this.runner.run<TaskExecutionResult>(stableContext,async session=>{
   const resolvedSnapshot=await session.storageTimezone(context.timezoneSnapshot,timezoneSnapshot);
   if(!resolvedSnapshot)return {error:{code:'invalid_timezone'}};
   const storedCommands:TaskCommand[]=[];let badTimezone:import('../domain/task.js').TaskError|null=null;
   for(const [index,command] of group.commands.entries()){
    if(command.kind!=='create'&&(command.kind!=='update'||!command.patch.timezone)){storedCommands.push(command);continue;}
    const candidate=command.kind==='create'?command.timezone!:command.kind==='update'?command.patch.timezone!:'';const canonical=this.temporal.canonicalTimezone(candidate);
    const stored=canonical?await session.storageTimezone(candidate,canonical):null;
    if(!stored)badTimezone={code:'invalid_timezone',index};
    storedCommands.push(command.kind==='create'?{...command,timezone:stored??candidate}:command.kind==='update'?{...command,patch:{...command.patch,timezone:stored??candidate}}:command);
   }
   const payload={...initialPayload,commands:storedCommands,timezoneSnapshot:resolvedSnapshot};
   const resolvedContext={...stableContext,timezoneSnapshot:resolvedSnapshot};
   const resolvedGroup={...group,commands:storedCommands};
   const fingerprint=session.fingerprint(payload);
   await session.lockEffect(group.effectKey);
   const previous=await session.findReceipt(group.effectKey);
   if(previous){
    const old=session.fingerprint(previous.canonicalPayload);
    if(previous.payloadHash!==fingerprint.hash||JSON.stringify(old.canonicalPayload)!==JSON.stringify(fingerprint.canonicalPayload))return {error:{code:'idempotency_conflict'}};
    return {receipt:previous.receipt,replayed:true};
   }
   const receiptId=session.newId();
   const ids=storedCommands.flatMap(command=>command.kind!=='create'&&'taskId' in command.target?[command.target.taskId]:[]);
   const locked=await session.lockTasks(ids);
   const newIds=new Map(storedCommands.flatMap(command=>command.kind==='create'?[[command.localId,session.newId()] as const]:[]));
   const plan=badTimezone??planGroup(resolvedContext,resolvedGroup,locked,newIds,receiptId,session.recordedAt,this.temporal);
   let receipt:TaskReceipt;
   if('code' in plan){receipt={receiptId,contractVersion:1,effectKey:group.effectKey,outcome:'rejected',commandResults:[],
    localIdMap:{},snapshots:[],error:plan};}
   else{
    receipt=plan.receipt;
    const changes=plan.changes.map(change=>({...change,eventId:session.newId()}));
    await session.persistChanges(changes,receiptId);
    for(const change of changes)await session.effectsPolicy.apply(change);
   }
   await session.persistReceipt(receipt,fingerprint.canonicalPayload,fingerprint.hash);
   return {receipt,replayed:false};
  });
 }
}
