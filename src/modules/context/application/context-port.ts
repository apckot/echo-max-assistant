import type {UserId} from '../../../shared/types/identity.js';
import type {DeliveredAnchor} from './context-pack.js';
export interface ContextReader {
 replyChoices?(userId:UserId,conversationId:string,messageId:string):Promise<readonly {id:string;revision:number}[]>;
 pending?(userId:UserId,conversationId:string):Promise<readonly {label:string;topic:string}[]>;
 anchor(userId:UserId,conversationId:string,messageId:string):Promise<DeliveredAnchor|null>;
 history(userId:UserId,conversationId:string,sourceAt:string):Promise<readonly {role:'user'|'assistant';text:string}[]>;
}
