import type { IdentityContext } from '../../modules/identity/application/identity-context.js';
import type { ChannelAccountId, ConversationId, UserId } from '../../shared/types/identity.js';
import type { Database } from './database.js';

export interface MaxIdentityInput {
  externalUserId: string;
  externalConversationId: string;
  eventType: 'bot_started' | 'bot_stopped' | 'message_created' | 'message_callback';
}

type IdentityRow = {
  user_id: string;
  channel_account_id: string;
  conversation_id: string;
  state: 'active' | 'stopped';
};

export class PostgresIdentityGateway {
  constructor(private readonly database: Pick<Database, 'systemTransaction'>) {}

  async resolvePrivateDialog(input: MaxIdentityInput): Promise<IdentityContext> {
    return this.database.systemTransaction('gateway', async (tx) => {
      const rows = await tx.query<IdentityRow>(
        'SELECT * FROM public.resolve_or_create_max_identity($1, $2, $3)',
        [input.externalUserId, input.externalConversationId, input.eventType],
      );
      const row = rows[0];
      if (!row) throw new Error('MAX identity resolution returned no row');
      return {
        userId: row.user_id as UserId,
        channelAccountId: row.channel_account_id as ChannelAccountId,
        conversationId: row.conversation_id as ConversationId,
        state: row.state,
      };
    });
  }
}
