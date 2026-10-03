import type { ConversationLease } from './conversation-queue.js';
import type { HandleInboundInput, HandleInboundResult, InboundHandler } from './inbound-handler.js';
import type { OrderedHeadResult } from './ordered-head.js';

export interface AtomicProcessingPort {
  run(lease: ConversationLease, handle: (input: HandleInboundInput) => Promise<HandleInboundResult>):
    Promise<OrderedHeadResult<HandleInboundResult>>;
}
export class HandlerDeadlineError extends Error {
  constructor() { super('Inbound handler deadline exceeded'); this.name = 'HandlerDeadlineError'; }
}
export class PreparationFailedError extends Error {
  constructor() { super('Inbound preparation failed'); this.name = 'PreparationFailedError'; }
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

  run(lease: ConversationLease): Promise<OrderedHeadResult<HandleInboundResult>> {
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
