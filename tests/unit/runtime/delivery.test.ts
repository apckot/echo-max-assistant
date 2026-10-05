import { afterEach, expect, test, vi } from 'vitest';
import { createDelivery, startDeliveryLoop } from '../../../src/runtime/delivery.js';
import type { DeliveryLease } from '../../../src/modules/delivery/application/delivery-queue.js';
import { parseRuntimeConfig } from '../../../src/shared/config/config.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const lease = (id: number) => ({ outboundMessageId: String(id), userId: 'user', ownerId: 'owner',
  leaseGeneration: 1n, leaseUntil: new Date(60_000), attemptCount: 0 }) as DeliveryLease;
const completed = { status: 'completed', completion: { status: 'sent' } } as const;
const timing = { concurrency: 2, leaseMs: 60_000, renewMs: 20_000 };
afterEach(() => vi.useRealTimers());

test('bounds active sends and polls free capacity without notifications', async () => {
  vi.useFakeTimers();
  const pending = [lease(1), lease(2), lease(3)];
  const sends = new Map<string, ReturnType<typeof deferred<typeof completed>>>();
  const limits: number[] = [];
  const runtime = startDeliveryLoop({ ...timing,
    queue: { claim: async ({ limit }) => { limits.push(limit); return pending.splice(0, limit); },
      renew: async () => new Date(80_000) },
    worker: { run: async (item) => {
      const sending = deferred<typeof completed>();
      sends.set(item.outboundMessageId, sending);
      try { return await sending.promise; } finally { sends.delete(item.outboundMessageId); }
    } }, close: async () => {},
  });
  await vi.advanceTimersByTimeAsync(500);
  expect([...sends.keys()]).toEqual(['1', '2']);
  expect(limits).toEqual([2]);
  sends.get('1')!.resolve(completed);
  await vi.advanceTimersByTimeAsync(100);
  expect([...sends.keys()]).toEqual(['2', '3']);
  expect(limits).toEqual([2, 1]);
  const stopped = runtime.stop();
  for (const sending of sends.values()) sending.resolve(completed);
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
});

test('serializes scans and drains a late claim without launching after stop', async () => {
  vi.useFakeTimers();
  const claim = deferred<DeliveryLease[]>();
  let claims = 0; let sends = 0; let closes = 0;
  const runtime = startDeliveryLoop({ ...timing,
    queue: { claim: () => { claims++; return claim.promise; }, renew: async () => null },
    worker: { run: async () => { sends++; return completed; } }, close: async () => { closes++; },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(claims).toBe(1);
  const stopped = runtime.stop();
  expect(runtime.stop()).toBe(stopped);
  expect(closes).toBe(0);
  claim.resolve([lease(1)]);
  await stopped;
  await vi.advanceTimersByTimeAsync(60_000);
  expect({ claims, sends, closes }).toEqual({ claims: 1, sends: 0, closes: 1 });
  expect(vi.getTimerCount()).toBe(0);
});

test('keeps renewing a blocked send after stop, prevents overlap, and drains final renewal', async () => {
  vi.useFakeTimers();
  const sending = deferred<typeof completed>();
  const renewal = deferred<Date | null>();
  let renewals = 0; let closed = false;
  const runtime = startDeliveryLoop({ ...timing, concurrency: 1,
    queue: { claim: async () => [lease(1)], renew: () => { renewals++; return renewal.promise; } },
    worker: { run: () => sending.promise }, close: async () => { closed = true; },
  });
  await vi.advanceTimersByTimeAsync(0);
  const stopped = runtime.stop();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(renewals).toBe(1);
  expect(closed).toBe(false);
  sending.resolve(completed);
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toBe(false);
  renewal.resolve(new Date(100_000));
  await stopped;
  expect(closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('observes claim, worker and renewal errors and continues polling', async () => {
  vi.useFakeTimers();
  const sending = deferred<typeof completed>();
  let claims = 0; let runs = 0; let renewals = 0;
  const runtime = startDeliveryLoop({ ...timing, concurrency: 1,
    queue: { claim: async () => {
      claims++;
      if (claims === 1) throw new Error('private database error');
      return claims === 2 ? [lease(1)] : [];
    }, renew: async () => { renewals++; throw new Error('private renewal error'); } },
    worker: { run: () => { runs++; return sending.promise; } }, close: async () => {},
  });
  await vi.advanceTimersByTimeAsync(40_100);
  expect({ claims, runs, renewals }).toEqual({ claims: 2, runs: 1, renewals: 2 });
  sending.reject(new Error('private completion error'));
  await vi.advanceTimersByTimeAsync(100);
  expect(claims).toBe(3);
  await runtime.stop();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([true, false])('immediate stop or disabled runtime never claims (enabled=%s)', async (enabled) => {
  vi.useFakeTimers();
  let claims = 0;
  const runtime = startDeliveryLoop({ ...timing, enabled,
    queue: { claim: async () => { claims++; return []; }, renew: async () => null },
    worker: { run: async () => completed }, close: async () => {},
  });
  if (!enabled) await vi.advanceTimersByTimeAsync(1000);
  await runtime.stop();
  expect(claims).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('stop prevents another queued worker invocation from starting', async () => {
  vi.useFakeTimers();
  let runs = 0;
  const runtime = startDeliveryLoop({ ...timing,
    queue: { claim: async () => [lease(1), lease(2)], renew: async () => null },
    worker: { run: async () => { runs++; void runtime.stop(); return completed; } }, close: async () => {},
  });
  await vi.advanceTimersByTimeAsync(0);
  await runtime.stop();
  expect(runs).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

const environment = {
  ...Object.fromEntries(['gateway', 'worker', 'delivery', 'scheduler', 'migrator'].map((role) =>
    [`DATABASE_URL_${role === 'migrator' ? 'MIGRATIONS' : role.toUpperCase()}`,
      `postgres://echo_${role}:synthetic-password@localhost/echo`])),
  MAX_BOT_TOKEN: 'synthetic-token', MAX_WEBHOOK_SECRET: 'secret', MAX_WEBHOOK_URL: 'https://example.org/hook',
};
test('delivery validates its timing locally without rejecting fast worker configuration', async () => {
  const fast = { ...environment, WORK_LEASE_MS: 1200, WORK_LEASE_RENEW_MS: 300, HANDLER_TIMEOUT_MS: 20 };
  expect(() => parseRuntimeConfig(fast)).not.toThrow();
  expect(() => createDelivery(fast)).toThrow('invalid_delivery_timing');
  expect(() => createDelivery({ ...environment, WORK_LEASE_MS: 40_000, WORK_LEASE_RENEW_MS: 30_000 }))
    .toThrow('invalid_delivery_timing');
  expect(() => createDelivery(fast, { timeoutMs: Number.NaN })).toThrow('invalid_delivery_timing');
  await createDelivery(fast, { timeoutMs: 100 }).stop();
  await createDelivery(environment).stop();
});

test('invalid sender options expose no credentials and start no interval', () => {
  vi.useFakeTimers();
  expect(() => createDelivery(environment, { baseUrl: 'https://synthetic-password@example.org' }))
    .toThrow(/^invalid_max_sender_configuration$/);
  expect(vi.getTimerCount()).toBe(0);
});
