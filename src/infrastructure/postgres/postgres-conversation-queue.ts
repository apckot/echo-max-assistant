import type { ClaimConversationWork, ConversationLease, ConversationQueue } from '../../modules/intake/application/conversation-queue.js';
import type { ConversationId, UserId } from '../../shared/types/identity.js';
import type { Database } from './database.js';

type WorkerDatabase = Pick<Database, 'systemTransaction'>;
type LeaseRow = { conversation_id: string; user_id: string; lease_owner: string;
  lease_generation: string; lease_until: Date; attempt_count: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nilUuid = '00000000-0000-0000-0000-000000000000';
const defaultLeaseMs = 60_000;
const maxGeneration = 9_223_372_036_854_775_807n;

function validId(value: string): boolean { return uuid.test(value) && value.toLowerCase() !== nilUuid; }
function validLeaseMs(value: number): boolean { return Number.isSafeInteger(value) && value > 0 && value <= 300_000; }

export class PostgresConversationQueue implements ConversationQueue {
  constructor(private readonly database: WorkerDatabase) {}

  async claim(input: ClaimConversationWork): Promise<readonly ConversationLease[]> {
    if (!validId(input.ownerId) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 ||
      !validLeaseMs(input.leaseMs ?? defaultLeaseMs)) throw new RangeError('Invalid conversation claim');
    const rows = await this.database.systemTransaction('worker', (tx) => tx.query<LeaseRow>(`
      WITH candidates AS MATERIALIZED (
        SELECT conversation_id FROM public.conversation_work
        WHERE ((state IN ('ready', 'retry') AND available_at <= clock_timestamp())
          OR (state = 'leased' AND lease_until <= clock_timestamp()))
        ORDER BY available_at, conversation_id
        LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      UPDATE public.conversation_work AS work SET
        state = 'leased', lease_owner = $1::uuid,
        lease_until = clock_timestamp() + $3::integer * interval '1 millisecond',
        lease_generation = work.lease_generation + 1
      FROM candidates WHERE work.conversation_id = candidates.conversation_id
      RETURNING work.conversation_id, work.user_id, work.lease_owner,
        work.lease_generation, work.lease_until, work.attempt_count`,
    [input.ownerId, input.limit, input.leaseMs ?? defaultLeaseMs]));
    return rows.map((row) => ({ conversationId: row.conversation_id as ConversationId,
      userId: row.user_id as UserId, ownerId: row.lease_owner,
      leaseGeneration: BigInt(row.lease_generation), leaseUntil: row.lease_until,
      attemptCount: row.attempt_count }));
  }

  async renew(lease: ConversationLease, leaseMs = defaultLeaseMs): Promise<Date | null> {
    if (!validId(lease.conversationId) || !validId(lease.userId) || !validId(lease.ownerId) ||
      typeof lease.leaseGeneration !== 'bigint' || lease.leaseGeneration < 0n ||
      lease.leaseGeneration > maxGeneration ||
      !validLeaseMs(leaseMs)) throw new RangeError('Invalid conversation lease');
    const rows = await this.database.systemTransaction('worker', (tx) => tx.query<{ lease_until: Date }>(`
      UPDATE public.conversation_work SET
        lease_until = GREATEST(lease_until, clock_timestamp() + $5::integer * interval '1 millisecond')
      WHERE conversation_id = $1::uuid AND user_id = $2::uuid
        AND state = 'leased' AND lease_owner = $3::uuid AND lease_generation = $4::bigint
        AND lease_until > clock_timestamp()
      RETURNING lease_until`,
    [lease.conversationId, lease.userId, lease.ownerId, lease.leaseGeneration.toString(), leaseMs]));
    return rows[0]?.lease_until ?? null;
  }
}
