import { randomUUID } from 'node:crypto';
import type { Database } from '../database.js';
import type { TaskExecutionContext } from '../../../modules/tasks/application/context.js';
import type { TaskCommandSession, TaskSessionRunner } from '../../../modules/tasks/application/ports.js';
import type { TaskError } from '../../../modules/tasks/domain/task.js';
import { NoopTaskEffectsPolicy } from '../../../modules/tasks/application/task-effects-policy.js';
import { fingerprint,findReceipt,persistReceipt } from './task-receipts.js';
import { persistTaskCreates } from './task-store.js';
export class PostgresTaskSessionRunner implements TaskSessionRunner {
 constructor(private readonly database:Pick<Database,'tenantTransaction'>){}
 run<T>(context:TaskExecutionContext,fn:(session:TaskCommandSession)=>Promise<T>):Promise<T|{error:TaskError}>{
  return this.database.tenantTransaction('worker',context.userId,async tx=>{
   await tx.query('SELECT public.guard_worker_restore_fence()');
   const [user]=await tx.query<{status:string}>('SELECT status FROM public.users WHERE id=$1 FOR SHARE',[context.userId]);
   if(user?.status!=='active')return {error:{code:'account_unavailable'}};
   const [clock]=await tx.query<{at:Date}>("SELECT date_trunc('milliseconds',clock_timestamp()) AS at");
   const session:TaskCommandSession={recordedAt:clock!.at.toISOString(),effectsPolicy:new NoopTaskEffectsPolicy(),newId:randomUUID,fingerprint,
    storageTimezone:async(input,canonical)=>{const [zone]=await tx.query<{name:string}>(
     'SELECT name FROM pg_catalog.pg_timezone_names WHERE lower(name)=lower($1) OR name=$2 ORDER BY (lower(name)=lower($1)) DESC,name LIMIT 1',[input,canonical]);return zone?.name??null;},
    lockEffect:async key=>{await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['tasks:'+context.userId+':'+key]);},
    findReceipt:key=>findReceipt(tx,context.userId,key),persistChanges:(changes,receiptId)=>persistTaskCreates(tx,changes,receiptId),
    persistReceipt:(receipt,payload,hash)=>persistReceipt(tx,context,receipt,payload,hash)};
   return fn(session);
  });
 }
}
