import type { ConversationId, UserId } from '../../../shared/types/identity.js';

// A claim is one current fencing token for one conversation. Generations must
// remain monotonic while work for this conversation can be resumed.
export interface ConversationLease {
  readonly conversationId: ConversationId;
  readonly userId: UserId;
  readonly ownerId: string;
  readonly leaseGeneration: bigint;
  readonly leaseUntil: Date;
  // Counts recorded transient handler failures, not claims, lease expiry,
  // renewal, or polls while the head event is still preparing.
  readonly attemptCount: number;
}

export interface ClaimConversationWork {
  readonly ownerId: string;
  readonly limit: number;
  readonly leaseMs?: number;
}

export interface ConversationQueue {
  claim(input: ClaimConversationWork): Promise<readonly ConversationLease[]>;
  renew(lease: ConversationLease, leaseMs?: number): Promise<Date | null>;
}
