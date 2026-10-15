import type {ConversationLease} from '../../intake/application/conversation-queue.js';
import type {InboundEvent} from '../../intake/domain/inbound-event.js';
import type {ResolvedGroup} from '../../semantic/application/decision-validator.js';
import type {ContextSnapshot} from '../../context/application/context-pack.js';
export interface AcceptedPlan {readonly version:1;readonly context:ContextSnapshot;readonly groups:readonly ResolvedGroup[];readonly queries:readonly unknown[]}
export interface TurnTicket {readonly turnId:string;readonly runId:string;readonly event:InboundEvent;readonly lease:ConversationLease;readonly sourceDigest:string;readonly profileDigest:string;readonly phase:'claimed'|'started'|'accepted'|'failed';readonly plan:AcceptedPlan|null}
export interface TurnAuthority {
 claim(lease:ConversationLease,profileDigest:string):Promise<TurnTicket|null>;
 start(ticket:TurnTicket,context:unknown,sourceMap:unknown):Promise<void>;
 accept(ticket:TurnTicket,plan:AcceptedPlan):Promise<void>;
 fail(ticket:TurnTicket,reason:string):Promise<void>;
}
