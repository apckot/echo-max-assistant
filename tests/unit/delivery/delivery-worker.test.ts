import { describe, expect, test, vi } from 'vitest';
import { DeliveryWorker, chooseDeliveryScheduling } from '../../../src/modules/delivery/application/delivery-worker.js';
import type { DeliveryLease } from '../../../src/modules/delivery/application/delivery-queue.js';
import type { UserId } from '../../../src/shared/types/identity.js';

const lease: DeliveryLease = { outboundMessageId: 'outbound', userId: 'user' as UserId,
  ownerId: 'owner', leaseGeneration: 1n, leaseUntil: new Date(), attemptCount: 0 };
const attempt = { outboundMessageId: lease.outboundMessageId, userId: lease.userId,
  ownerId: lease.ownerId, leaseGeneration: lease.leaseGeneration, attemptNumber: 1 };
const admitted = { status: 'admitted', recipientAddress: 'private-address',
  message: { kind: 'text', version: 1, text: 'private text' }, attempt } as const;
const retryable = { status: 'not_sent', code: 'preconnection_failure', retryable: true } as const;

describe('delivery retry policy', () => {
  test.each([1, 2, 3, 4, 5])('selects bounded equal jitter for attempt %i', (number) => {
    const floor = 500 * 2 ** (number - 1);
    expect(chooseDeliveryScheduling(retryable, number, () => 0)).toEqual({ kind: 'retry', delayMs: floor });
    expect(chooseDeliveryScheduling(retryable, number, () => 0.999)).toEqual({
      kind: 'retry', delayMs: Math.floor(floor + 0.999 * floor),
    });
  });
  test('only proven not_sent within the six-call budget may retry', () => {
    expect(chooseDeliveryScheduling(retryable, 6, () => 0)).toEqual({ kind: 'terminal' });
    expect(chooseDeliveryScheduling({ ...retryable, retryable: false }, 1, () => 0)).toEqual({ kind: 'terminal' });
    expect(chooseDeliveryScheduling({ status: 'not_sent', code: 'rate_limit_unschedulable', retryable: false }, 1,
      () => 0)).toEqual({ kind: 'terminal' });
    expect(chooseDeliveryScheduling({ status: 'uncertain', code: 'server_failure' }, 1, () => 0))
      .toEqual({ kind: 'terminal' });
    expect(chooseDeliveryScheduling({ status: 'sent', externalMessageId: 'id' }, 1, () => 0))
      .toEqual({ kind: 'terminal' });
  });
  test('passes full Retry-After to durable completion rather than clamping it', () => {
    const scheduling = chooseDeliveryScheduling({ ...retryable, retryAfterMs: 3_000_000_000 }, 1, () => 0);
    expect(scheduling).toEqual({ kind: 'retry', delayMs: 500 });
  });
});

describe('one admitted delivery execution', () => {
  test('waits for acknowledged admission, sends once, and completes with the original proof', async () => {
    const order: string[] = [];
    const admission = { admit: vi.fn(async () => { order.push('admit'); return admitted; }) };
    const sender = { send: vi.fn(async () => { order.push('send'); return retryable; }) };
    const completion = { complete: vi.fn(async () => { order.push('complete'); return { status: 'retry' as const,
      availableAt: new Date() }; }) };
    const result = await new DeliveryWorker(admission, sender, completion, () => 0).run(lease);
    expect(order).toEqual(['admit', 'send', 'complete']);
    expect(sender.send).toHaveBeenCalledExactlyOnceWith(admitted.recipientAddress, admitted.message);
    expect(completion.complete).toHaveBeenCalledExactlyOnceWith(lease, attempt, retryable,
      { kind: 'retry', delayMs: 500 });
    expect(result.status).toBe('completed');
  });
  test.each(['in_flight', 'deferred', 'terminal', 'cancelled', 'uncertain', 'exhausted'] as const)
  ('does not send when admission says %s', async (status) => {
    const sender = { send: vi.fn() };
    const completion = { complete: vi.fn() };
    const admission = { admit: vi.fn().mockResolvedValue(status === 'deferred'
      ? { status, availableAt: new Date() } : { status }) };
    expect((await new DeliveryWorker(admission, sender, completion).run(lease)).status).toBe('not_admitted');
    expect(sender.send).not.toHaveBeenCalled();
    expect(completion.complete).not.toHaveBeenCalled();
  });
  test('failed or lost admission ACK makes no sender call', async () => {
    const sender = { send: vi.fn() };
    const completion = { complete: vi.fn() };
    await expect(new DeliveryWorker({ admit: async () => { throw new Error('ACK lost'); } }, sender, completion)
      .run(lease)).rejects.toThrow('ACK lost');
    expect(sender.send).not.toHaveBeenCalled();
    expect(completion.complete).not.toHaveBeenCalled();
  });
  test('unknown sender throw becomes closed uncertain and completion errors never re-send', async () => {
    const sender = { send: vi.fn().mockRejectedValue(new Error('private raw exception')) };
    const completion = { complete: vi.fn().mockRejectedValue(new Error('completion ACK lost')) };
    const worker = new DeliveryWorker({ admit: async () => admitted }, sender, completion);
    await expect(worker.run(lease)).rejects.toThrow('completion ACK lost');
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(completion.complete).toHaveBeenCalledExactlyOnceWith(lease, attempt,
      { status: 'uncertain', code: 'sender_exception' }, { kind: 'terminal' });
  });
});
