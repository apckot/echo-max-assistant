import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { createMaxSender } from '../../../src/infrastructure/max/max-client.js';

const servers: ReturnType<typeof createServer>[] = [];

async function fakeMax(handle: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handle);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected test server address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('MAX sender', () => {
  it('sends plain text with exact signed-int64 user ID and token only in Authorization', async () => {
    const observed: { url?: string; authorization?: string; contentType?: string; body?: string } = {};
    const baseUrl = await fakeMax(async (request, response) => {
      observed.url = request.url;
      observed.authorization = request.headers.authorization;
      observed.contentType = request.headers['content-type'];
      observed.body = await new Promise<string>((resolve) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => { body += chunk; });
        request.on('end', () => resolve(body));
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: { body: { mid: 'message-1' } } }));
    });
    const sender = createMaxSender({ token: 'test-secret', baseUrl });

    const result = await sender.send('9223372036854775807', { version: 1, kind: 'text', text: 'Hello 🌍' });

    expect(result).toEqual({ status: 'sent', externalMessageId: 'message-1' });
    expect(observed).toEqual({
      url: '/messages?user_id=9223372036854775807',
      authorization: 'test-secret',
      contentType: 'application/json',
      body: JSON.stringify({ text: 'Hello 🌍' }),
    });
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });

  it('rejects invalid recipient and message before any network call', async () => {
    let calls = 0;
    const baseUrl = await fakeMax((_request, response) => { calls++; response.end(); });
    const sender = createMaxSender({ token: 'secret', baseUrl });
    const invalid = { version: 1, kind: 'text', text: 'x', extra: 'field' } as never;
    expect(await sender.send('9223372036854775808', { version: 1, kind: 'text', text: 'x' })).toEqual({ status: 'not_sent', code: 'invalid_input', retryable: false });
    expect(await sender.send('1', invalid)).toEqual({ status: 'not_sent', code: 'invalid_input', retryable: false });
    expect(await sender.send('1', { version: 1, kind: 'text', text: '😀'.repeat(4001) })).toEqual({ status: 'not_sent', code: 'invalid_input', retryable: false });
    expect(calls).toBe(0);
  });

  it('classifies an unambiguous refused connection as retryable not_sent', async () => {
    const baseUrl = await fakeMax((_request, response) => response.end());
    const sender = createMaxSender({ token: 'secret', baseUrl });
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await sender.send('1', { version: 1, kind: 'text', text: 'hello' })).toEqual({ status: 'not_sent', code: 'preconnection_failure', retryable: true });
  });

  it('classifies 429 with Retry-After as retryable rejection', async () => {
    const baseUrl = await fakeMax((_request, response) => {
      response.writeHead(429, { 'Retry-After': '3' });
      response.end('rate limited');
    });
    const sender = createMaxSender({ token: 'secret', baseUrl });
    expect(await sender.send('1', { version: 1, kind: 'text', text: 'hello' })).toEqual({ status: 'not_sent', code: 'rate_limited', retryable: true, retryAfterMs: 3000 });
  });

  it.each([400, 401, 403, 404, 405])('classifies HTTP %i as permanent rejection', async (status) => {
    const baseUrl = await fakeMax((_request, response) => { response.writeHead(status); response.end('private provider error'); });
    const sender = createMaxSender({ token: 'secret', baseUrl });
    expect(await sender.send('1', { version: 1, kind: 'text', text: 'hello' })).toEqual({ status: 'not_sent', code: 'rejected', retryable: false });
  });

  it.each([500, 503])('keeps HTTP %i uncertain even with an error body', async (status) => {
    const baseUrl = await fakeMax((_request, response) => { response.writeHead(status); response.end('{"code":"bad"}'); });
    const sender = createMaxSender({ token: 'secret', baseUrl });
    expect(await sender.send('1', { version: 1, kind: 'text', text: 'hello' })).toEqual({ status: 'uncertain', code: 'server_failure' });
  });

  it('marks body-read-then-stall as uncertain timeout', async () => {
    let requestRead = false;
    const baseUrl = await fakeMax(async (request, response) => {
      for await (const _chunk of request) { /* consume request before stalling */ }
      requestRead = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"message":');
    });
    const sender = createMaxSender({ token: 'secret', baseUrl, timeoutMs: 200 });
    expect(await sender.send('1', { version: 1, kind: 'text', text: 'hello' })).toEqual({ status: 'uncertain', code: 'timeout' });
    expect(requestRead).toBe(true);
  });

  it.each(['{}', '{broken', '{"message":{"body":{"mid":""}}}'])('keeps malformed 200 responses uncertain', async (body) => {
    const baseUrl = await fakeMax((_request, response) => { response.writeHead(200); response.end(body); });
    const sender = createMaxSender({ token: 'secret', baseUrl });
    expect(await sender.send('1', { version: 1, kind: 'text', text: 'hello' })).toEqual({ status: 'uncertain', code: 'invalid_response' });
  });
});
