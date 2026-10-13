export type TaskTarget = { readonly taskId: string } | { readonly created: string };
export type Deadline = {readonly kind:'date';readonly date:string} | {readonly kind:'instant';readonly at:string} | null;
export interface TaskPatch {readonly title?:string;readonly description?:string|null;readonly targetDate?:string|null;
 readonly scheduledAt?:string|null;readonly deadline?:Deadline;readonly timezone?:string}
export interface CreateTask {readonly kind:'create';readonly localId:string;readonly title:string;
 readonly description:string|null;readonly targetDate:string|null;readonly scheduledAt:string|null;
 readonly deadline:Deadline;readonly timezone?:string}
export type ExistingTaskCommand = {readonly kind:'update';readonly target:TaskTarget;readonly expectedVersion:number;readonly patch:TaskPatch} |
 {readonly kind:'complete'|'cancel'|'reopen';readonly target:TaskTarget;readonly expectedVersion:number};
export type TaskCommand = CreateTask | ExistingTaskCommand;
export interface TaskCommandGroup {readonly contractVersion:1;readonly effectKey:string;readonly commands:readonly TaskCommand[]}
