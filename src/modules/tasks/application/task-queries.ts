import {z} from 'zod';
import {internalUuid,validDate,normalizeInstant,nextCalendarDate} from '../domain/validation.js';
import type {TaskError} from '../domain/task.js';
import type {TemporalPort} from './ports.js';
import type {TaskPage,TaskReadContext,TaskReadRunner,TaskEventPage} from './query-types.js';
const contextSchema=z.object({userId:internalUuid,capability:z.literal('task_read'),timezone:z.string()}).strict();
const status=z.enum(['open','completed','cancelled']);
const listSchema=z.object({view:z.enum(['all','open','day','overdue']).default('open'),statuses:z.array(status).min(1).optional(),day:z.string().refine(validDate).optional(),
 timezone:z.string().optional(),text:z.string().transform(v=>v.trim().toLowerCase()).refine(v=>[...v].length>=1&&[...v].length<=200).optional(),limit:z.number().int().min(1).max(100).default(20),cursor:z.string().min(1).max(4096).nullable().optional()}).strict();
const sort=z.object({at:z.string(),id:internalUuid,dayTime:z.string().nullable()}).strict();
const listCursor=z.object({version:z.literal(1),kind:z.literal('tasks'),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),asOf:z.string(),last:sort}).strict();
const eventCursor=z.object({version:z.literal(1),kind:z.enum(['history','changes']),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),asOf:z.string(),last:z.object({afterVersion:z.number().int().min(1).max(2147483647),at:z.string(),id:internalUuid}).strict()}).strict();
const eventArgs=z.object({taskId:internalUuid.optional(),since:z.string().optional(),limit:z.number().int().min(1).max(100).default(20),cursor:z.string().min(1).max(4096).nullable().optional()}).strict();
const error=(code:TaskError['code'])=>({error:{code}});
export class TaskQueries {
 constructor(private readonly runner:TaskReadRunner,private readonly temporal:TemporalPort){}
 private context(input:unknown):TaskReadContext|TaskError{const p=contextSchema.safeParse(input);return !p.success?{code:'invalid_evidence'}:!this.temporal.validTimezone(p.data.timezone)?{code:'invalid_timezone'}:p.data as TaskReadContext;}
 get(input:unknown,id:string){const ctx=this.context(input);if('code' in ctx)return Promise.resolve(error(ctx.code));const parsed=internalUuid.safeParse(id);if(!parsed.success)return Promise.resolve(error('invalid_command'));return this.runner.run(ctx,s=>s.get(parsed.data));}
 async list(input:unknown,queryInput:unknown):Promise<TaskPage|{error:TaskError}>{
  const ctx=this.context(input);if('code' in ctx)return error(ctx.code);const parsed=listSchema.safeParse(queryInput);if(!parsed.success)return error('invalid_command');const q=parsed.data;
  if(q.view==='day'&&(!q.day||!q.timezone)||q.view!=='day'&&q.day||q.statuses&&q.view!=='day'&&q.view!=='all')return error('invalid_command');
  const zone=q.timezone??ctx.timezone,canonical=this.temporal.canonicalTimezone(zone);if(!canonical)return error('invalid_timezone');
  return this.runner.run(ctx,async s=>{
   const timezone=await s.storageTimezone(zone,canonical);if(!timezone)return error('invalid_timezone');
   const cursor=q.cursor?listCursor.safeParse(s.decodeCursor(q.cursor)):null;if(cursor&&!cursor.success)return error('invalid_command');
   const saved=cursor?.success?cursor.data:null;const asOf=saved?.asOf??s.transactionNow;
   if(normalizeInstant(asOf)!==asOf||saved&&(normalizeInstant(saved.last.at)!==saved.last.at||saved.last.dayTime!==null&&normalizeInstant(saved.last.dayTime)!==saved.last.dayTime))return error('invalid_command');
   const statuses=[...new Set(q.statuses??(q.view==='all'?['open','completed','cancelled'] as const:['open'] as const))].sort();
   const fingerprint=s.digest(['tasks-v1',ctx.userId,q.view,statuses,q.day??null,timezone,q.text??null,q.limit,asOf]);
   if(saved&&saved.fingerprint!==fingerprint)return error('invalid_command');
   const boundaries=q.view==='day'?{start:this.temporal.dayBoundary(q.day!,timezone),end:this.temporal.dayBoundary(nextCalendarDate(q.day!),timezone)}:{start:null,end:null};
   const deadlines=q.view==='overdue'?(await s.deadlines()).map(d=>({...d,end_at:this.temporal.dayBoundary(nextCalendarDate(d.date),d.timezone)})):[];
   const rows=await s.list({view:q.view,statuses,day:q.day??null,timezone,text:q.text??null,limit:q.limit,asOf,...boundaries,last:saved?.last??null,deadlines});
   const page=rows.slice(0,q.limit);return {items:page.map(r=>r.task),asOf,nextCursor:rows.length>q.limit?s.encodeCursor({version:1,kind:'tasks',fingerprint,asOf,last:page.at(-1)!.sort}):null};
  });
 }
 history(input:unknown,query:unknown){return this.eventPage(input,query,'history');}
 changes(input:unknown,query:unknown){return this.eventPage(input,query,'changes');}
 private async eventPage(input:unknown,query:unknown,kind:'history'|'changes'):Promise<TaskEventPage|{error:TaskError}>{
  const ctx=this.context(input);if('code' in ctx)return error(ctx.code);const parsed=eventArgs.safeParse(query);if(!parsed.success)return error('invalid_command');const q=parsed.data;
  if(kind==='history'&&(!q.taskId||q.since)||kind==='changes'&&q.taskId)return error('invalid_command');
  const since=q.since?normalizeInstant(q.since):null;if(since!==null&&typeof since!=='string')return error('invalid_time');
  return this.runner.run(ctx,async s=>{
   if(q.taskId&&!await s.get(q.taskId))return error('task_not_found');
   const cursor=q.cursor?eventCursor.safeParse(s.decodeCursor(q.cursor)):null;if(cursor&&!cursor.success)return error('invalid_command');const saved=cursor?.success?cursor.data:null;
   const asOf=saved?.asOf??s.transactionNow;if(normalizeInstant(asOf)!==asOf||saved&&normalizeInstant(saved.last.at)!==saved.last.at)return error('invalid_command');
   const fingerprint=s.digest([kind+'-v1',ctx.userId,q.taskId??null,since,q.limit,asOf]);if(saved&&(saved.kind!==kind||saved.fingerprint!==fingerprint))return error('invalid_command');
   const rows=await s.events({taskId:q.taskId??null,since,limit:q.limit,asOf,last:saved?.last??null});const page=rows.slice(0,q.limit),last=page.at(-1);
   return {items:page,asOf,nextCursor:rows.length>q.limit?s.encodeCursor({version:1,kind,fingerprint,asOf,last:{afterVersion:last!.afterVersion,at:last!.recordedAt,id:last!.eventId}}):null};
  });
 }

}
