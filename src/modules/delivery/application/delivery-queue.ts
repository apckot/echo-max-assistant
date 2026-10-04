import type { UserId } from '../../../shared/types/identity.js';

// Claiming technical work never authorizes a send. Durable tenant admission must
// succeed separately; an abandoned admitted attempt requires uncertain recovery.
export interface DeliveryLease {
  readonly outboundMessageId: string;
  readonly userId: UserId;
  readonly ownerId: string;
  readonly leaseGeneration: bigint;
  // Observational: a same-generation renewal does not revoke this token.
  readonly leaseUntil: Date;
  readonly attemptCount: number;
}

export interface ClaimDeliveryWork {
  readonly ownerId: string;
  readonly limit: number;
  readonly leaseMs?: number;
}

export interface DeliveryQueue {
  claim(input: ClaimDeliveryWork): Promise<readonly DeliveryLease[]>;
  renew(lease: DeliveryLease, leaseMs?: number): Promise<Date | null>;
}
