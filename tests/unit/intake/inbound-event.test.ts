import { describe, expect, test } from 'vitest';
import { validateInboundPayload } from '../../../src/modules/intake/domain/inbound-event.js';

describe('inbound payload', () => {
  test('accepts provider-neutral variants', () => {
    expect(validateInboundPayload({ kind: 'text', text: 'hello', replyToMessageId: 'reply-1' })).toBe(true);
    expect(validateInboundPayload({ kind: 'voice', media: { url: 'https://example.test/audio', token: 'token' } })).toBe(true);
    expect(validateInboundPayload({ kind: 'button', callbackPayload: 'action' })).toBe(true);
    expect(validateInboundPayload({ kind: 'lifecycle', lifecycleType: 'started' })).toBe(true);
  });

  test('rejects malformed variants and empty fields', () => {
    expect(validateInboundPayload({ kind: 'text', text: '' })).toBe(false);
    expect(validateInboundPayload({ kind: 'voice', media: { url: '', token: 'token' } })).toBe(false);
    expect(validateInboundPayload({ kind: 'button', callbackPayload: 4 })).toBe(false);
    expect(validateInboundPayload({ kind: 'lifecycle', lifecycleType: 'unknown' })).toBe(false);
    expect(validateInboundPayload({ kind: 'text', text: 'ok', media: { url: 'x', token: 'y' } })).toBe(false);
  });

  test('enforces both Unicode code point and UTF-8 byte text limits', () => {
    expect(validateInboundPayload({ kind: 'text', text: 'a'.repeat(16_000) })).toBe(true);
    expect(validateInboundPayload({ kind: 'text', text: 'a'.repeat(16_001) })).toBe(false);
    expect(validateInboundPayload({ kind: 'text', text: '😀'.repeat(16_000) })).toBe(true);
    expect(validateInboundPayload({ kind: 'text', text: '😀'.repeat(16_001) })).toBe(false);
    expect(validateInboundPayload({ kind: 'text', text: '界'.repeat(16_000) })).toBe(true);
    expect(validateInboundPayload({ kind: 'text', text: 'a'.repeat(15_999) + '😀'.repeat(12_289) })).toBe(false);
  });

  test('rejects normalized payloads over 128 KiB', () => {
    expect(validateInboundPayload({ kind: 'button', callbackPayload: 'a'.repeat(129 * 1024) })).toBe(false);
  });

  test('uses persisted JSONB bytes at the button boundary', () => {
    expect(validateInboundPayload({ kind: 'button', callbackPayload: 'a'.repeat(131_031) })).toBe(true);
    expect(validateInboundPayload({ kind: 'button', callbackPayload: 'a'.repeat(131_032) })).toBe(false);
  });

  test('counts escaped Unicode and optional fields at the persisted boundary', () => {
    const callbackPayload = '😀\n\\"' + 'a'.repeat(130_996);
    expect(validateInboundPayload({ kind: 'button', callbackPayload, replyToMessageId: 'r' })).toBe(true);
    expect(validateInboundPayload({ kind: 'button', callbackPayload: callbackPayload + 'a', replyToMessageId: 'r' })).toBe(false);
  });

  test('counts nested voice media at the persisted boundary', () => {
    const token = 'a'.repeat(130_979);
    expect(validateInboundPayload({ kind: 'voice', media: { url: 'https://x/😀\n', token }, replyToMessageId: 'r' })).toBe(true);
    expect(validateInboundPayload({ kind: 'voice', media: { url: 'https://x/😀\n', token: token + 'a' }, replyToMessageId: 'r' })).toBe(false);
  });
});
