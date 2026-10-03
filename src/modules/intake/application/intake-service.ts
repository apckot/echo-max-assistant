import { validateInboundPayload } from '../domain/inbound-event.js';
import type { IntakeInput, IntakeResult, IntakeStore } from './ports.js';

export class InvalidInboundEventError extends Error {
  constructor() { super('invalid_inbound_event'); this.name = 'InvalidInboundEventError'; }
}

export class IntakeService {
  constructor(private readonly store: IntakeStore) {}

  async accept(input: IntakeInput): Promise<IntakeResult> {
    if (!input.providerEventKey || !Number.isFinite(input.occurredAt.getTime()) ||
      !/^[0-9a-f]{64}$/.test(input.rawSha256) || !validateInboundPayload(input.payload)) {
      throw new InvalidInboundEventError();
    }
    return this.store.persist(input);
  }
}
