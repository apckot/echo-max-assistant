import type { DeliveryAttempt } from './delivery-admission.js';
import type { DeliveryLease } from './delivery-queue.js';
import type { SendOutcome } from './sender.js';

export type DeliveryOutcome = SendOutcome | Readonly<{ status: 'uncertain'; code: 'sender_exception' }>;
export type DeliveryScheduling = Readonly<{ kind: 'terminal' }> | Readonly<{ kind: 'retry'; delayMs: number }>;
export type DeliveryCompletionResult =
  | Readonly<{ status: 'retry'; availableAt: Date }>
  | Readonly<{ status: 'sent' | 'uncertain' | 'not_sent' | 'dead' }>;
export interface DeliveryCompletion {
  complete(lease: DeliveryLease, attempt: DeliveryAttempt, outcome: DeliveryOutcome,
    scheduling: DeliveryScheduling): Promise<DeliveryCompletionResult>;
}
