import type {Task} from '../../tasks/domain/task.js';
import type {InternalContextPack} from '../../semantic/application/provider-port.js';
export interface TaskBinding {readonly id:string;readonly version:number}
export interface DeliveredAnchor {readonly label:string;readonly kind:'reply'|'list';readonly tasks:readonly TaskBinding[]}
export interface SourceSnapshot {readonly text:string;readonly sourceLabel:string;readonly sourceAt:string;readonly timezone:string;readonly replyMessageId?:string}
export interface ContextSnapshot {readonly source:SourceSnapshot;readonly provider:InternalContextPack;readonly bindings:Readonly<Record<string,TaskBinding>>;readonly anchors:readonly DeliveredAnchor[];readonly taskSnapshots?:readonly Task[]}
export function freeze<T>(value:T):T {if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
