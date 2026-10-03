import type { InboundEvent } from '../domain/inbound-event.js';

export type ActionableHead = {
  readonly kind: 'ready' | 'preparation_failed';
  readonly event: InboundEvent;
};

export type OrderedHeadResult<T> =
  | { readonly kind: 'preparing' | 'drained' | 'advanced' }
  | { readonly kind: 'actionable'; readonly value: T };

export class MissingAllocatedHeadError extends Error {
  constructor() {
    super('Allocated inbound head missing');
    this.name = 'MissingAllocatedHeadError';
  }
}
