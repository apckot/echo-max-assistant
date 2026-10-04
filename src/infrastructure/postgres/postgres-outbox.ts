import { OutboxMismatchError, type OutboxPort, type OutboxSource } from '../../modules/delivery/application/outbox.js';
import { OutboundMessageDraftSchema, type OutboundMessageDraft } from '../../modules/delivery/domain/outbound-message.js';
import type { DbTx } from './database.js';

// This adapter is bound to the processing transaction; it never opens its own transaction.
export class PostgresOutbox implements OutboxPort {
  constructor(private readonly tx: DbTx) {}

  async save(source: OutboxSource, messages: readonly OutboundMessageDraft[]): Promise<void> {
    for (const [index, payload] of messages.entries()) {
      const parsed = OutboundMessageDraftSchema.safeParse(payload);
      if (!parsed.success) throw new Error('Invalid outbound payload');
      const dedupe = `response:${source.id}:${index}:v1`;
      const values = [source.userId, source.conversationId, source.id, index, JSON.stringify(parsed.data), dedupe];
      await this.tx.query(`INSERT INTO public.outbound_messages
        (user_id, conversation_id, source_inbound_event_id, provider, message_index, payload, dedupe_key)
        VALUES ($1::uuid,$2::uuid,$3::uuid,'max',$4,$5::jsonb,$6)
        ON CONFLICT (provider, dedupe_key) DO NOTHING`, values);
      const [saved] = await this.tx.query<{ id: string }>(`SELECT id FROM public.outbound_messages
        WHERE user_id = $1::uuid AND conversation_id = $2::uuid AND source_inbound_event_id = $3::uuid
          AND provider = 'max' AND message_index = $4 AND payload = $5::jsonb AND dedupe_key = $6`, values);
      if (!saved) throw new OutboxMismatchError();
      await this.tx.query(`INSERT INTO public.delivery_work (outbound_message_id, user_id)
        VALUES ($1::uuid,$2::uuid) ON CONFLICT (outbound_message_id) DO NOTHING`, [saved.id, source.userId]);
    }
  }
}
