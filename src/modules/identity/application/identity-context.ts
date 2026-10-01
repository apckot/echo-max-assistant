import type { ChannelAccountId, ConversationId, UserId } from '../../../shared/types/identity.js';

export interface IdentityContext {
  userId: UserId;
  channelAccountId: ChannelAccountId;
  conversationId: ConversationId;
  state: 'active' | 'stopped';
}
