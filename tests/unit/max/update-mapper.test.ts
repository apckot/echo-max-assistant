import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mapMaxUpdate } from '../../../src/infrastructure/max/update-mapper.js';

const user = (id: string | number) => ({ user_id: id, first_name: 'Alice', username: null, is_bot: false, last_activity_time: 1, name: null });
const recipient = (chatId: string | number, chatType = 'dialog') => ({ chat_id: chatId, chat_type: chatType, user_id: null });
const body = (mid = 'mid-1', text: string | null = 'hello') => ({ mid, seq: 1, text, attachments: null, link: null });
const message = (changes: Record<string, unknown> = {}) => ({ sender: user('12'), recipient: recipient('34'), timestamp: 100, body: body(), ...changes });
const update = (changes: Record<string, unknown> = {}) => ({ update_type: 'message_created', timestamp: 101, message: message(), ...changes });

// Independent reference encoding: each UTF-8 field has an unsigned 32-bit byte length.
function referenceHash(...fields: string[]): string {
  const pieces = fields.map((field) => {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  return createHash('sha256').update(Buffer.concat(pieces)).digest('hex');
}

describe('MAX update mapper', () => {
  it('normalizes private text, sender ownership and reply metadata', () => {
    const result = mapMaxUpdate(update({ message: message({ link: { type: 'reply', message: body('parent') } }) }));
    expect(result).toMatchObject({ status: 'normalized', kind: 'text', providerEventKey: 'message:mid-1', providerUserId: '12', providerChatId: '34', occurredAt: '101', text: 'hello', replyToMessageId: 'parent' });
    expect(JSON.stringify(result)).not.toContain('first_name');
  });

  it('uses message mid as the dedupe key regardless of envelope time', () => {
    expect(mapMaxUpdate(update({ timestamp: 999 }))).toMatchObject({ providerEventKey: 'message:mid-1' });
  });

  it.each(['bot_started', 'bot_stopped'] as const)('normalizes %s with a distinct canonical lifecycle key', (type) => {
    const result = mapMaxUpdate({ update_type: type, timestamp: 101, user: user('12'), chat_id: '34' });
    expect(result).toMatchObject({ status: 'normalized', kind: 'lifecycle', lifecycleType: type, providerUserId: '12', providerChatId: '34', providerEventKey: `lifecycle:${referenceHash(type, '12', '34', '101')}` });
  });

  it('normalizes callback using its own timestamp, payload and original message', () => {
    const callback = { callback_id: 'cb', user: user('12'), payload: 'go', timestamp: 77 };
    const result = mapMaxUpdate({ update_type: 'message_callback', timestamp: 101, callback, message: message({ sender: { ...user('999'), is_bot: true } }) });
    expect(result).toMatchObject({ status: 'normalized', kind: 'button', providerChatId: '34', providerUserId: '12', callbackPayload: 'go', providerEventKey: `callback:${referenceHash('cb', '12', 'mid-1', 'go', '77')}` });
  });

  it('supports an official audio attachment as a reserved voice descriptor', () => {
    const audio = { type: 'audio', payload: { url: 'https://example.invalid/audio', token: 'media-token' }, transcription: null };
    const result = mapMaxUpdate(update({ message: message({ body: { ...body('voice-1', null), attachments: [audio] } }) }));
    expect(result).toMatchObject({ status: 'normalized', kind: 'voice', providerEventKey: 'message:voice-1', voice: { url: audio.payload.url, token: 'media-token' } });
  });

  it.each([
    ['unsupported', { update_type: 'message_edited', timestamp: 1 }],
    ['group message', update({ message: message({ recipient: recipient('34', 'chat') }) })],
    ['channel message', update({ message: message({ recipient: recipient('34', 'channel') }) })],
    ['bot sender', update({ message: message({ sender: { ...user('12'), is_bot: true } }) })],
    ['group callback', { update_type: 'message_callback', timestamp: 1, callback: { callback_id: 'c', user: user('12'), timestamp: 1 }, message: message({ recipient: recipient('34', 'chat') }) }],
    ['missing callback message', { update_type: 'message_callback', timestamp: 1, callback: { callback_id: 'c', user: user('12'), timestamp: 1 }, message: null }],
    ['empty text', update({ message: message({ body: body('m', ' \n ') }) })],
    ['forwarded-only message', update({ message: message({ body: null }) })],
    ['forwarded-only group message', update({ message: message({ recipient: recipient('34', 'chat'), body: null }) })],
    ['callback without original mid', { update_type: 'message_callback', timestamp: 1, callback: { callback_id: 'c', user: user('12'), timestamp: 1 }, message: message({ body: null }) }],
  ])('ignores %s without carrying raw input', (_name, value) => {
    expect(mapMaxUpdate(value)).toMatchObject({ status: 'ignored' });
  });

  it('rejects a mismatched private sender when an expected owner is supplied', () => {
    expect(mapMaxUpdate(update(), { expectedProviderUserId: '13' })).toMatchObject({ status: 'ignored' });
    expect(mapMaxUpdate(update(), { expectedProviderUserId: '12' })).toMatchObject({ status: 'normalized' });
  });

  it('enforces code point, UTF-8, and normalized payload boundaries', () => {
    expect(mapMaxUpdate(update({ message: message({ body: body('m', '😀'.repeat(16_000)) }) }))).toMatchObject({ status: 'normalized' });
    expect(mapMaxUpdate(update({ message: message({ body: body('m', '😀'.repeat(16_001)) }) }))).toMatchObject({ status: 'ignored', reason: 'text_too_large' });
    expect(mapMaxUpdate(update({ message: message({ body: body('m', '界'.repeat(21_846)) }) }))).toMatchObject({ status: 'ignored', reason: 'text_too_large' });
    expect(mapMaxUpdate({ update_type: 'message_callback', timestamp: 1, callback: { callback_id: 'c', user: user('12'), timestamp: 1, payload: 'x'.repeat(131_073) }, message: message() })).toMatchObject({ status: 'ignored', reason: 'payload_too_large' });
  });

  it('preserves signed int64 strings and rejects rounded or noncanonical IDs', () => {
    expect(mapMaxUpdate({ update_type: 'bot_started', timestamp: 1, user: user('-9223372036854775808'), chat_id: '9223372036854775807' })).toMatchObject({ status: 'normalized', providerUserId: '-9223372036854775808', providerChatId: '9223372036854775807' });
    for (const id of [9007199254740992, '01', '-0', ' 1', '12\n', 'secret-not-a-number', '9223372036854775808']) {
      expect(() => mapMaxUpdate({ update_type: 'bot_started', timestamp: 1, user: user(id), chat_id: 1 })).toThrowError('invalid_max_update');
    }
  });

  it('short-circuits oversized signed int64 strings before BigInt conversion', () => {
    const bigint = vi.spyOn(globalThis, 'BigInt');
    try {
      for (const id of ['9'.repeat(20), '9'.repeat(21), `-${'9'.repeat(20)}`]) {
        expect(() => mapMaxUpdate({ update_type: 'bot_started', timestamp: 1, user: user(id), chat_id: 1 })).toThrowError('invalid_max_update');
      }
      expect(bigint).not.toHaveBeenCalled();
    } finally {
      bigint.mockRestore();
    }
  });

  it('rejects malformed supported DTOs with a closed error', () => {
    expect(() => mapMaxUpdate({ update_type: 'message_created', timestamp: 1, message: { body: { mid: 'secret' } } })).toThrowError('invalid_max_update');
  });

  it('uses length-prefixed UTF-8 fields without delimiter collisions', () => {
    const a = mapMaxUpdate({ update_type: 'bot_started', timestamp: 4, user: user('1'), chat_id: '23' });
    const b = mapMaxUpdate({ update_type: 'bot_started', timestamp: 4, user: user('12'), chat_id: '3' });
    expect(a).toMatchObject({ providerEventKey: `lifecycle:${referenceHash('bot_started', '1', '23', '4')}` });
    expect(a).not.toMatchObject({ providerEventKey: (b as { providerEventKey: string }).providerEventKey });
    const c = mapMaxUpdate({ update_type: 'message_callback', timestamp: 2, callback: { callback_id: 'é', user: user('1'), payload: '🚀', timestamp: 3 }, message: message() });
    expect(c).toMatchObject({ providerEventKey: `callback:${referenceHash('é', '1', 'mid-1', '🚀', '3')}` });
  });
});
