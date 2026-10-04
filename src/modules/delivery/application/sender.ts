import type { OutboundMessageDraft } from '../domain/outbound-message.js';

export type SendOutcome =
  | Readonly<{ status: 'sent'; externalMessageId: string }>
  | Readonly<{ status: 'not_sent'; code: 'invalid_input' | 'rate_limited' | 'rejected' | 'preconnection_failure'; retryable: boolean; retryAfterMs?: number }>
  | Readonly<{ status: 'uncertain'; code: 'timeout' | 'transport_failure' | 'invalid_response' | 'response_too_large' | 'server_failure' | 'unexpected_status' }>;

export interface OutboundSender {
  send(recipientAddress: string, message: OutboundMessageDraft): Promise<SendOutcome>;
}
