// Technical finalization only; deciding the head outcome belongs to the runner.
export type WorkDisposition =
  | { readonly kind: 'keep' }
  | { readonly kind: 'ready'; readonly availableAt?: Date }
  | { readonly kind: 'defer'; readonly availableAt: Date }
  | { readonly kind: 'sleep' }
  | { readonly kind: 'retry'; readonly availableAt: Date;
      readonly attemptCount: number; readonly lastErrorCode: string };

export class ConversationLeaseLostError extends Error {
  constructor() {
    super('Conversation lease lost');
    this.name = 'ConversationLeaseLostError';
  }
}
