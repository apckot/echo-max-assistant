import type {UserId} from '../../../shared/types/identity.js';
import type {DeliveredAnchor} from './context-pack.js';
export interface ContextReader {
 anchor(userId:UserId,conversationId:string,messageId:string):Promise<DeliveredAnchor|null>;
 history(userId:UserId,conversationId:string,sourceAt:string):Promise<readonly {role:'user'|'assistant';text:string}[]>;
}
