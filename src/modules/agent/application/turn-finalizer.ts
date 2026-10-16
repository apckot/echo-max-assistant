import type {TurnTicket} from './turn-port.js';
import type {AssistantInboundResult} from '../../intake/application/inbound-handler.js';
import type {ConversationLease} from '../../intake/application/conversation-queue.js';
import type {TurnCoordinator} from './turn-coordinator.js';
import type {GroupRunner} from './group-runner.js';
export interface FinalizerPort {finalize(ticket:TurnTicket):Promise<AssistantInboundResult>}
export class AssistantProcess {
 constructor(private readonly coordinator:TurnCoordinator,private readonly groups:GroupRunner,private readonly finalizer:FinalizerPort){}
 async run(lease:ConversationLease,signal?:AbortSignal){const staged=await this.coordinator.run(lease,signal);if(!('ticket' in staged))return {kind:'drained' as const};if(staged.status==='accepted')await this.groups.run(staged.ticket);return {kind:'actionable' as const,value:await this.finalizer.finalize(staged.ticket)};}
}
