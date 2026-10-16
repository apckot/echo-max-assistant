import { z } from 'zod';

export const OutboundMessageDraftSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    kind: z.literal('text'),
    text: z.string(),
  }),
  z.strictObject({version:z.literal(1),kind:z.literal('choice'),text:z.string(),buttons:z.array(z.strictObject({label:z.string().min(1).max(128),ref:z.strictObject({choiceId:z.uuid(),revision:z.number().int().positive(),option:z.number().int().min(0).max(5),keyVersion:z.number().int().positive()})})).min(3).max(60)}),
]);

export type OutboundMessageDraft = Readonly<z.infer<typeof OutboundMessageDraftSchema>>;
