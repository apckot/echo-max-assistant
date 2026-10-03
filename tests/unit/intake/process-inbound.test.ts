import { afterEach, expect, test, vi } from 'vitest';
import { ProcessInbound, HandlerDeadlineError, type AtomicProcessingPort } from '../../../src/modules/intake/application/process-inbound.js';
import type { ConversationLease } from '../../../src/modules/intake/application/conversation-queue.js';
const lease = {} as ConversationLease;
const atomic: AtomicProcessingPort = { run: async (_lease, handle) => ({ kind: 'actionable',
  value: await handle({ sequence: 1n, payload: { kind: 'text', text: 'private' } }) }) };
afterEach(() => { vi.useRealTimers(); });
test.each(['resolve', 'reject'])('deadline is five seconds and late %s cannot change timeout', async (kind) => {
  vi.useFakeTimers();
  let resolve!: (value: never) => void; let reject!: (error: Error) => void;
  const process = new ProcessInbound(atomic, { handle: () => new Promise((yes, no) => { resolve = yes; reject = no; }) });
  const outcome = process.run(lease).catch((error: unknown) => error);
  let finished = false; void outcome.then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(4999); expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(await outcome).toBeInstanceOf(HandlerDeadlineError);
  if (kind === 'resolve') resolve({ receiptType: 'foundation_echo', receiptVersion: 1, messages: [] } as never);
  else reject(new Error('late rejection'));
  await vi.runAllTimersAsync(); expect(await outcome).toBeInstanceOf(HandlerDeadlineError);
});
test('immediate success clears the deadline timer', async () => {
  vi.useFakeTimers();
  const result = { receiptType: 'foundation_echo', receiptVersion: 1, messages: [] } as const;
  expect(await new ProcessInbound(atomic, { handle: async () => result }).run(lease)).toEqual({ kind: 'actionable', value: result });
  expect(vi.getTimerCount()).toBe(0);
});
test.each([0, -1, 5001, Infinity, NaN, 1.5])('rejects invalid handler deadline %s', (milliseconds) => {
  expect(() => new ProcessInbound(atomic, { handle: async () => { throw new Error('unused'); } }, milliseconds))
    .toThrow(RangeError);
});
test('honors a configured shorter deadline', async () => {
  vi.useFakeTimers();
  const outcome = new ProcessInbound(atomic, { handle: () => new Promise(() => {}) }, 20)
    .run(lease).catch((error: unknown) => error);
  let finished = false; void outcome.then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(20);
  expect(finished).toBe(true);
  expect(await outcome).toBeInstanceOf(HandlerDeadlineError);
});
