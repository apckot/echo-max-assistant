import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMaxSender } from '../../../src/infrastructure/max/max-client.js';

const servers: ReturnType<typeof createServer>[] = [];
const draft = { version: 1, kind: 'text', text: 'private text' } as const;
const secret = 'private-token';
const success = JSON.stringify({ message: { body: { mid: 'confirmed' } } });

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
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('MAX certainty hardening', () => {
  it.each([
    [429, { status: 'not_sent', code: 'rate_limited', retryable: true }],
    [400, { status: 'not_sent', code: 'rejected', retryable: false }],
    [500, { status: 'uncertain', code: 'server_failure' }],
    [302, { status: 'uncertain', code: 'unexpected_status' }],
  ] as const)('cancels a stalled chunked HTTP %i body promptly and never follows redirects', async (status, outcome) => {
    let destinationCalls = 0;
    const destination = await fakeMax((_request, response) => { destinationCalls++; response.end(success); });
    let closed = false;
    const baseUrl = await fakeMax((_request, response) => {
      response.on('close', () => { closed = true; });
      response.writeHead(status, { Location: destination, 'Content-Type': 'application/json' });
      response.write(secret); // No end: cleanup must not wait for a drain or the 2s deadline.
    });
    const sender = createMaxSender({ token: secret, baseUrl, timeoutMs: 2000 });
    expect(await sender.send('1', draft)).toEqual(outcome);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500, interval: 10 });
    expect(destinationCalls).toBe(0);
  });

  it('keeps preconnection-shaped body errors uncertain after receiving headers', async () => {
    const error = Object.assign(new Error(secret), { code: 'ECONNREFUSED', syscall: 'connect' });
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.error(error); },
    }));
    const sender = createMaxSender({ token: secret, fetchImpl });
    expect(await sender.send('1', draft)).toEqual({ status: 'uncertain', code: 'transport_failure' });
  });

  it.each([
    ['9007199254741', { status: 'not_sent', code: 'rate_limit_unschedulable', retryable: false }],
    ['8640000000000', { status: 'not_sent', code: 'rate_limit_unschedulable', retryable: false }],
    ['9'.repeat(400), { status: 'not_sent', code: 'rate_limit_unschedulable', retryable: false }],
    [undefined, { status: 'not_sent', code: 'rate_limited', retryable: true }],
    ['nonsense', { status: 'not_sent', code: 'rate_limited', retryable: true }],
    ['-1', { status: 'not_sent', code: 'rate_limited', retryable: true }],
    ['1.5', { status: 'not_sent', code: 'rate_limited', retryable: true }],
    ['+3', { status: 'not_sent', code: 'rate_limited', retryable: true }],
    ['0', { status: 'not_sent', code: 'rate_limited', retryable: true, retryAfterMs: 0 }],
    ['2147484', { status: 'not_sent', code: 'rate_limited', retryable: true, retryAfterMs: 2147484000 }],
  ] as const)('preserves Retry-After restriction %s without numeric-to-date reinterpretation', async (header, outcome) => {
    const baseUrl = await fakeMax((_request, response) => {
      response.writeHead(429, header === undefined ? {} : { 'Retry-After': header });
      response.end(secret);
    });
    expect(await createMaxSender({ token: secret, baseUrl }).send('1', draft)).toEqual(outcome);
  });

  it.each([
    ['Sun, 04 Oct 2026 12:00:03 GMT', 3000],
    ['Sun, 04 Oct 2026 11:59:59 GMT', 0],
  ])('preserves the HTTP-date minimum %s', async (header, delay) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 4, 12));
    const baseUrl = await fakeMax((_request, response) => {
      response.writeHead(429, { 'Retry-After': header });
      response.end();
    });
    expect(await createMaxSender({ token: secret, baseUrl }).send('1', draft)).toEqual({
      status: 'not_sent', code: 'rate_limited', retryable: true, retryAfterMs: delay,
    });
  });

  it.each([
    { timeoutMs: 2147483648 }, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 },
    { timeoutMs: NaN }, { timeoutMs: Infinity }, { maxResponseBytes: 0 }, { maxResponseBytes: 1.5 },
    { maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 }, { token: `${secret}\n` },
    { baseUrl: `http://example.com/${secret}` }, { baseUrl: `https://${secret}@example.com` },
    { baseUrl: `https://example.com/?token=${secret}` }, { baseUrl: `https://example.com/#${secret}` },
    { baseUrl: secret },
  ])('rejects unsafe configuration with a constant secret-free error: %j', (options) => {
    expect(() => createMaxSender({ token: secret, ...options })).toThrowError(new Error('invalid_max_sender_configuration'));
  });

  it('accepts the Node timer boundary and completes without waiting for it', async () => {
    const baseUrl = await fakeMax((_request, response) => response.end(success));
    expect(await createMaxSender({ token: secret, baseUrl, timeoutMs: 2147483647 }).send('1', draft)).toEqual({
      status: 'sent', externalMessageId: 'confirmed',
    });
  });

  it.each(['01', '-0', '+1', ' 1', '1\n', '-9223372036854775809', '9'.repeat(100000)])(
    'rejects noncanonical/out-of-range/excessive recipient case %# before fetch', async (recipient) => {
      let calls = 0;
      const sender = createMaxSender({ token: secret, fetchImpl: async () => { calls++; return new Response(success); } });
      expect(await sender.send(recipient, draft)).toEqual({ status: 'not_sent', code: 'invalid_input', retryable: false });
      expect(calls).toBe(0);
    },
  );

  it.each(['\u0000', '\ud800', '\udc00', '😀'.repeat(4001)])('rejects invalid/oversized Unicode case %# before fetch', async (text) => {
    let calls = 0;
    const sender = createMaxSender({ token: secret, fetchImpl: async () => { calls++; return new Response(success); } });
    expect(await sender.send('1', { ...draft, text })).toEqual({ status: 'not_sent', code: 'invalid_input', retryable: false });
    expect(calls).toBe(0);
  });

  it('sends 4000 astral code points with the exact negative int64 boundary', async () => {
    let body = '';
    let url = '';
    const baseUrl = await fakeMax(async (request, response) => {
      url = request.url ?? '';
      for await (const chunk of request) body += String(chunk);
      response.end(success);
    });
    const text = '😀'.repeat(4000);
    expect(await createMaxSender({ token: secret, baseUrl }).send('-9223372036854775808', { ...draft, text })).toEqual({
      status: 'sent', externalMessageId: 'confirmed',
    });
    expect(url).toBe('/messages?user_id=-9223372036854775808');
    expect(JSON.parse(body)).toEqual({ text });
    expect(body).not.toContain(secret);
  });

  it.each(['chunked', 'content-length'] as const)('counts actual bytes and cancels oversized %s success', async (mode) => {
    let closed = false;
    const baseUrl = await fakeMax((_request, response) => {
      response.on('close', () => { closed = true; });
      response.writeHead(200, mode === 'content-length' ? { 'Content-Length': '10000' } : {});
      response.write(success.slice(0, 8));
      response.write(success.slice(8)); // Leave open: exceeding actual-byte bound must cancel immediately.
    });
    expect(await createMaxSender({ token: secret, baseUrl, maxResponseBytes: 16 }).send('1', draft)).toEqual({
      status: 'uncertain', code: 'response_too_large',
    });
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500, interval: 10 });
  });

  it.each(['reset-after-headers', 'content-length-mismatch'] as const)('keeps partial success %s uncertain', async (mode) => {
    const baseUrl = await fakeMax((_request, response) => {
      response.writeHead(200, mode === 'content-length-mismatch' ? { 'Content-Length': '10000', Connection: 'close' } : {});
      response.write('{"message":');
      setImmediate(() => mode === 'content-length-mismatch' ? response.end() : response.destroy());
    });
    expect(await createMaxSender({ token: secret, baseUrl, timeoutMs: 200 }).send('1', draft)).toEqual({
      status: 'uncertain', code: 'transport_failure',
    });
  });

  it('keeps a reset after reading the request uncertain even without response headers', async () => {
    const baseUrl = await fakeMax(async (request, response) => {
      for await (const _chunk of request) { /* provider may have accepted */ }
      response.destroy();
    });
    expect(await createMaxSender({ token: secret, baseUrl }).send('1', draft)).toEqual({ status: 'uncertain', code: 'transport_failure' });
  });

  it('times out after reading the request when response headers never arrive', async () => {
    let requestRead = false;
    const baseUrl = await fakeMax(async (request) => {
      for await (const _chunk of request) { /* consume before stalling */ }
      requestRead = true;
    });
    expect(await createMaxSender({ token: secret, baseUrl, timeoutMs: 100 }).send('1', draft)).toEqual({ status: 'uncertain', code: 'timeout' });
    expect(requestRead).toBe(true);
  });

  it('accepts a long valid message ID within the response byte bound', async () => {
    const mid = '😀'.repeat(5000);
    const baseUrl = await fakeMax((_request, response) => response.end(JSON.stringify({ message: { body: { mid } } })));
    expect(await createMaxSender({ token: secret, baseUrl }).send('1', draft)).toEqual({ status: 'sent', externalMessageId: mid });
  });

  it.each(['', 'null', '{"message":', ...['', '\u0000', '\ud800', '\udc00'].map((mid) => JSON.stringify({ message: { body: { mid } } }))])(
    'keeps incomplete/malformed success case %# secret-free', async (body) => {
      const baseUrl = await fakeMax((_request, response) => response.end(body));
      expect(await createMaxSender({ token: secret, baseUrl }).send('1', draft)).toEqual({ status: 'uncertain', code: 'invalid_response' });
    },
  );

  it('keeps malformed UTF-8 success uncertain without exposing raw bytes', async () => {
    const baseUrl = await fakeMax((_request, response) => response.end(Buffer.from([0xc3, 0x28])));
    expect(await createMaxSender({ token: secret, baseUrl }).send('1', draft)).toEqual({ status: 'uncertain', code: 'transport_failure' });
  });

  it.each(['generic', 'cycle', 'aggregate-cycle', 'throwing-cause', 'deep', 'mixed-aggregate', 'sparse-aggregate', 'proven-aggregate', 'dns', 'dns-again', 'wrong-syscall'] as const)(
    'sanitizes unusual fetch failure %s with finite traversal', async (shape) => {
      const refused = Object.assign(new Error(secret), { code: 'ECONNREFUSED', syscall: 'connect' });
      let error: unknown = new TypeError(`${secret} private recipient=1 text=${draft.text}`);
      if (shape === 'cycle') { const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic; error = cyclic; }
      if (shape === 'aggregate-cycle') { const cyclic = new AggregateError([]); cyclic.errors.push(cyclic); error = cyclic; }
      if (shape === 'throwing-cause') error = { get cause() { throw new Error(secret); } };
      if (shape === 'deep') { for (let index = 0; index < 10000; index++) error = { cause: error }; }
      if (shape === 'mixed-aggregate') error = new AggregateError([refused, error], secret);
      if (shape === 'sparse-aggregate') { const sparse = new AggregateError([]); sparse.errors.length = 1; error = sparse; }
      if (shape === 'proven-aggregate') error = new AggregateError([refused], secret);
      if (shape === 'wrong-syscall') error = { code: 'ECONNREFUSED', syscall: 'read', message: secret };
      if (shape === 'dns-again') error = { code: 'EAI_AGAIN', syscall: 'getaddrinfo', message: secret };
      if (shape === 'dns') error = { cause: Object.assign(new Error(secret), { code: 'ENOTFOUND', syscall: 'getaddrinfo' }) };
      const sender = createMaxSender({ token: secret, fetchImpl: async () => { throw error; } });
      expect(await sender.send('1', draft)).toEqual(['dns', 'dns-again', 'proven-aggregate'].includes(shape)
        ? { status: 'not_sent', code: 'preconnection_failure', retryable: true }
        : { status: 'uncertain', code: 'transport_failure' });
    },
  );
});
