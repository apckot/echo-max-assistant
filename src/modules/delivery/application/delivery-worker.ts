import type { AdmissionResult, DeliveryAdmission } from './delivery-admission.js';
import type { DeliveryCompletion, DeliveryCompletionResult, DeliveryOutcome, DeliveryScheduling } from './delivery-completion.js';
import type { DeliveryLease } from './delivery-queue.js';
import type { OutboundSender } from './sender.js';

type NotAdmitted = Exclude<AdmissionResult, { status: 'admitted' }>;
export type DeliveryRunResult =
  | Readonly<{ status: 'not_admitted'; admission: NotAdmitted }>
  | Readonly<{ status: 'completed'; completion: DeliveryCompletionResult }>;

export function chooseDeliveryScheduling(outcome: DeliveryOutcome, attemptNumber: number,
  random: () => number = Math.random): DeliveryScheduling {
  if (outcome.status !== 'not_sent' || outcome.retryable !== true ||
    !Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || attemptNumber >= 6)
    return { kind: 'terminal' };

  // Equal jitter keeps each retry bounded while avoiding synchronized retries.
  // The store applies the full Retry-After minimum and calculates due from DB time.
  let jitter = 0.5;
  try {
    const sample = random();
    if (Number.isFinite(sample) && sample >= 0 && sample < 1) jitter = sample;
  } catch { /* A faulty random seam must not strand an admitted attempt. */ }
  const ceiling = Math.min(60_000, 1_000 * 2 ** (attemptNumber - 1));
  return { kind: 'retry', delayMs: Math.floor(ceiling / 2 + jitter * ceiling / 2) };
}

export class DeliveryWorker {
  constructor(private readonly admission: DeliveryAdmission, private readonly sender: OutboundSender,
    private readonly completion: DeliveryCompletion, private readonly random: () => number = Math.random) {}

  async run(lease: DeliveryLease): Promise<DeliveryRunResult> {
    // Only the acknowledged admission result authorizes this one invocation.
    const admission = await this.admission.admit(lease);
    if (admission.status !== 'admitted') return { status: 'not_admitted', admission };
    let outcome: DeliveryOutcome;
    try {
      outcome = await this.sender.send(admission.recipientAddress, admission.message);
    } catch {
      outcome = { status: 'uncertain', code: 'sender_exception' };
    }
    const scheduling = chooseDeliveryScheduling(outcome, admission.attempt.attemptNumber, this.random);
    // A failed or lost completion acknowledgement never grants another send.
    const result = await this.completion.complete(lease, admission.attempt, outcome, scheduling);
    return { status: 'completed', completion: result };
  }
}
