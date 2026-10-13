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
 const parsed=command.safeParse(input);
 if(parsed.success) return parsed.data;
 const paths=parsed.error.issues.map(issue=>issue.path.at(-1));
 return {code:paths.includes('title')?'invalid_title':paths.includes('description')?'invalid_description':'invalid_command'};
}
