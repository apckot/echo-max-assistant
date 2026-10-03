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
});
