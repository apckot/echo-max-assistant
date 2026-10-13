import { z } from 'zod';
import type { TaskCommand } from '../domain/commands.js';
import { internalUuid } from '../domain/validation.js';
import type { TaskError } from '../domain/task.js';
const binding=z.union([z.object({taskId:internalUuid}).strict(),z.object({created:z.string()}).strict()]);
const evidenceContext=z.object({userId:internalUuid,actor:z.enum(['owner','operator','import']),capability:z.literal('task_write'),
 source:z.union([z.object({kind:z.literal('typed'),operationId:internalUuid}).strict(),z.object({kind:z.literal('turn'),turnId:internalUuid}).strict()]),
 sourceOccurredAt:z.string(),timezoneSnapshot:z.string(),
 intents:z.array(z.object({kind:z.enum(['create','update','complete','cancel','reopen']),binding,
 affirmative:z.boolean(),asserted:z.boolean(),ownerAuthored:z.boolean(),quoted:z.boolean()}).strict())}).strict();
export function validateEvidence(context:unknown,command:TaskCommand|TaskError,index=0):TaskError|null {
 const parsed=evidenceContext.safeParse(context);
 if(!parsed.success||'code' in command) return {code:'invalid_evidence'};
 if(parsed.data.actor!=='owner') return {code:'unsupported_actor'};
 const intent=parsed.data.intents[index];
 const target=command.kind==='create'?{created:command.localId}:command.target;
 if(!intent||intent.kind!==command.kind||!intent.affirmative||!intent.asserted||!intent.ownerAuthored||intent.quoted||
 ('taskId' in target? !('taskId' in intent.binding)||target.taskId!==intent.binding.taskId:
 !('created' in intent.binding)||target.created!==intent.binding.created)) return {code:'invalid_evidence'};
 return null;
}

export function parseExecutionContext(input:unknown):import('./context.js').TaskExecutionContext|TaskError {
 const parsed=evidenceContext.safeParse(input);
 if(!parsed.success)return {code:'invalid_evidence'};
 if(parsed.data.actor!=='owner')return {code:'unsupported_actor'};
 return {...parsed.data,userId:parsed.data.userId as import('../../../shared/types/identity.js').UserId};
}
