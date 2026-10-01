import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { createMaxWebhookApp } from '../../../src/infrastructure/http/max-webhook-route.js';
import type { NormalizedInbound } from '../../../src/infrastructure/max/update-mapper.js';

const secret = 'webhook-secret-private';
const goodBody = '{"update_type":"bot_started","timestamp":9223372036854775807,"user":{"user_id":-9223372036854775808,"is_bot":false},"chat_id":9223372036854775807}';
const textBody = '{"update_type":"message_created","timestamp":1,"message":{"sender":{"user_id":12,"is_bot":false},"recipient":{"chat_id":34,"chat_type":"dialog"},"body":{"mid":"external-mid","text":"secret-message-text"}}}';
const callbackBody = '{"update_type":"message_callback","timestamp":1,"callback":{"callback_id":"external-callback","timestamp":2,"payload":"secret-callback-payload","user":{"user_id":12,"is_bot":false}},"message":{"recipient":{"chat_id":34,"chat_type":"dialog"},"body":{"mid":"external-mid"}}}';

function fixture(options: { fence?: boolean; fail?: boolean } = {}) {
  const events: NormalizedInbound[] = [];
  const rawHashes: string[] = [];
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } });
  const app = createMaxWebhookApp({
    secret,
    restoreFence: () => options.fence ?? false,
    intake: async (event, rawSha256) => {
      events.push(event);
      rawHashes.push(rawSha256);
      if (options.fail) throw new Error('intake failure includes secret-text external-id');
      return { status: events.length === 1 ? 'created' as const : 'duplicate' as const };
    },
    logger: pino({ level: 'info' }, sink),
  });
  const post = (body: string, headers: Record<string, string> = { 'x-max-bot-api-secret': secret }, url = '/webhooks/max') =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: body });
  return { app, events, rawHashes, lines, post };
}

describe('MAX webhook', () => {
  it('rejects an empty or whitespace-only configured secret during app construction', () => {
    for (const invalidSecret of ['', ' \t\n']) {
      expect(() => createMaxWebhookApp({
        secret: invalidSecret,
        restoreFence: () => false,
        intake: async () => ({ status: 'created' }),
      })).toThrowError('max_webhook_secret_required');
    }
  });

  it('rejects missing and invalid secrets before intake', async () => {
    const { app, events, post } = fixture();
    try {
      expect((await post(goodBody, {})).statusCode).toBe(401);
      expect((await post(goodBody, { 'x-max-bot-api-secret': 'wrong' })).statusCode).toBe(401);
      expect(events).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('preserves signed int64 extrema through JSON and accepts created and duplicate events', async () => {
    const { app, events, rawHashes, post } = fixture();
    try {
      expect((await post(goodBody)).statusCode).toBe(200);
      expect((await post(goodBody)).statusCode).toBe(200);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ providerUserId: '-9223372036854775808', providerChatId: '9223372036854775807', occurredAt: '9223372036854775807' });
      expect(rawHashes).toEqual([createHash('sha256').update(goodBody).digest('hex'), createHash('sha256').update(goodBody).digest('hex')]);
    } finally { await app.close(); }
  });

  it('rejects invalid JSON, rounded or noncanonical ID numbers, excessive IDs and oversized bodies', async () => {
    const { app, events, post } = fixture();
    try {
      for (const body of [
        '{broken',
        goodBody.replace('-9223372036854775808', '1e3'),
        goodBody.replace('-9223372036854775808', '9'.repeat(21)),
        goodBody.replace('-9223372036854775808', '9223372036854775808'),
        goodBody.replace('-9223372036854775808', '9007199254740992.0'),
        ' '.repeat(1024 * 1024 + 1),
      ]) expect((await post(body)).statusCode).toBe(400);
      expect(events).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('rejects malformed UTF-8 rather than replacing bytes in the signed body', async () => {
    const { app, events } = fixture();
    try {
      const bytes = Buffer.concat([Buffer.from('{"update_type":"message_edited","x":"'), Buffer.from([0xff]), Buffer.from('"}')]);
      const response = await app.inject({ method: 'POST', url: '/webhooks/max', headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': secret }, payload: bytes });
      expect(response.statusCode).toBe(400);
      expect(events).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('returns 200 for unsupported updates without intake', async () => {
    const { app, events, post } = fixture();
    try {
      expect((await post('{"update_type":"message_edited","timestamp":1}')).statusCode).toBe(200);
      expect(events).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('returns 503 for intake failure or an active restore fence', async () => {
    for (const options of [{ fail: true }, { fence: true }]) {
      const { app, events, post } = fixture(options);
      try {
        expect((await post(goodBody)).statusCode).toBe(503);
        expect(events).toHaveLength(options.fence ? 0 : 1);
      } finally { await app.close(); }
    }
  });

  it('keeps secrets and attacker-controlled request data out of logs on every path', async () => {
    for (const scenario of ['success', 'error', 'malformed', 'missing-auth', 'text', 'callback'] as const) {
      const { app, lines, post } = fixture({ fail: scenario === 'error' });
      try {
        const body = scenario === 'malformed' ? '{"secret-text":' : scenario === 'text' ? textBody : scenario === 'callback' ? callbackBody : goodBody;
        const headers = scenario === 'missing-auth' ? {} : { 'x-max-bot-api-secret': secret, authorization: 'Bearer attacker-authorization', 'x-request-id': 'attacker-request-id', 'x-attacker': 'attacker-header' };
        await post(body, headers, '/webhooks/max?token=attacker-query');
        const log = lines.join('');
        expect(lines.length).toBeGreaterThan(0);
        expect(JSON.parse(lines[0]!).correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27,}$/);
        for (const sensitive of [secret, 'secret-text', 'secret-message-text', 'secret-callback-payload', 'external-mid', 'external-callback', '-9223372036854775808', '9223372036854775807', 'attacker-authorization', 'attacker-request-id', 'attacker-header', 'attacker-query', 'intake failure includes']) {
          expect(log).not.toContain(sensitive);
        }
      } finally { await app.close(); }
    }
  });
});
