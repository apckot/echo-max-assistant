import {createHash} from 'node:crypto';
import type {Database,DbTx} from '../database.js';
import type {Task,TaskError} from '../../../modules/tasks/domain/task.js';
import type {TaskReadRunner,TaskReadContext,TaskReadSession,ResolvedTaskList,TaskSort} from '../../../modules/tasks/application/query-types.js';
function pgInstant(at:string|null):string|null{return at?.startsWith('0000-')?'0001-01-01T00:00:00.000Z':at?.replace(/^\+010000-/,'10000-')??null;}
async function list(tx:DbTx,userId:string,q:ResolvedTaskList){
 const params:unknown[]=[];const bind=(v:unknown)=>{params.push(v);return '$'+params.length;};
 const tenant=bind(userId),statuses=bind(q.statuses);const conditions=[`w.user_id=${tenant}::uuid`,`w.status=ANY(${statuses}::text[])`];
 let dayTime='NULL::timestamptz';
 if(q.text){const text=bind(q.text);conditions.push(`(strpos(lower(w.title),${text})>0 OR strpos(lower(coalesce(w.description,'')),${text})>0)`);}
 if(q.view==='day'){
  const day=bind(q.day),start=bind(pgInstant(q.start)),end=bind(pgInstant(q.end));
  const schedule=`w.scheduled_at>=${start}::timestamptz AND w.scheduled_at<${end}::timestamptz`,due=`w.due_at>=${start}::timestamptz AND w.due_at<${end}::timestamptz`;
  conditions.push(`(w.target_date=${day}::date OR w.due_date=${day}::date OR (${schedule}) OR (${due}))`);
  dayTime=`LEAST(CASE WHEN ${schedule} THEN w.scheduled_at END,CASE WHEN ${due} THEN w.due_at END)`;
 }
 if(q.view==='overdue'){
  const asOf=bind(q.asOf),bounds=bind(JSON.stringify(q.deadlines.map(d=>({...d,end_at:pgInstant(d.end_at)}))));
  conditions.push(`(w.due_at<${asOf}::timestamptz OR EXISTS(SELECT 1 FROM jsonb_to_recordset(${bounds}::jsonb) AS d(date text,timezone text,end_at timestamptz)
   WHERE d.date=w.due_date::text AND d.timezone=w.timezone AND ${asOf}::timestamptz>=d.end_at))`);
 }
 let cursor='TRUE';
 if(q.last){const at=bind(q.last.at),id=bind(q.last.id);const pair=`(created_at,id) ${q.view==='day'?'>':'<'} (${at}::timestamptz,${id}::uuid)`;
  if(q.view!=='day')cursor=pair;else if(q.last.dayTime===null)cursor=`day_time IS NULL AND ${pair}`;
  else{const time=bind(q.last.dayTime);cursor=`(day_time>${time}::timestamptz OR day_time IS NULL OR (day_time=${time}::timestamptz AND ${pair}))`;}
 }
 const limit=bind(q.limit+1),order=q.view==='day'?'day_time ASC NULLS LAST,created_at ASC,id ASC':'created_at DESC,id DESC';
 const rows=await tx.query<{task:Task;id:string;created_at:Date;day_time:Date|null}>(`WITH selected AS (
 SELECT public.task_row_snapshot(w) task,w.id,w.created_at,${dayTime} day_time FROM public.work_items w WHERE ${conditions.join(' AND ')})
 SELECT * FROM selected WHERE ${cursor} ORDER BY ${order} LIMIT ${limit}`,params);
 return rows.map(r=>({task:r.task,sort:{at:r.created_at.toISOString(),id:r.id,dayTime:r.day_time?.toISOString()??null}}));
}
export class PostgresTaskReadRunner implements TaskReadRunner {
 constructor(private readonly database:Pick<Database,'tenantTransaction'>){}
 run<T>(context:TaskReadContext,fn:(s:TaskReadSession)=>Promise<T>):Promise<T|{error:TaskError}>{
  return this.database.tenantTransaction('worker',context.userId,async tx=>{
   await tx.query('SELECT public.guard_worker_restore_fence()');const [user]=await tx.query<{status:string}>('SELECT status FROM public.users WHERE id=$1 FOR SHARE',[context.userId]);
   if(user?.status!=='active')return {error:{code:'account_unavailable'}};
   const [clock]=await tx.query<{transaction_now:Date}>('SELECT clock_timestamp() AS transaction_now');
   return fn({transactionNow:clock!.transaction_now.toISOString(),
    storageTimezone:async(input,canonical)=>{const [z]=await tx.query<{name:string}>('SELECT name FROM pg_catalog.pg_timezone_names WHERE lower(name)=lower($1) OR name=$2 ORDER BY (lower(name)=lower($1)) DESC,name LIMIT 1',[input,canonical]);return z?.name??null;},
    digest:value=>createHash('sha256').update(JSON.stringify(value)).digest('hex'),encodeCursor:value=>Buffer.from(JSON.stringify(value)).toString('base64url'),decodeCursor:value=>{try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{return null;}},
    get:async id=>{const [r]=await tx.query<{task:Task}>('SELECT public.task_row_snapshot(w) task FROM public.work_items w WHERE user_id=$1 AND id=$2',[context.userId,id]);return r?.task??null;},
    deadlines:()=>tx.query<{date:string;timezone:string}>("SELECT DISTINCT due_date::text date,timezone FROM public.work_items WHERE user_id=$1 AND status='open' AND due_date IS NOT NULL",[context.userId]),
    list:q=>list(tx,context.userId,q)});
  });
 }
}
