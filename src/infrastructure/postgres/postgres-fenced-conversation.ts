import type { ConversationLease } from '../../modules/intake/application/conversation-queue.js';
import { ConversationLeaseLostError, type WorkDisposition } from '../../modules/intake/application/work-disposition.js';
import type { Database, DbTx } from './database.js';

export class PostgresFencedConversation {
  constructor(private readonly database: Pick<Database, 'tenantTransaction'>) {}

  // Infrastructure composition point: callbacks must await their tenant writes,
  // leave work leased, and return a disposition. Never await a separate heartbeat
  // while this transaction holds the work lock. Application ports stay neutral.
  async run<T>(lease: ConversationLease,
    callback: (tx: DbTx) => Promise<{ value: T; disposition: WorkDisposition }>): Promise<T> {
    return this.database.tenantTransaction('worker', lease.userId, async (tx) => {
      const ids = [lease.conversationId, lease.userId];
      const token = [...ids, lease.ownerId, lease.leaseGeneration.toString()];
      // Ingress takes these locks in this same order.
      const conversation = await tx.query(`SELECT 1 FROM public.conversations
        WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE`, ids);
      if (conversation.length !== 1) throw new ConversationLeaseLostError();
      const work = await tx.query(`SELECT 1 FROM public.conversation_work
        WHERE conversation_id = $1::uuid AND user_id = $2::uuid FOR UPDATE`, ids);
      if (work.length !== 1) throw new ConversationLeaseLostError();
      // Check after acquiring the lock: the lease could have expired while waiting.
      const valid = await tx.query(`SELECT 1 FROM public.conversation_work
        WHERE conversation_id = $1::uuid AND user_id = $2::uuid
          AND state = 'leased' AND lease_owner = $3::uuid AND lease_generation = $4::bigint
          AND lease_until > clock_timestamp()`, token);
      if (valid.length !== 1) throw new ConversationLeaseLostError();

      const { value, disposition } = await callback(tx);
      const availableAt = disposition.kind === 'sleep' ? 'infinity'
        : disposition.kind === 'ready' || disposition.kind === 'retry' ? disposition.availableAt ?? null : null;
      // Last business mutation: verify the live token BEFORE releasing it. Locks
      // remain held through COMMIT; no callback or heartbeat follows this guard.
      const finalized = await tx.query(`UPDATE public.conversation_work SET
        state = CASE WHEN $5 = 'keep' THEN 'leased' WHEN $5 = 'retry' THEN 'retry' ELSE 'ready' END,
        available_at = CASE WHEN $5 = 'keep' THEN available_at ELSE COALESCE($6::timestamptz, clock_timestamp()) END,
        attempt_count = CASE WHEN $5 = 'keep' THEN attempt_count ELSE $7::integer END,
        last_error_code = CASE WHEN $5 = 'keep' THEN last_error_code ELSE $8::text END,
        lease_owner = CASE WHEN $5 = 'keep' THEN lease_owner ELSE NULL END,
        lease_until = CASE WHEN $5 = 'keep' THEN lease_until ELSE NULL END
        WHERE conversation_id = $1::uuid AND user_id = $2::uuid
          AND state = 'leased' AND lease_owner = $3::uuid AND lease_generation = $4::bigint
          AND lease_until > clock_timestamp()
        RETURNING conversation_id`, [...token, disposition.kind, availableAt,
        disposition.kind === 'retry' ? disposition.attemptCount : 0,
        disposition.kind === 'retry' ? disposition.lastErrorCode : null]);
      if (finalized.length !== 1) throw new ConversationLeaseLostError();
      return value;
    });
  }
}
