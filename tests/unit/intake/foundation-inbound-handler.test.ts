import { describe, expect, test } from 'vitest';
import type { InboundPayload } from '../../../src/modules/intake/domain/inbound-event.js';
import {
  FoundationInboundHandler,
  type HandleInboundInput,
  type HandleInboundResult,
  type InboundHandler,
  type OutboundMessageDraft,
} from '../../../src/modules/intake/application/inbound-handler.js';

const handler: InboundHandler = new FoundationInboundHandler();

describe('foundation inbound handler', () => {
  test.each([
    {
      name: 'text',
      payload: { kind: 'text', text: 'SECRET_USER_TEXT', replyToMessageId: 'SECRET_EXTERNAL_ID' },
      messages: [{ version: 1, kind: 'text', text: 'Получено сообщение №42.' }],
    },
    {
      name: 'voice',
      payload: { kind: 'voice', media: { url: 'SECRET_VOICE_URL', token: 'SECRET_VOICE_TOKEN' }, replyToMessageId: 'SECRET_EXTERNAL_ID' },
      messages: [{ version: 1, kind: 'text', text: 'Голосовые сообщения пока недоступны. Поддержка появится на следующем этапе.' }],
    },
    {
      name: 'unknown button',
      payload: { kind: 'button', callbackPayload: 'SECRET_CALLBACK_PAYLOAD', replyToMessageId: 'SECRET_EXTERNAL_ID' },
      messages: [{ version: 1, kind: 'text', text: 'Кнопка устарела или уже использована' }],
    },
    {
      name: 'lifecycle started',
      payload: { kind: 'lifecycle', lifecycleType: 'started' },
      messages: [],
    },
    {
      name: 'lifecycle stopped',
      payload: { kind: 'lifecycle', lifecycleType: 'stopped' },
      messages: [],
    },
  ] as const)('returns a versioned neutral result for $name', async ({ payload, messages }) => {
    const input: HandleInboundInput = { sequence: 42n, payload: payload as InboundPayload };
    const result: HandleInboundResult = await handler.handle(input);

    expect(result).toEqual({ receiptType: 'foundation_echo', receiptVersion: 1, messages });
    expect(await handler.handle(input)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/SECRET_/);
  });

  test('uses the full internal bigint sequence without touching user text', async () => {
    const sequence = 9_223_372_036_854_775_807n;
    const first = await handler.handle({ sequence, payload: { kind: 'text', text: 'private one' } });
    const second = await handler.handle({ sequence, payload: { kind: 'text', text: 'private two' } });

    expect(first).toEqual(second);
    expect(first.messages).toEqual([{ version: 1, kind: 'text', text: `Получено сообщение №${sequence}.` }]);
  });

  test('exposes a typed, ordered draft contract for later materialization', async () => {
    const result = await handler.handle({ sequence: 1n, payload: { kind: 'text', text: 'hello' } });
    const drafts: readonly OutboundMessageDraft[] = result.messages;

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toEqual({ version: 1, kind: 'text', text: 'Получено сообщение №1.' });
  });
});
