import type {Task} from '../../tasks/domain/task.js';
import type {InternalContextPack} from '../../semantic/application/provider-port.js';
export interface TaskBinding {readonly id:string;readonly version:number;readonly snapshot?:Task}
export interface DeliveredAnchor {readonly label:string;readonly kind:'reply'|'list';readonly tasks:readonly TaskBinding[]}
export interface SourceSnapshot {readonly kind?:'text'|'transcript';readonly text:string;readonly sourceLabel:string;readonly sourceAt:string;readonly timezone:string;readonly replyMessageId?:string;readonly audioChecksum?:string}
export interface ContextSnapshot {readonly replyHasChoices?:boolean;readonly replyChoice?:{readonly id:string;readonly revision:number};readonly source:SourceSnapshot;readonly provider:InternalContextPack;readonly bindings:Readonly<Record<string,TaskBinding>>;readonly anchors:readonly DeliveredAnchor[];readonly taskSnapshots?:readonly Task[]}
export function freeze<T>(value:T):T {if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
