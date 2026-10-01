export type UserId = string & { readonly __userId: unique symbol };
export type ChannelAccountId = string & { readonly __channelAccountId: unique symbol };
export type ConversationId = string & { readonly __conversationId: unique symbol };
