import { createHash } from 'node:crypto';
import { audioAttachmentSchema, maxUpdateSchemas } from './update-schema.js';

export type IgnoredUpdate = { status: 'ignored'; reason: 'unsupported' | 'non_private' | 'sender_mismatch' | 'empty_text' | 'text_too_large' | 'payload_too_large' | 'unsupported_content' | 'missing_message' };

type BaseInbound = {
  status: 'normalized';
  providerUserId: string;
  providerChatId: string;
  providerEventKey: string;
  occurredAt: string;
};

export type NormalizedInbound = BaseInbound & (
  | { kind: 'lifecycle'; lifecycleType: 'bot_started' | 'bot_stopped' }
  | { kind: 'text'; text: string; replyToMessageId?: string }
  | { kind: 'voice'; voice: { url: string; token: string }; replyToMessageId?: string }
  | { kind: 'button'; callbackPayload: string; replyToMessageId?: string }
);

export class InvalidMaxUpdateError extends Error {
  constructor() { super('invalid_max_update'); }
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvalidMaxUpdateError();
  return parsed.data;
}

function canonicalHash(fields: string[]): string {
  const hash = createHash('sha256');
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

function bounded(event: NormalizedInbound): NormalizedInbound | IgnoredUpdate {
  return Buffer.byteLength(JSON.stringify(event), 'utf8') <= 128 * 1024
    ? event
    : { status: 'ignored', reason: 'payload_too_large' };
}

function privateChat(message: { recipient: { chat_id: string | null; chat_type: string } }): message is typeof message & { recipient: { chat_id: string; chat_type: 'dialog' } } {
  return message.recipient.chat_type === 'dialog' && message.recipient.chat_id !== null;
}

export function mapMaxUpdate(value: unknown, options: { expectedProviderUserId?: string } = {}): NormalizedInbound | IgnoredUpdate {
  const { update_type: type } = parse(maxUpdateSchemas.envelope, value);
  if (type === 'bot_started' || type === 'bot_stopped') {
    const update = type === 'bot_started'
      ? parse(maxUpdateSchemas.bot_started, value)
      : parse(maxUpdateSchemas.bot_stopped, value);
    if (update.user.is_bot || (options.expectedProviderUserId !== undefined && options.expectedProviderUserId !== update.user.user_id)) return { status: 'ignored', reason: 'sender_mismatch' };
    return bounded({
      status: 'normalized', kind: 'lifecycle', lifecycleType: type,
      providerUserId: update.user.user_id, providerChatId: update.chat_id,
      providerEventKey: `lifecycle:${canonicalHash([type, update.user.user_id, update.chat_id, update.timestamp])}`,
      occurredAt: update.timestamp,
    });
  }

  if (type === 'message_created') {
    const update = parse(maxUpdateSchemas.message_created, value);
    const { message } = update;
    if (!privateChat(message)) return { status: 'ignored', reason: 'non_private' };
    if (!message.sender || message.sender.is_bot || (options.expectedProviderUserId !== undefined && options.expectedProviderUserId !== message.sender.user_id)) return { status: 'ignored', reason: 'sender_mismatch' };
    if (message.body === null) return { status: 'ignored', reason: 'unsupported_content' };
    const common = {
      status: 'normalized' as const, providerUserId: message.sender.user_id,
      providerChatId: message.recipient.chat_id, providerEventKey: `message:${message.body.mid}`,
      occurredAt: update.timestamp,
      ...(message.link?.type === 'reply' ? { replyToMessageId: message.link.message.mid } : {}),
    };
    if (message.body.text !== null && message.body.text !== undefined) {
      const text = message.body.text.trim();
      if (text.length > 0) {
        if ([...text].length > 16_000 || Buffer.byteLength(text, 'utf8') > 64 * 1024) return { status: 'ignored', reason: 'text_too_large' };
        return bounded({ ...common, kind: 'text', text });
      }
    }
    const audio = message.body.attachments?.find((attachment): boolean => typeof attachment === 'object' && attachment !== null && 'type' in attachment && attachment.type === 'audio');
    if (audio !== undefined) {
      const parsed = parse(audioAttachmentSchema, audio);
      return bounded({ ...common, kind: 'voice', voice: { url: parsed.payload.url, token: parsed.payload.token } });
    }
    return { status: 'ignored', reason: message.body.text?.trim() === '' ? 'empty_text' : 'unsupported_content' };
  }

  if (type === 'message_callback') {
    const update = parse(maxUpdateSchemas.message_callback, value);
    if (update.message === null) return { status: 'ignored', reason: 'missing_message' };
    if (!privateChat(update.message)) return { status: 'ignored', reason: 'non_private' };
    if (update.message.body === null) return { status: 'ignored', reason: 'missing_message' };
    if (update.callback.user.is_bot || (options.expectedProviderUserId !== undefined && options.expectedProviderUserId !== update.callback.user.user_id)) return { status: 'ignored', reason: 'sender_mismatch' };
    const payload = update.callback.payload ?? '';
    return bounded({
      status: 'normalized', kind: 'button', providerUserId: update.callback.user.user_id,
      providerChatId: update.message.recipient.chat_id,
      providerEventKey: `callback:${canonicalHash([update.callback.callback_id, update.callback.user.user_id, update.message.body.mid, payload, update.callback.timestamp])}`,
      callbackPayload: payload, occurredAt: update.callback.timestamp,
      ...(update.message.link?.type === 'reply' ? { replyToMessageId: update.message.link.message.mid } : {}),
    });
  }

  return { status: 'ignored', reason: 'unsupported' };
}
