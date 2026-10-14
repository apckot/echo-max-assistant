import type { TaskError } from '../domain/task.js';
export interface LocalDateTime {readonly date:string;readonly time:string;readonly timezone:string;readonly offset?:string}
export type TemporalResult = {readonly at:string;readonly timezone:string}|{readonly error:TaskError};
export interface TemporalPort {
 canonicalTimezone(timezone:string):string|null;
 validTimezone(timezone:string):boolean;
 resolveLocalTime(input:LocalDateTime):TemporalResult;
 localDate(at:string,timezone:string):string;
 dayBoundary(date:string,timezone:string):string;
}

import type { TaskCommandGroup, TaskCommand } from '../domain/commands.js';
import type { Task } from '../domain/task.js';
import type { TaskChange } from '../domain/transitions.js';
import type { TaskExecutionContext } from './context.js';
import type { TaskEffectsPolicy } from './task-effects-policy.js';
export interface TaskCommandResult {readonly index:number;readonly kind:TaskCommand['kind'];readonly taskId:string;
 readonly beforeVersion:number|null;readonly afterVersion:number;readonly outcome:'applied'|'no_change'}
export interface TaskReceipt {readonly receiptId:string;readonly contractVersion:1;readonly effectKey:string;
 readonly outcome:'applied'|'no_change'|'rejected';readonly commandResults:readonly TaskCommandResult[];
 readonly localIdMap:Readonly<Record<string,string>>;readonly snapshots:readonly Task[];readonly error:TaskError|null}
export type TaskExecutionResult = {readonly receipt:TaskReceipt;readonly replayed:boolean}|{readonly error:TaskError};
export interface CanonicalTaskPayload {readonly contractVersion:1;readonly commands:TaskCommandGroup['commands'];
 readonly actor:TaskExecutionContext['actor'];readonly source:TaskExecutionContext['source'];
 readonly sourceOccurredAt:string;readonly timezoneSnapshot:string;readonly intents:TaskExecutionContext['intents']}
export interface StoredTaskReceipt {readonly payloadHash:string;readonly canonicalPayload:CanonicalTaskPayload;readonly receipt:TaskReceipt}
export interface TaskCommandSession {
 readonly recordedAt:string;readonly effectsPolicy:TaskEffectsPolicy;
 newId():string;
 fingerprint(payload:CanonicalTaskPayload):{hash:string;canonicalPayload:CanonicalTaskPayload};
 storageTimezone(input:string,canonical:string):Promise<string|null>;
 lockTasks(ids:readonly string[]):Promise<readonly Task[]>;
 lockEffect(effectKey:string):Promise<void>;
 findReceipt(effectKey:string):Promise<StoredTaskReceipt|null>;
 persistChanges(changes:readonly (TaskChange&{readonly eventId:string;readonly commandIndex:number})[],receiptId:string):Promise<void>;
 persistReceipt(receipt:TaskReceipt,payload:CanonicalTaskPayload,hash:string):Promise<void>;
}
export interface TaskSessionRunner {
 run<T>(context:TaskExecutionContext,fn:(session:TaskCommandSession)=>Promise<T>):Promise<T|{error:TaskError}>;
}
