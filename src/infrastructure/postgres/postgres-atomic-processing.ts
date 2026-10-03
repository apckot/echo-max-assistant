import type { ConversationLease } from '../../modules/intake/application/conversation-queue.js';
import type { HandleInboundInput, HandleInboundResult } from '../../modules/intake/application/inbound-handler.js';
import { PreparationFailedError, ReceiptMismatchError, type AtomicProcessingPort } from '../../modules/intake/application/process-inbound.js';
import { MissingAllocatedHeadError, type OrderedHeadResult } from '../../modules/intake/application/ordered-head.js';
import type { PostgresOrderedHead } from './postgres-ordered-head.js';

export class PostgresAtomicProcessing implements AtomicProcessingPort {
  constructor(private readonly ordered: PostgresOrderedHead) {}

  run(lease: ConversationLease, handle: (input: HandleInboundInput) => Promise<HandleInboundResult>):
    Promise<OrderedHeadResult<HandleInboundResult>> {
    return this.ordered.run(lease, async ({ kind, event }, tx) => {
      // 20B owns the failure policy. Roll back without skipping this head.
      if (kind === 'preparation_failed') throw new PreparationFailedError();
      const source = [event.userId, event.conversationId, event.id];
      await tx.query(`UPDATE public.inbound_events SET processing_status = 'processing',
        processing_started_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND id = $3::uuid`, source);
      const result = await handle({ sequence: event.sequence, payload: event.payload });
      const params = [...source, result.receiptType, result.receiptVersion, JSON.stringify(result)];
      await tx.query(`INSERT INTO public.processing_receipts
        (user_id, conversation_id, inbound_event_id, receipt_type, receipt_version, result)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb)
        ON CONFLICT (inbound_event_id, receipt_type) DO NOTHING`, params);
      // A conflict is acceptable only for the identical immutable source/result.
      // jsonb equality ignores object key order but preserves draft array order.
      const receipts = await tx.query<{ result: HandleInboundResult }>(`SELECT result FROM public.processing_receipts
        WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND inbound_event_id = $3::uuid
          AND receipt_type = $4 AND receipt_version = $5 AND result = $6::jsonb
          AND public.valid_processing_result(result)`, params);
      if (receipts.length !== 1) throw new ReceiptMismatchError();
      await tx.query(`UPDATE public.inbound_events SET processing_status = 'applied',
        failure_code = $4, processed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND id = $3::uuid`,
      [...source, event.payload.kind === 'voice' ? 'capability_unavailable' : null]);
      const [counter] = await tx.query<{ more: boolean }>(`UPDATE public.conversations
        SET next_apply_sequence = next_apply_sequence + 1, updated_at = clock_timestamp()
        WHERE user_id = $1::uuid AND id = $2::uuid AND next_apply_sequence = $3::bigint
        RETURNING next_apply_sequence < next_inbound_sequence AS more`,
      [event.userId, event.conversationId, event.sequence.toString()]);
      if (!counter) throw new MissingAllocatedHeadError();
      // OrderedHead delegates the final guarded lease release to iteration 17.
      return { value: receipts[0]!.result, disposition: counter.more ? { kind: 'ready' } : { kind: 'sleep' } };
    });
  }
}
