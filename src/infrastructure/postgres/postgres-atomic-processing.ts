import type { ConversationLease } from '../../modules/intake/application/conversation-queue.js';
import type { HandleInboundInput, HandleInboundResult } from '../../modules/intake/application/inbound-handler.js';
import { ReceiptMismatchError, retryDelayMs, type AtomicProcessingPort, type ProcessingRunResult, type RetryScheduled } from '../../modules/intake/application/process-inbound.js';
import { MissingAllocatedHeadError } from '../../modules/intake/application/ordered-head.js';
import type { InboundEvent, InboundFailureCode } from '../../modules/intake/domain/inbound-event.js';
import type { DbTx } from './database.js';
import type { PostgresOrderedHead } from './postgres-ordered-head.js';

// Created only around the pure callback; never retain raw error messages/codes.
class PureHandlerFailure extends Error {
  constructor(readonly id: string, readonly sequence: bigint) { super('Inbound handler failed'); }
}
const errorResult: HandleInboundResult = { receiptType: 'foundation_echo', receiptVersion: 1,
  messages: [{ version: 1, kind: 'text', text: 'Не удалось обработать сообщение. Попробуйте отправить его ещё раз.' }] };

export class PostgresAtomicProcessing implements AtomicProcessingPort {
  constructor(private readonly ordered: PostgresOrderedHead) {}

  async run(lease: ConversationLease, handle: (input: HandleInboundInput) => Promise<HandleInboundResult>):
    Promise<ProcessingRunResult> {
    try {
      return await this.ordered.run(lease, async ({ kind, event }, tx) => {
        if (kind === 'preparation_failed') return this.complete(tx, event, errorResult, 'failed', 'invalid_payload');
        await tx.query(`UPDATE public.inbound_events SET processing_status = 'processing',
          processing_started_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND id = $3::uuid`,
        [event.userId, event.conversationId, event.id]);
        let result: HandleInboundResult;
        try { result = await handle({ sequence: event.sequence, payload: event.payload }); }
        catch { throw new PureHandlerFailure(event.id, event.sequence); }
        return this.complete(tx, event, result, 'applied', event.payload.kind === 'voice' ? 'capability_unavailable' : null);
      });
    } catch (error) {
      // The failed processing transaction has rolled back before recovery begins.
      // SQL, lease and uncertain COMMIT failures never enter this branch.
      if (!(error instanceof PureHandlerFailure)) throw error;
      const recovered = await this.ordered.run<HandleInboundResult | RetryScheduled>(lease, async ({ event }, tx) => {
        const count = event.attemptCount + 1;
        await tx.query(`UPDATE public.inbound_events SET attempt_count = $4, processing_status = 'accepted',
          failure_code = 'processing_error', processing_started_at = NULL, updated_at = clock_timestamp()
          WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND id = $3::uuid`,
        [event.userId, event.conversationId, event.id, count]);
        if (count >= 5) return this.complete(tx, event, errorResult, 'failed', 'retry_exhausted');
        const [schedule] = await tx.query<{ available_at: Date }>(
          `SELECT clock_timestamp() + $1::double precision * interval '1 millisecond' AS available_at`, [retryDelayMs(count)]);
        const value: RetryScheduled = { kind: 'retry', attemptCount: count, availableAt: schedule!.available_at };
        return { value, disposition: { ...value, lastErrorCode: 'processing_error' } };
      }, error);
      if (recovered.kind !== 'actionable') return recovered;
      return 'kind' in recovered.value ? recovered.value : { kind: 'actionable', value: recovered.value };
    }
  }

  private async complete(tx: DbTx, event: InboundEvent, result: HandleInboundResult,
    status: 'applied' | 'failed', failureCode: InboundFailureCode | null) {
    const source = [event.userId, event.conversationId, event.id];
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
    await tx.query(`UPDATE public.inbound_events SET processing_status = $5,
      failure_code = $4, processed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND id = $3::uuid`,
    [...source, failureCode, status]);
    const [counter] = await tx.query<{ more: boolean }>(`UPDATE public.conversations
      SET next_apply_sequence = next_apply_sequence + 1, updated_at = clock_timestamp()
      WHERE user_id = $1::uuid AND id = $2::uuid AND next_apply_sequence = $3::bigint
      RETURNING next_apply_sequence < next_inbound_sequence AS more`,
    [event.userId, event.conversationId, event.sequence.toString()]);
    if (!counter) throw new MissingAllocatedHeadError();
    // OrderedHead delegates the final guarded lease release to iteration 17.
    return { value: receipts[0]!.result, disposition: counter.more ? { kind: 'ready' as const } : { kind: 'sleep' as const } };
  }
}
