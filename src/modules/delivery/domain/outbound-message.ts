import { z } from 'zod';

export const OutboundMessageDraftSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('text'),
    text: z.string(),
  }),
]);

export type OutboundMessageDraft = Readonly<z.infer<typeof OutboundMessageDraftSchema>>;
