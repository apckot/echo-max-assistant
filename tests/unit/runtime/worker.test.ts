import { afterEach, expect, test, vi } from 'vitest';
import { startWorkerLoop } from '../../../src/runtime/worker.js';
import type { ConversationLease } from '../../../src/modules/intake/application/conversation-queue.js';

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const lease = (id: number) => ({ conversationId: String(id), userId: 'user', ownerId: 'owner',
  leaseGeneration: 1n, leaseUntil: new Date(60_000), attemptCount: 0 }) as ConversationLease;
afterEach(() => vi.useRealTimers());

test('claims only free capacity and periodically discovers work without notifications', async () => {
  vi.useFakeTimers(); const pending = [lease(1), lease(2), lease(3)];
  const releases = new Map<string, ReturnType<typeof deferred<{ kind: 'drained' }>>>();
  const limits: number[] = []; let maximum = 0;
  const runtime = startWorkerLoop({ concurrency: 2, leaseMs: 60_000, renewMs: 20_000,
    queue: { claim: async ({ limit }) => { limits.push(limit); return pending.splice(0, limit); },
      renew: async () => new Date(80_000) },
    process: { run: async (item) => { const wait = deferred<{ kind: 'drained' }>();
      releases.set(item.conversationId, wait); maximum = Math.max(maximum, releases.size);
      try { return await wait.promise; } finally { releases.delete(item.conversationId); } } },
    close: async () => {},
  });
  await vi.advanceTimersByTimeAsync(500);
  expect([...releases.keys()]).toEqual(['1', '2']); expect(limits).toEqual([2]);
  releases.get('1')!.resolve({ kind: 'drained' }); await vi.advanceTimersByTimeAsync(100);
  expect([...releases.keys()]).toEqual(['2', '3']); expect(limits.at(-1)).toBe(1); expect(maximum).toBe(2);
  const stopped = runtime.stop(); for (const wait of releases.values()) wait.resolve({ kind: 'drained' });
  await stopped; expect(vi.getTimerCount()).toBe(0);
});

test('serializes scans, abandons a late claim on stop and closes only after it settles', async () => {
  vi.useFakeTimers(); const claim = deferred<ConversationLease[]>(); let claims = 0; let runs = 0; let closed = false;
  const runtime = startWorkerLoop({ concurrency: 1, leaseMs: 60_000, renewMs: 20_000,
    queue: { claim: () => { claims++; return claim.promise; }, renew: async () => null },
    process: { run: async () => { runs++; return { kind: 'drained' }; } }, close: async () => { closed = true; } });
  await vi.advanceTimersByTimeAsync(1000); expect(claims).toBe(1);
  const stopped = runtime.stop(); expect(runtime.stop()).toBe(stopped); expect(closed).toBe(false);
  claim.resolve([lease(1)]); await stopped;
  await vi.advanceTimersByTimeAsync(60_000); expect({ claims, runs, closed }).toEqual({ claims: 1, runs: 0, closed: true });
  expect(vi.getTimerCount()).toBe(0);
});

test('renews independently without overlap, drains renewal after processing, and observes failures', async () => {
  vi.useFakeTimers(); const processing = deferred<{ kind: 'drained' }>(); const renewal = deferred<Date | null>();
  let claimed = false; let renewals = 0; let closed = false;
  const runtime = startWorkerLoop({ concurrency: 1, leaseMs: 60_000, renewMs: 20_000,
    queue: { claim: async () => { if (claimed) throw new Error('database unavailable'); claimed = true; return [lease(1)]; },
      renew: () => { renewals++; return renewal.promise; } },
    process: { run: () => processing.promise }, close: async () => { closed = true; } });
  await vi.advanceTimersByTimeAsync(40_000); expect(renewals).toBe(1);
  processing.reject(new Error('database timed out')); await vi.advanceTimersByTimeAsync(100);
  const stopped = runtime.stop(); await Promise.resolve(); expect(closed).toBe(false);
  renewal.reject(new Error('lease lost')); await stopped; expect(closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

test('an immediate stop prevents a queued scan from issuing any claim', async () => {
  vi.useFakeTimers(); let claims = 0;
  const runtime = startWorkerLoop({ concurrency: 1, leaseMs: 60_000, renewMs: 20_000,
    queue: { claim: async () => { claims++; return []; }, renew: async () => null },
    process: { run: async () => ({ kind: 'drained' }) }, close: async () => {} });
  await runtime.stop(); expect(claims).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
