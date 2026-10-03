import type { ConversationLease } from '../../modules/intake/application/conversation-queue.js';
import { MissingAllocatedHeadError, type ActionableHead, type OrderedHeadResult } from '../../modules/intake/application/ordered-head.js';
import type { WorkDisposition } from '../../modules/intake/application/work-disposition.js';
import type { InboundEvent, InboundPayload, PreparationStatus, ProcessingStatus, InboundFailureCode } from '../../modules/intake/domain/inbound-event.js';
import type { DbTx } from './database.js';
import { PostgresFencedConversation } from './postgres-fenced-conversation.js';

type CounterRow = { next_apply_sequence: string; next_inbound_sequence: string };
type EventRow = { id: string; user_id: string; conversation_id: string; provider_event_key: string;
  sequence: string; occurred_at: Date; received_at: Date; timezone_snapshot: string;
  payload: InboundPayload; raw_sha256: string; preparation_status: PreparationStatus;
  processing_status: ProcessingStatus; failure_code: InboundFailureCode | null;
  attempt_count: number; preparation_started_at: Date | null; processing_started_at: Date | null;
  processed_at: Date | null; created_at: Date; updated_at: Date };

function eventFromRow(row: EventRow): InboundEvent {
  return { id: row.id as InboundEvent['id'], userId: row.user_id as InboundEvent['userId'],
    conversationId: row.conversation_id as InboundEvent['conversationId'],
    providerEventKey: row.provider_event_key, sequence: BigInt(row.sequence),
    occurredAt: row.occurred_at, receivedAt: row.received_at, timezoneSnapshot: row.timezone_snapshot,
    payload: row.payload, rawSha256: row.raw_sha256, preparationStatus: row.preparation_status,
    processingStatus: row.processing_status, failureCode: row.failure_code,
    attemptCount: row.attempt_count, preparationStartedAt: row.preparation_started_at,
    processingStartedAt: row.processing_started_at, processedAt: row.processed_at,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export class PostgresOrderedHead {
  constructor(private readonly fenced: PostgresFencedConversation) {}

  async run<T>(lease: ConversationLease,
    onActionable: (head: ActionableHead, tx: DbTx) => Promise<{ value: T; disposition: WorkDisposition }>): Promise<OrderedHeadResult<T>> {
    return this.fenced.run<OrderedHeadResult<T>>(lease, async (tx) => {
      const ids = [lease.conversationId, lease.userId];
      // FencedConversation already holds conversation then work locks. The head
      // row is locked only after those locks, and only at the current pointer.
      const [counter] = await tx.query<CounterRow>(`SELECT next_apply_sequence, next_inbound_sequence
        FROM public.conversations WHERE id = $1::uuid AND user_id = $2::uuid`, ids);
      if (!counter) throw new MissingAllocatedHeadError();
      const next = BigInt(counter.next_apply_sequence);
      const allocated = BigInt(counter.next_inbound_sequence);
      if (next > allocated) throw new MissingAllocatedHeadError();
      const [row] = await tx.query<EventRow>(`SELECT * FROM public.inbound_events
        WHERE conversation_id = $1::uuid AND user_id = $2::uuid AND sequence = $3::bigint FOR UPDATE`,
      [...ids, next.toString()]);
      if (!row) {
        if (next !== allocated) throw new MissingAllocatedHeadError();
        return { value: { kind: 'drained' } as const, disposition: { kind: 'sleep' } as const };
      }
      if (next >= allocated) throw new MissingAllocatedHeadError();
      if (row.processing_status === 'applied' || row.processing_status === 'failed' || row.processing_status === 'ignored') {
        const updated = await tx.query(`UPDATE public.conversations SET next_apply_sequence = $3::bigint,
          updated_at = clock_timestamp() WHERE id = $1::uuid AND user_id = $2::uuid
          AND next_apply_sequence = $4::bigint RETURNING id`,
        [...ids, (next + 1n).toString(), next.toString()]);
        if (updated.length !== 1) throw new MissingAllocatedHeadError();
        return { value: { kind: 'advanced' } as const,
          disposition: next + 1n < allocated ? { kind: 'ready' } as const : { kind: 'sleep' } as const };
      }
      if (row.preparation_status === 'preparing') {
        const [check] = await tx.query<{ available_at: Date }>(
          `SELECT clock_timestamp() + interval '1 second' AS available_at`);
        return { value: { kind: 'preparing' } as const,
          disposition: { kind: 'defer', availableAt: check!.available_at } as const };
      }
      const head: ActionableHead = { kind: row.preparation_status === 'failed' ? 'preparation_failed' : 'ready',
        event: eventFromRow(row) };
      const { value, disposition } = await onActionable(head, tx);
      return { value: { kind: 'actionable', value } as const, disposition };
    });
  }
}
