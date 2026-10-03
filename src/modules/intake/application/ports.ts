import type { InboundEventId, InboundPayload } from '../domain/inbound-event.js';

export interface IntakeInput {
  readonly providerEventKey: string;
  readonly occurredAt: Date;
  readonly payload: InboundPayload;
  readonly rawSha256: string;
}

export interface IntakeResult {
  readonly inboundEventId: InboundEventId;
  readonly status: 'created' | 'duplicate';
}

// The infrastructure adapter binds authenticated channel identity to this store.
export interface IntakeStore {
  persist(input: IntakeInput): Promise<IntakeResult>;
}
