import type {UserId} from '../../../shared/types/identity.js';
import type {Task,TaskError,TaskStatus} from '../domain/task.js';
export interface TaskReadContext {readonly userId:UserId;readonly capability:'task_read';readonly timezone:string}
export interface ListTasksQuery {readonly view?:'all'|'open'|'day'|'overdue';readonly statuses?:readonly TaskStatus[];readonly day?:string;readonly timezone?:string;readonly text?:string;readonly limit?:number;readonly cursor?:string|null}
export interface TaskPage {readonly items:readonly Task[];readonly nextCursor:string|null;readonly asOf:string}
export interface TaskSort {readonly at:string;readonly id:string;readonly dayTime:string|null}
export interface ResolvedTaskList {readonly view:'all'|'open'|'day'|'overdue';readonly statuses:readonly TaskStatus[];readonly day:string|null;readonly timezone:string;readonly text:string|null;readonly limit:number;
 readonly asOf:string;readonly start:string|null;readonly end:string|null;readonly last:TaskSort|null;readonly deadlines:readonly {date:string;timezone:string;end_at:string}[]}
export interface TaskReadSession {
 readonly transactionNow:string;
 storageTimezone(input:string,canonical:string):Promise<string|null>;
 digest(value:readonly unknown[]):string;encodeCursor(value:unknown):string;decodeCursor(value:string):unknown;
 get(id:string):Promise<Task|null>;
 deadlines():Promise<readonly {date:string;timezone:string}[]>;
 list(query:ResolvedTaskList):Promise<readonly {task:Task;sort:TaskSort}[]>;
 events(query:ResolvedTaskEvents):Promise<readonly TaskEvent[]>;
}
export interface TaskReadRunner {run<T>(context:TaskReadContext,fn:(session:TaskReadSession)=>Promise<T>):Promise<T|{error:TaskError}>}

export interface TaskEvent {readonly eventId:string;readonly userId:UserId;readonly taskId:string;readonly receiptId:string;readonly index:number;readonly kind:string;
 readonly beforeVersion:number|null;readonly afterVersion:number;readonly before:Task|null;readonly after:Task;readonly recordedAt:string;
 readonly actor:'owner'|'operator'|'import';readonly source:{kind:'typed';operationId:string}|{kind:'turn';turnId:string};readonly sourceOccurredAt:string}
export interface TaskEventPage {readonly items:readonly TaskEvent[];readonly nextCursor:string|null;readonly asOf:string}
export interface TaskHistoryQuery {readonly taskId:string;readonly limit?:number;readonly cursor?:string|null}
export interface TaskChangesQuery {readonly since?:string;readonly limit?:number;readonly cursor?:string|null}
export interface EventSort {readonly afterVersion:number;readonly at:string;readonly id:string}
export interface ResolvedTaskEvents {readonly taskId:string|null;readonly since:string|null;readonly limit:number;readonly asOf:string;readonly last:EventSort|null}
