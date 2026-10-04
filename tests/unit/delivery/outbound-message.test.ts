import { describe, expect, test } from 'vitest';
import { OutboundMessageDraftSchema } from '../../../src/modules/delivery/domain/outbound-message.js';

describe('outbound message draft contract', () => {
  test('accepts the neutral version 1 text draft', () => {
    const draft = { version: 1, kind: 'text', text: 'hello' };
    expect(OutboundMessageDraftSchema.safeParse(draft)).toEqual({ success: true, data: draft });
  });

  test.each([
    { version: 2, kind: 'text', text: 'hello' },
    { version: 1, kind: 'image', text: 'hello' },
    { version: 1, kind: 'text', text: 42 },
    { version: 1, kind: 'text', text: 'hello', provider: 'max' },
  ])('rejects drafts outside the closed version 1 text shape: %j', (draft) => {
    expect(OutboundMessageDraftSchema.safeParse(draft).success).toBe(false);
  });
});
