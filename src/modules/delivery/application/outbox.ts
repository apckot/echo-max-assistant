import type { OutboundMessageDraft } from '../domain/outbound-message.js';

export interface OutboxSource {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
}

export interface OutboxPort {
  save(source: OutboxSource, messages: readonly OutboundMessageDraft[]): Promise<void>;
}

export class OutboxMismatchError extends Error {
  constructor() { super('Outbound message conflicts with its immutable source'); }
}
