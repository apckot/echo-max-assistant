import type { OutboundMessageDraft } from '../domain/outbound-message.js';
import type { DeliveryLease } from './delivery-queue.js';

export type DeliveryAttempt = Readonly<Pick<DeliveryLease,
  'outboundMessageId' | 'userId' | 'ownerId' | 'leaseGeneration'> & { attemptNumber: number }>;
export type AdmissionResult =
  | { readonly status: 'admitted'; readonly recipientAddress: string; readonly message: OutboundMessageDraft; readonly attempt: DeliveryAttempt }
  | { readonly status: 'deferred'; readonly availableAt: Date }
  | { readonly status: 'in_flight' | 'uncertain' | 'terminal' | 'cancelled' | 'exhausted' };
export interface DeliveryAdmission {
  // Only an acknowledged admitted result authorizes one sender invocation.
  admit(lease: DeliveryLease): Promise<AdmissionResult>;
}
