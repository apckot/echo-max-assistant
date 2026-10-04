import type { ClaimDeliveryWork, DeliveryLease, DeliveryQueue } from '../../modules/delivery/application/delivery-queue.js';
import type { UserId } from '../../shared/types/identity.js';
import type { Database } from './database.js';

type LeaseRow = { outbound_message_id: string; user_id: string; lease_owner: string;
  lease_generation: string; lease_until: Date; attempt_count: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nilUuid = '00000000-0000-0000-0000-000000000000';
const defaultLeaseMs = 60_000;
const maxGeneration = 9_223_372_036_854_775_807n;
const validId = (value: string) => uuid.test(value) && value.toLowerCase() !== nilUuid;
const validLeaseMs = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 300_000;

export class PostgresDeliveryQueue implements DeliveryQueue {
  constructor(private readonly database: Pick<Database, 'systemTransaction'>) {}

  async claim(input: ClaimDeliveryWork): Promise<readonly DeliveryLease[]> {
    if (!validId(input.ownerId) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
      !validLeaseMs(input.leaseMs ?? defaultLeaseMs)) throw new RangeError('Invalid delivery claim');
    const rows = await this.database.systemTransaction('delivery', (tx) => tx.query<LeaseRow>(`
      WITH candidates AS MATERIALIZED (
        SELECT outbound_message_id FROM public.delivery_work
        WHERE ((state IN ('ready', 'retry') AND available_at <= clock_timestamp())
          OR (state = 'leased' AND lease_until <= clock_timestamp()))
        ORDER BY available_at, outbound_message_id
        LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      UPDATE public.delivery_work AS work SET
        state = 'leased', lease_owner = $1::uuid,
        lease_until = clock_timestamp() + $3::integer * interval '1 millisecond',
        lease_generation = work.lease_generation + 1, updated_at = clock_timestamp()
      FROM candidates WHERE work.outbound_message_id = candidates.outbound_message_id
      RETURNING work.outbound_message_id, work.user_id, work.lease_owner,
        work.lease_generation, work.lease_until, work.attempt_count`,
    [input.ownerId, input.limit, input.leaseMs ?? defaultLeaseMs]));
    return rows.map((row) => ({ outboundMessageId: row.outbound_message_id, userId: row.user_id as UserId,
      ownerId: row.lease_owner, leaseGeneration: BigInt(row.lease_generation),
      leaseUntil: row.lease_until, attemptCount: row.attempt_count }));
  }

  async renew(lease: DeliveryLease, leaseMs = defaultLeaseMs): Promise<Date | null> {
    if (!validId(lease.outboundMessageId) || !validId(lease.userId) || !validId(lease.ownerId) ||
      typeof lease.leaseGeneration !== 'bigint' || lease.leaseGeneration < 0n ||
      lease.leaseGeneration > maxGeneration || !validLeaseMs(leaseMs)) throw new RangeError('Invalid delivery lease');
    const rows = await this.database.systemTransaction('delivery', async (tx) => {
      const token = [lease.outboundMessageId, lease.userId, lease.ownerId, lease.leaseGeneration.toString()];
      const locked = await tx.query(`SELECT 1 FROM public.delivery_work
        WHERE outbound_message_id = $1::uuid AND user_id = $2::uuid
          AND state = 'leased' AND lease_owner = $3::uuid AND lease_generation = $4::bigint
        FOR UPDATE`, token);
      if (locked.length === 0) return [];
      // The live database expiry is checked after locking. Renewal preserves the
      // same owner/generation authority, including already admitted attempts.
      return tx.query<{ lease_until: Date }>(`UPDATE public.delivery_work SET
        lease_until = GREATEST(lease_until, clock_timestamp() + $5::integer * interval '1 millisecond'),
        updated_at = clock_timestamp()
        WHERE outbound_message_id = $1::uuid AND user_id = $2::uuid
          AND state = 'leased' AND lease_owner = $3::uuid AND lease_generation = $4::bigint
          AND lease_until > clock_timestamp()
        RETURNING lease_until`, [...token, leaseMs]);
    });
    return rows[0]?.lease_until ?? null;
  }
}
