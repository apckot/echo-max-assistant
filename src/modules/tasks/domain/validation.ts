import { z } from 'zod';
import type { TaskCommand } from './commands.js';
import { MAX_TASK_VERSION, type TaskError } from './task.js';
export const internalUuid = z.uuid().refine(v => !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v));
const localId=z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const title=z.string().refine(v=>!/[\p{Cc}\u2028\u2029]/u.test(v)).transform(v=>v.trim())
 .refine(v=>[...v].length>=1&&[...v].length<=500);
const description=z.string().refine(v=>!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(v))
 .transform(v=>v.trim()).refine(v=>[...v].length<=10000).transform(v=>v||null).nullable();
const deadline=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('date'),date:z.string()}).strict(),
 z.object({kind:z.literal('instant'),at:z.string()}).strict(),
]).nullable();
const target=z.union([z.object({taskId:internalUuid}).strict(),z.object({created:localId}).strict()]);
const patch=z.object({title:title.optional(),description:description.optional(),targetDate:z.string().nullable().optional(),
 scheduledAt:z.string().nullable().optional(),deadline:deadline.optional(),timezone:z.string().optional()}).strict()
 .refine(v=>Object.keys(v).length>0);
const expectedVersion=z.number().int().min(1).max(MAX_TASK_VERSION);
const command=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('create'),localId,title,description:description.default(null),targetDate:z.string().nullable().default(null),
 scheduledAt:z.string().nullable().default(null),deadline:deadline.default(null),timezone:z.string().optional()}).strict(),
 z.object({kind:z.literal('update'),target,expectedVersion,patch}).strict(),
 ...(['complete','cancel','reopen'] as const).map(kind=>z.object({kind:z.literal(kind),target,expectedVersion}).strict()),
]);
export function normalizeCommand(input:unknown):TaskCommand|TaskError {
 if(hasUndefinedOrCycle(input))return {code:'invalid_command'};
 const parsed=command.safeParse(input);
 if(parsed.success) return normalizeTemporalCommand(parsed.data);
 const paths=parsed.error.issues.map(issue=>issue.path.at(-1));
 return {code:paths.includes('title')?'invalid_title':paths.includes('description')?'invalid_description':'invalid_command'};
}

export function validDate(value:string):boolean {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'0001-01-01'||value>'9999-12-31') return false;
 const date=new Date(value+'T00:00:00.000Z');
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
export function normalizeInstant(value:string):string|TaskError {
 const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!match||!validDate(match[1]!)||Number(match[2])>23||Number(match[3])>59||Number(match[4])>59||
 (match[6]!=='Z'&&(Number(match[6]!.slice(1,3))>23||Number(match[6]!.slice(4))>59))) return {code:'invalid_time'};
 const date=new Date(value);
 if(!Number.isFinite(date.getTime())||date.getUTCFullYear()<1||date.getUTCFullYear()>9999) return {code:'invalid_time'};
 return date.toISOString();
}
export function normalizeTemporalCommand(command:TaskCommand):TaskCommand|TaskError {
 const values=command.kind==='create'?command:command.kind==='update'?command.patch:null;
 if(!values) return command;
 for(const date of [values.targetDate,values.deadline?.kind==='date'?values.deadline.date:null])
 if(date!=null&&!validDate(date)) return {code:'invalid_time'};
 let scheduledAt=values.scheduledAt;
 if(scheduledAt!=null){const normalized=normalizeInstant(scheduledAt);if(typeof normalized!=='string')return normalized;scheduledAt=normalized;}
 let deadline=values.deadline;
 if(deadline?.kind==='instant'){const at=normalizeInstant(deadline.at);if(typeof at!=='string')return at;deadline={kind:'instant',at};}
 const normalized={...values,...('scheduledAt' in values?{scheduledAt}:{}),...('deadline' in values?{deadline}:{})};
 return command.kind==='create'?normalized as TaskCommand:{...command,patch:normalized} as TaskCommand;
}
export function validateSchedule(values:{scheduledAt:string|null;dueAt:string|null;dueDate:string|null},scheduledLocalDate:string|null):TaskError|null {
 if(values.dueAt&&values.dueDate) return {code:'invalid_schedule'};
 if(values.scheduledAt&&values.dueAt&&values.scheduledAt>values.dueAt) return {code:'invalid_schedule'};
 if(values.scheduledAt&&values.dueDate&&(!scheduledLocalDate||scheduledLocalDate>values.dueDate))return {code:'invalid_schedule'};
 return null;
}

function hasUndefinedOrCycle(value:unknown,path=new Set<object>()):boolean {
 if(value===undefined)return true;
 if(value===null||typeof value!=='object')return false;
 if(path.has(value))return true;
 path.add(value);const invalid=Object.values(value).some(child=>hasUndefinedOrCycle(child,path));path.delete(value);return invalid;
}
