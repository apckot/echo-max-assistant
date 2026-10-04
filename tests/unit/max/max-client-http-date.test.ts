import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createMaxSender } from '../../../src/infrastructure/max/max-client.js';

const draft = { version: 1, kind: 'text', text: 'private text' } as const;

describe('MAX Retry-After HTTP-date semantics', () => {
  it.each([
    ['IMF-fixdate UTC', '2026-10-04T12:00:00Z', 'Sun, 04 Oct 2026 12:00:03 GMT', 3000],
    ['asctime UTC', '2026-10-04T12:00:00Z', 'Sun Oct  4 12:00:03 2026', 3000],
    ['asctime two-digit day', '2026-10-04T12:00:00Z', 'Wed Oct 14 12:00:03 2026', 864003000],
    ['RFC850 UTC', '2026-10-04T12:00:00Z', 'Sunday, 04-Oct-26 12:00:03 GMT', 3000],
    ['RFC850 year 2050 within 50 years', '2026-10-04T12:00:00Z', 'Tuesday, 04-Oct-50 12:00:00 GMT', 757382400000],
    ['RFC850 just before 50 years', '2026-10-04T12:00:00Z', 'Sunday, 04-Oct-76 11:59:59 GMT', 1577923199000],
    ['RFC850 exactly 50 years', '2026-10-04T12:00:00Z', 'Sunday, 04-Oct-76 12:00:00 GMT', 1577923200000],
    ['RFC850 beyond 50 years folds to the past', '2026-10-04T12:00:00Z', 'Monday, 04-Oct-76 12:00:01 GMT', 0],
    ['RFC850 moving boundary retains 2050', '2000-10-04T12:00:00Z', 'Tuesday, 04-Oct-50 12:00:00 GMT', 1577836800000],
    ['RFC850 moving boundary folds 2050', '2000-10-04T11:59:59Z', 'Wednesday, 04-Oct-50 12:00:00 GMT', 0],
    ['RFC850 century rollover', '2099-10-04T12:00:00Z', 'Monday, 04-Oct-00 12:00:00 GMT', 31536000000],
  ] as const)('preserves the minimum for %s in a non-UTC timezone', async (_name, clock, header, delay) => {
    const previousTimezone = process.env.TZ;
    const server = createServer((_request, response) => {
      response.writeHead(429, { 'Retry-After': header });
      response.end();
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(clock));
    try {
      process.env.TZ = 'Europe/Moscow';
      // Prove this fixture exercises local-time parsing rather than a UTC process.
      expect(new Date(Date.now()).getTimezoneOffset()).not.toBe(0);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('unexpected test server address');
      const sender = createMaxSender({ token: 'private-token', baseUrl: `http://127.0.0.1:${address.port}` });
      expect(await sender.send('1', draft)).toEqual({
        status: 'not_sent', code: 'rate_limited', retryable: true, retryAfterMs: delay,
      });
    } finally {
      now.mockRestore();
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
