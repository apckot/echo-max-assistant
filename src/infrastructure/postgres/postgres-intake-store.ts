import { IntakeService } from '../../modules/intake/application/intake-service.js';
import type { IntakeInput, IntakeResult, IntakeStore } from '../../modules/intake/application/ports.js';
import type { InboundEventId, InboundPayload } from '../../modules/intake/domain/inbound-event.js';
import type { NormalizedInbound } from '../max/update-mapper.js';
import type { Database } from './database.js';

type GatewayDatabase = Pick<Database, 'systemTransaction'>;
type MaxIdentity = { externalUserId: string; externalConversationId: string };

export class PostgresIntakeStore implements IntakeStore {
  constructor(private readonly database: GatewayDatabase, private readonly identity: MaxIdentity) {}

  async persist(input: IntakeInput): Promise<IntakeResult> {
    return this.database.systemTransaction('gateway', async (tx) => {
      const [row] = await tx.query<{ inbound_event_id: string; status: 'created' | 'duplicate' }>(
        'SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',
        [this.identity.externalUserId, this.identity.externalConversationId,
          input.providerEventKey, input.occurredAt, JSON.stringify(input.payload), input.rawSha256],
      );
      if (!row) throw new Error('inbound_intake_no_result');
      return { inboundEventId: row.inbound_event_id as InboundEventId, status: row.status };
    });
  }
}

export async function acceptMaxInbound(database: GatewayDatabase, event: NormalizedInbound, rawSha256: string): Promise<IntakeResult> {
  // MAX uses integer epoch milliseconds, not seconds or ISO timestamp strings.
  if (!/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(event.occurredAt)) throw new Error('invalid_inbound_event');
  const milliseconds = Number(event.occurredAt);
  // PostgreSQL additionally checks its timestamp range when binding the function
  // argument, before the resolver or any persistent operation can execute.
  if (!Number.isSafeInteger(milliseconds)) throw new Error('invalid_inbound_event');
  const reply = 'replyToMessageId' in event ? { replyToMessageId: event.replyToMessageId } : {};
  let payload: InboundPayload;
  switch (event.kind) {
    case 'text': payload = { kind: 'text', text: event.text, ...reply }; break;
    case 'voice': payload = { kind: 'voice', media: event.voice, ...reply }; break;
    case 'button': payload = { kind: 'button', callbackPayload: event.callbackPayload, ...reply }; break;
    case 'lifecycle': payload = { kind: 'lifecycle', lifecycleType: event.lifecycleType === 'bot_started' ? 'started' : 'stopped' }; break;
  }
  return new IntakeService(new PostgresIntakeStore(database, {
    externalUserId: event.providerUserId, externalConversationId: event.providerChatId,
  })).accept({ providerEventKey: event.providerEventKey, occurredAt: new Date(milliseconds), payload, rawSha256 });
}
