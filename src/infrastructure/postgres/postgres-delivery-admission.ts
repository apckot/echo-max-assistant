import type { AdmissionResult, DeliveryAdmission } from '../../modules/delivery/application/delivery-admission.js';
import type { DeliveryLease } from '../../modules/delivery/application/delivery-queue.js';
import { OutboundMessageDraftSchema } from '../../modules/delivery/domain/outbound-message.js';
import type { Database } from './database.js';
import { PostgresFencedDelivery } from './postgres-fenced-delivery.js';

interface AttemptRow {
  attempt_number: number;
  lease_owner: string;
  lease_generation: string;
  certainty: 'sent' | 'not_sent' | 'uncertain' | null;
}
const invalid = () => new Error('Delivery admission state invalid');

export class PostgresDeliveryAdmission implements DeliveryAdmission {
  constructor(private readonly database: Pick<Database, 'tenantTransaction'>) {}
  async admit(lease: DeliveryLease): Promise<AdmissionResult> {
    return new PostgresFencedDelivery(this.database).run<AdmissionResult>(lease, async (tx, context) => {
      const ids = [lease.outboundMessageId, lease.userId];
      const attempts = await tx.query<AttemptRow>(`SELECT s.attempt_number,s.lease_owner,s.lease_generation,c.certainty
        FROM public.delivery_attempts s LEFT JOIN public.delivery_attempts c
          ON c.outbound_message_id=s.outbound_message_id AND c.attempt_number=s.attempt_number AND c.phase='completed'
        WHERE s.outbound_message_id=$1::uuid AND s.user_id=$2::uuid AND s.phase='started' ORDER BY s.attempt_number`, ids);
      const last = attempts.at(-1);
      if (attempts.length !== context.attemptCount || attempts.some((a, i) =>
        a.attempt_number !== i + 1 || (i < attempts.length - 1 && a.certainty !== 'not_sent'))) throw invalid();
      const setStatus = async (status: string) => {
        await tx.query('UPDATE public.outbound_messages SET status=$3,updated_at=clock_timestamp() WHERE id=$1::uuid AND user_id=$2::uuid', [...ids, status]);
      };
      const status = context.outboundStatus;
      // Already admitted work keeps its actual certainty even after identity stop.
      if (status === 'sending') {
        if (!last || last.certainty !== null) throw invalid();
        if (last.lease_owner === lease.ownerId && BigInt(last.lease_generation) === lease.leaseGeneration)
          return { value: { status: 'in_flight' }, disposition: { state: 'keep' } };
        if (BigInt(last.lease_generation) >= lease.leaseGeneration) throw invalid();
        await tx.query(`INSERT INTO public.delivery_attempts
          (outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation,certainty,code)
          VALUES ($1::uuid,$2::uuid,$3,'completed',$4::uuid,$5::bigint,'uncertain','attempt_abandoned')`,
        [...ids, last.attempt_number, last.lease_owner, last.lease_generation]);
        await setStatus('uncertain');
        return { value: { status: 'uncertain' }, disposition: { state: 'uncertain' } };
      }
      if (['sent', 'not_sent', 'uncertain', 'dead', 'cancelled'].includes(status)) {
        const expected = status === 'dead' || status === 'cancelled' ? 'not_sent' : status;
        if ((last && last.certainty !== expected) || (!last && !['dead', 'cancelled'].includes(status))) throw invalid();
        const state = status === 'not_sent' ? 'dead' : status as 'sent' | 'uncertain' | 'dead' | 'cancelled';
        return { value: { status: 'terminal' }, disposition: { state } };
      }
      if (!((status === 'pending' && !last) || (status === 'retry' && last?.certainty === 'not_sent'))) throw invalid();
      // The existing fence holds the conversation lock before this read. A
      // monotonic cutoff cancels old sources even after a legitimate restart.
      const [cancellation] = await tx.query<{ cutoff: string; cancelled: boolean }>(`
        SELECT c.delivery_cancelled_through_sequence AS cutoff,
          i.sequence<=c.delivery_cancelled_through_sequence AS cancelled
        FROM public.outbound_messages o JOIN public.inbound_events i ON i.id=o.source_inbound_event_id
        JOIN public.conversations c ON c.id=o.conversation_id AND c.user_id=o.user_id
        WHERE o.id=$1::uuid AND o.user_id=$2::uuid`, ids);
      if (!cancellation) throw invalid();
      if (cancellation.cancelled || context.userStatus !== 'active' || context.accountState !== 'active' || context.conversationState !== 'active') {
        await setStatus('cancelled');
        return { value: { status: 'cancelled' }, disposition: { state: 'cancelled' } };
      }
      if (context.attemptCount >= 6) {
        await setStatus('dead');
        return { value: { status: 'exhausted' }, disposition: { state: 'dead' } };
      }
      // Round upward across PostgreSQL microseconds / JavaScript milliseconds.
      // Durable pacing uses database time and never sleeps while holding locks.
      const [ordering] = await tx.query<{ blocked: boolean; now: Date; next_start: Date | null }>(`
        SELECT clock_timestamp() AS now, EXISTS (
          SELECT 1 FROM public.outbound_messages p JOIN public.inbound_events pi ON pi.id=p.source_inbound_event_id
          JOIN public.outbound_messages current ON current.id=$1::uuid
          JOIN public.inbound_events ci ON ci.id=current.source_inbound_event_id
          WHERE p.conversation_id=$3::uuid AND p.user_id=$2::uuid AND p.status IN ('pending','sending','retry')
            AND (p.status='sending' OR pi.sequence>$4::bigint)
            AND (pi.sequence,p.message_index)<(ci.sequence,current.message_index)
        ) AS blocked, (SELECT date_trunc('milliseconds',max(a.recorded_at))+interval '501 milliseconds'
          FROM public.delivery_attempts a JOIN public.outbound_messages o ON o.id=a.outbound_message_id
          WHERE o.conversation_id=$3::uuid AND o.user_id=$2::uuid AND a.phase='started') AS next_start`, [...ids, context.conversationId, cancellation.cutoff]);
      if (!ordering) throw invalid();
      if (ordering.blocked || (ordering.next_start && ordering.next_start > ordering.now)) {
        const availableAt = new Date(Math.max(ordering.now.getTime() + 501, ordering.next_start?.getTime() ?? 0));
        return { value: { status: 'deferred', availableAt }, disposition: { state: 'retry', availableAt } };
      }
      const [outbound] = await tx.query<{ payload: unknown }>('SELECT payload FROM public.outbound_messages WHERE id=$1::uuid AND user_id=$2::uuid', ids);
      const parsed = OutboundMessageDraftSchema.safeParse(outbound?.payload);
      if (!parsed.success) throw invalid();
      const attemptNumber = context.attemptCount + 1;
      await tx.query(`INSERT INTO public.delivery_attempts
        (outbound_message_id,user_id,attempt_number,phase,lease_owner,lease_generation)
        VALUES ($1::uuid,$2::uuid,$3,'started',$4::uuid,$5::bigint)`, [...ids, attemptNumber, lease.ownerId, lease.leaseGeneration.toString()]);
      await setStatus('sending');
      return { value: { status: 'admitted', recipientAddress: context.recipientAddress, message: parsed.data,
        attempt: { outboundMessageId: lease.outboundMessageId, userId: lease.userId,
          ownerId: lease.ownerId, leaseGeneration: lease.leaseGeneration, attemptNumber } },
      disposition: { state: 'keep', attemptCount: attemptNumber } };
    });
  }
}
