import type { OutboundMessageDraft } from '../domain/outbound-message.js';

// retryAfterMs is a minimum. Persist a safe due date; delays > 2147483647 need
// timer chunks or durable scheduling, never an overflowing setTimeout or an earlier cap.
// Only missing/malformed headers omit the delay and permit a future fallback policy.
export type SendOutcome =
  | Readonly<{ status: 'sent'; externalMessageId: string }>
  | Readonly<{ status: 'not_sent'; code: 'invalid_input' | 'rate_limited' | 'rejected' | 'preconnection_failure'; retryable: boolean; retryAfterMs?: number }>
  // A valid restriction cannot be safely scheduled: no automatic retry or fallback backoff.
  | Readonly<{ status: 'not_sent'; code: 'rate_limit_unschedulable'; retryable: false }>
  | Readonly<{ status: 'uncertain'; code: 'timeout' | 'transport_failure' | 'invalid_response' | 'response_too_large' | 'server_failure' | 'unexpected_status' }>;

export interface OutboundSender {
  send(recipientAddress: string, message: OutboundMessageDraft): Promise<SendOutcome>;
}
