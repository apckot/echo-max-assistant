import type { DeliveryLease } from '../../modules/delivery/application/delivery-queue.js';
import type { Database, DbTx } from './database.js';

export type DeliveryDisposition =
  | { readonly state: 'keep'; readonly attemptCount?: number }
  | { readonly state: 'retry'; readonly availableAt: Date }
  | { readonly state: 'sent' | 'uncertain' | 'dead' | 'cancelled' };
export interface DeliveryContext {
  readonly conversationId: string;
  readonly userStatus: string;
  readonly accountState: string;
  readonly conversationState: string;
  readonly recipientAddress: string;
  readonly outboundStatus: string;
  readonly attemptCount: number;
}
export class DeliveryLeaseLostError extends Error {
  constructor() { super('Delivery lease lost'); }
}
export class PostgresFencedDelivery {
  constructor(private readonly database: Pick<Database, 'tenantTransaction'>) {}

  // Infrastructure composition only: this helper never authorizes a send.
  // Callbacks await tenant writes, leave work leased, and request its disposition.
  // No network call or separate heartbeat may be awaited while these locks are held.
  async run<T>(lease: DeliveryLease,
    callback: (tx: DbTx, context: DeliveryContext) => Promise<{ value: T; disposition: DeliveryDisposition }>): Promise<T> {
    return this.database.tenantTransaction('delivery', lease.userId, async (tx) => {
      const ids = [lease.outboundMessageId, lease.userId];
      const token = [...ids, lease.ownerId, lease.leaseGeneration.toString()];
      const [discovered] = await tx.query<{ conversation_id: string; channel_account_id: string }>(`
        SELECT o.conversation_id, c.channel_account_id FROM public.outbound_messages o
        JOIN public.conversations c ON c.id=o.conversation_id AND c.user_id=o.user_id
        WHERE o.id=$1::uuid AND o.user_id=$2::uuid`, ids);
      if (!discovered) throw new DeliveryLeaseLostError();
      const [user] = await tx.query<{ status: string }>(
        'SELECT status FROM public.users WHERE id=$1::uuid FOR SHARE', [lease.userId]);
      const [account] = await tx.query<{ state: string; external_user_id: string }>(`
        SELECT state, external_user_id FROM public.channel_accounts
        WHERE id=$1::uuid AND user_id=$2::uuid FOR SHARE`, [discovered.channel_account_id, lease.userId]);
      const [conversation] = await tx.query<{ state: string }>(`
        SELECT state FROM public.conversations WHERE id=$1::uuid AND user_id=$2::uuid
          AND channel_account_id=$3::uuid FOR UPDATE`, [discovered.conversation_id, lease.userId, discovered.channel_account_id]);
      const [outbound] = await tx.query<{ status: string }>(`
        SELECT status FROM public.outbound_messages WHERE id=$1::uuid AND user_id=$2::uuid
          AND conversation_id=$3::uuid FOR UPDATE`, [...ids, discovered.conversation_id]);
      const [work] = await tx.query<{ attempt_count: number }>(`
        SELECT attempt_count FROM public.delivery_work
        WHERE outbound_message_id=$1::uuid AND user_id=$2::uuid FOR UPDATE`, ids);
      if (!user || !account || !conversation || !outbound || !work) throw new DeliveryLeaseLostError();
      const valid = await tx.query(`SELECT 1 FROM public.delivery_work
        WHERE outbound_message_id=$1::uuid AND user_id=$2::uuid AND state='leased'
          AND lease_owner=$3::uuid AND lease_generation=$4::bigint AND lease_until>clock_timestamp()`, token);
      if (valid.length !== 1) throw new DeliveryLeaseLostError();

      const { value, disposition } = await callback(tx, {
        conversationId: discovered.conversation_id, userStatus: user.status, accountState: account.state,
        conversationState: conversation.state, recipientAddress: account.external_user_id,
        outboundStatus: outbound.status, attemptCount: work.attempt_count,
      });
      const attemptCount = disposition.state === 'keep' ? disposition.attemptCount : undefined;
      const due = disposition.state === 'retry' ? disposition.availableAt : undefined;
      if (!['keep', 'retry', 'sent', 'uncertain', 'dead', 'cancelled'].includes(disposition.state) ||
        (attemptCount !== undefined && (!Number.isInteger(attemptCount) || attemptCount < work.attempt_count || attemptCount > 6)) ||
        (disposition.state === 'retry' && (!(due instanceof Date) || !Number.isFinite(due.getTime()) || due.getTime() < 0))) {
        throw new RangeError('Invalid delivery disposition');
      }
      // Last mutation verifies live database authority before releasing it. All
      // locks survive through COMMIT; this does not claim physical-COMMIT expiry fencing.
      const finalized = await tx.query(`UPDATE public.delivery_work SET
        state=CASE WHEN $5='keep' THEN 'leased' ELSE $5 END,
        available_at=COALESCE($6::timestamptz, available_at),
        attempt_count=COALESCE($7::integer, attempt_count),
        lease_owner=CASE WHEN $5='keep' THEN lease_owner ELSE NULL END,
        lease_until=CASE WHEN $5='keep' THEN lease_until ELSE NULL END,
        updated_at=clock_timestamp()
        WHERE outbound_message_id=$1::uuid AND user_id=$2::uuid AND state='leased'
          AND lease_owner=$3::uuid AND lease_generation=$4::bigint AND lease_until>clock_timestamp()
        RETURNING outbound_message_id`, [...token, disposition.state, due ?? null, attemptCount ?? null]);
      if (finalized.length !== 1) throw new DeliveryLeaseLostError();
      return value;
    });
  }
}
