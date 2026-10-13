import type { TaskChange } from '../domain/transitions.js';
export interface TaskEffectsPolicy {apply(change:TaskChange&{readonly eventId:string}):Promise<void>}
export class NoopTaskEffectsPolicy implements TaskEffectsPolicy {
 async apply(_change:TaskChange&{readonly eventId:string}):Promise<void> {}
}
