import type { ConversationLease } from './conversation-queue.js';
import type { HandleInboundInput, HandleInboundResult, InboundHandler } from './inbound-handler.js';
import type { OrderedHeadResult } from './ordered-head.js';

export type RetryScheduled = { readonly kind: 'retry'; readonly attemptCount: number; readonly availableAt: Date };
export type ProcessingRunResult = OrderedHeadResult<HandleInboundResult> | RetryScheduled;

export interface AtomicProcessingPort {
  run(lease: ConversationLease, handle: (input: HandleInboundInput) => Promise<HandleInboundResult>):
    Promise<ProcessingRunResult>;
}
export class HandlerDeadlineError extends Error {
  constructor() { super('Inbound handler deadline exceeded'); this.name = 'HandlerDeadlineError'; }
}
export class StaleProcessingHeadError extends Error {
  constructor() { super('Processing head changed'); this.name = 'StaleProcessingHeadError'; }
}
export class ReceiptMismatchError extends Error {
  constructor() { super('Processing receipt mismatch'); this.name = 'ReceiptMismatchError'; }
}

export class ProcessInbound {
  constructor(private readonly atomic: AtomicProcessingPort, private readonly handler: InboundHandler,
    private readonly handlerTimeoutMs = 5000) {
    if (!Number.isInteger(handlerTimeoutMs) || handlerTimeoutMs < 1 || handlerTimeoutMs > 5000)
      throw new RangeError('Handler timeout must be an integer between 1 and 5000 milliseconds');
  }

  run(lease: ConversationLease): Promise<ProcessingRunResult> {
    return this.atomic.run(lease, async (input) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = performance.now() + this.handlerTimeoutMs;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new HandlerDeadlineError()), this.handlerTimeoutMs);
        });
        // Only the pure handler is raced: the transactional continuation cannot
        // resume after timeout. Promise.race also observes late rejections.
        const result = await Promise.race([Promise.resolve().then(() => this.handler.handle(input)), timeout]);
        if (performance.now() >= deadline) throw new HandlerDeadlineError();
        return result;
      } finally { clearTimeout(timer); }
    });
  }
}

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  return Math.min(300_000, 1000 * 2 ** Math.min(attempt - 1, 20) * (1 + random()));
}
