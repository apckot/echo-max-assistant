import type { DeliveryAttempt } from '../../modules/delivery/application/delivery-admission.js';
import type { DeliveryLease } from '../../modules/delivery/application/delivery-queue.js';
import type { DeliveryCompletion, DeliveryCompletionResult, DeliveryOutcome, DeliveryScheduling } from '../../modules/delivery/application/delivery-completion.js';
import type { Database } from './database.js';
import { PostgresFencedDelivery } from './postgres-fenced-delivery.js';

const invalid = () => new Error('Delivery completion state invalid');
const notSentCodes = ['invalid_input', 'rate_limited', 'rejected', 'preconnection_failure', 'rate_limit_unschedulable'];
const uncertainCodes = ['timeout', 'transport_failure', 'invalid_response', 'response_too_large',
  'server_failure', 'unexpected_status', 'sender_exception'];
const validDelay = (delay: number) => Number.isSafeInteger(delay) && delay >= 0;

export class PostgresDeliveryCompletion implements DeliveryCompletion {
  constructor(private readonly database: Pick<Database, 'tenantTransaction'>) {}
  async complete(lease: DeliveryLease, attempt: DeliveryAttempt, outcome: DeliveryOutcome,
    scheduling: DeliveryScheduling): Promise<DeliveryCompletionResult> {
    return new PostgresFencedDelivery(this.database).run<DeliveryCompletionResult>(lease, async (tx, context) => {
      const ids = [lease.outboundMessageId, lease.userId];
      if (attempt.outboundMessageId !== lease.outboundMessageId || attempt.userId !== lease.userId ||
        attempt.ownerId !== lease.ownerId || attempt.leaseGeneration !== lease.leaseGeneration ||
        attempt.attemptNumber !== context.attemptCount || context.outboundStatus !== 'sending') throw invalid();
      const [started] = await tx.query(`SELECT 1 FROM public.delivery_attempts s
        WHERE s.outbound_message_id=$1::uuid AND s.user_id=$2::uuid AND s.attempt_number=$3
          AND s.phase='started' AND s.lease_owner=$4::uuid AND s.lease_generation=$5::bigint
          AND NOT EXISTS (SELECT 1 FROM public.delivery_attempts c
            WHERE c.outbound_message_id=s.outbound_message_id AND c.attempt_number=s.attempt_number AND c.phase='completed')`,
      [...ids, attempt.attemptNumber, attempt.ownerId, attempt.leaseGeneration.toString()]);
      if (!started || !['terminal', 'retry'].includes(scheduling.kind) ||
        !(outcome.status === 'sent' ? typeof outcome.externalMessageId === 'string' && outcome.externalMessageId.length > 0
          : outcome.status === 'not_sent' ? notSentCodes.includes(outcome.code)
            : outcome.status === 'uncertain' && uncertainCodes.includes(outcome.code))) throw invalid();

      let status: DeliveryCompletionResult['status'] = outcome.status;
      let errorCode: string | null = outcome.status === 'sent' ? null : outcome.code;
      let availableAt: Date | undefined;
      // Scheduling never rewrites actual certainty. Even a mistaken policy cannot
      // retry possible dispatch, permanent rejection, or an unschedulable restriction.
      if (outcome.status === 'not_sent' && outcome.code !== 'rate_limit_unschedulable' && outcome.retryable === true) {
        if (context.attemptCount >= 6) {
          status = 'dead';
          errorCode = 'attempt_budget_exhausted';
        } else if (scheduling.kind === 'retry') {
          const minimum = outcome.retryAfterMs ?? 0;
          const [clock] = await tx.query<{ epoch_ms: string }>(
            'SELECT ceil(extract(epoch FROM clock_timestamp()) * 1000)::text AS epoch_ms');
          const now = Number(clock?.epoch_ms);
          const due = now + Math.max(scheduling.delayMs, minimum);
          // Round DB microseconds upward; never truncate Retry-After, clamp it
          // downward, or route a durable delay through a JavaScript timer.
          if (validDelay(scheduling.delayMs) && validDelay(minimum) && validDelay(now) &&
            Number.isSafeInteger(due) && due <= 8_640_000_000_000_000) {
            status = 'retry';
            availableAt = new Date(due);
          } else {
            status = 'dead';
            errorCode = 'retry_delay_unschedulable';
          }
        }
      }
      await tx.query(`INSERT INTO public.delivery_attempts
        (outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,certainty,code,external_message_id)
        VALUES ($1::uuid,$2::uuid,$3,'completed',$4::uuid,$5::bigint,$6,$7,$8)`,
      [...ids, attempt.attemptNumber, attempt.ownerId, attempt.leaseGeneration.toString(), outcome.status,
        outcome.status === 'sent' ? null : outcome.code, outcome.status === 'sent' ? outcome.externalMessageId : null]);
      await tx.query('UPDATE public.outbound_messages SET status=$3,updated_at=clock_timestamp() WHERE id=$1::uuid AND user_id=$2::uuid',
        [...ids, status]);
      // Leave ownership intact until the helper's final guarded disposition.
      await tx.query('UPDATE public.delivery_work SET last_error_code=$3 WHERE outbound_message_id=$1::uuid AND user_id=$2::uuid',
        [...ids, errorCode]);
      if (availableAt) return { value: { status: 'retry', availableAt }, disposition: { state: 'retry', availableAt } };
      if (status === 'retry') throw invalid();
      return { value: { status }, disposition: { state: status === 'not_sent' ? 'dead' : status } };
    });
  }
}
