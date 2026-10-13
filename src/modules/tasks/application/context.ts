import type { UserId } from '../../../shared/types/identity.js';
import type { TaskCommand, TaskTarget } from '../domain/commands.js';
export interface ExplicitTaskIntent {readonly kind:TaskCommand['kind'];readonly binding:TaskTarget;
 readonly affirmative:boolean;readonly asserted:boolean;readonly ownerAuthored:boolean;readonly quoted:boolean}
export interface TaskExecutionContext {readonly userId:UserId;readonly actor:'owner'|'operator'|'import';readonly capability:'task_write';
 readonly source:{readonly kind:'typed';readonly operationId:string}|{readonly kind:'turn';readonly turnId:string};
 readonly sourceOccurredAt:string;readonly timezoneSnapshot:string;readonly intents:readonly ExplicitTaskIntent[]}
// Composition supplies an authenticated internal principal separately from command JSON.
export function ownerTaskContext(userId:UserId,source:TaskExecutionContext['source'],sourceOccurredAt:string,
 timezoneSnapshot:string,intents:readonly ExplicitTaskIntent[]):TaskExecutionContext {
 return {userId,actor:'owner',capability:'task_write',source,sourceOccurredAt,timezoneSnapshot,intents};
}
