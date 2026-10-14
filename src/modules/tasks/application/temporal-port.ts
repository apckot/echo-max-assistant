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
