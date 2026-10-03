import type { ConversationId, UserId } from '../../../shared/types/identity.js';

export type InboundEventId = string & { readonly __inboundEventId: unique symbol };

export type InboundPayload =
  | { readonly kind: 'text'; readonly text: string; readonly replyToMessageId?: string }
  | { readonly kind: 'voice'; readonly media: { readonly url: string; readonly token: string }; readonly replyToMessageId?: string }
  | { readonly kind: 'button'; readonly callbackPayload: string; readonly replyToMessageId?: string }
  | { readonly kind: 'lifecycle'; readonly lifecycleType: 'started' | 'stopped' };

export type PreparationStatus = 'ready' | 'preparing' | 'failed';
export type ProcessingStatus = 'accepted' | 'processing' | 'applied' | 'failed' | 'ignored';
export type InboundFailureCode = 'invalid_payload' | 'capability_unavailable' | 'processing_error' | 'retry_exhausted';

export interface InboundEvent {
  readonly id: InboundEventId;
  readonly userId: UserId;
  readonly conversationId: ConversationId;
  readonly providerEventKey: string;
  readonly sequence: bigint;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly timezoneSnapshot: string;
  readonly payload: InboundPayload;
  readonly rawSha256: string;
  readonly preparationStatus: PreparationStatus;
  readonly processingStatus: ProcessingStatus;
  readonly failureCode: InboundFailureCode | null;
  readonly attemptCount: number;
  readonly preparationStartedAt: Date | null;
  readonly processingStartedAt: Date | null;
  readonly processedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const own = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function validateInboundPayload(value: unknown): value is InboundPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  let valid = false;
  switch (payload.kind) {
    case 'text':
      valid = own(payload, ['kind', 'text', 'replyToMessageId']) && nonempty(payload.text) &&
        [...payload.text].length <= 16_000 && Buffer.byteLength(payload.text, 'utf8') <= 64 * 1024;
      break;
    case 'voice': {
      const media = payload.media;
      valid = own(payload, ['kind', 'media', 'replyToMessageId']) && typeof media === 'object' &&
        media !== null && !Array.isArray(media) && own(media as Record<string, unknown>, ['url', 'token']) &&
        nonempty((media as Record<string, unknown>).url) && nonempty((media as Record<string, unknown>).token);
      break;
    }
    case 'button':
      valid = own(payload, ['kind', 'callbackPayload', 'replyToMessageId']) && typeof payload.callbackPayload === 'string';
      break;
    case 'lifecycle':
      valid = own(payload, ['kind', 'lifecycleType']) &&
        (payload.lifecycleType === 'started' || payload.lifecycleType === 'stopped');
      break;
  }
  return valid && (payload.replyToMessageId === undefined || nonempty(payload.replyToMessageId)) &&
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= 128 * 1024;
}
