import { z } from 'zod';

const invalidKeyCodeUnit = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const validKeyText = (value: string): boolean => !invalidKeyCodeUnit.test(value);
const providerKey = z.string().min(1).refine(validKeyText);

const signedInt64 = z.union([
  z.string().refine((value) => {
    if (value.length > (value.startsWith('-') ? 20 : 19)) return false;
    const match = /^(?:0|[1-9]\d*|-[1-9]\d*)$/.exec(value);
    if (match?.[0] !== value) return false;
    const number = BigInt(value);
    return number >= -(1n << 63n) && number <= (1n << 63n) - 1n;
  }),
  z.number().int().safe().transform(String),
]);

const user = z.object({
  user_id: signedInt64,
  is_bot: z.boolean(),
});

const messageBody = z.object({
  mid: providerKey,
  text: z.string().nullable().optional(),
  attachments: z.array(z.unknown()).nullable().optional(),
});

const message = z.object({
  sender: user.optional(),
  recipient: z.object({ chat_id: signedInt64.nullable(), chat_type: z.string() }),
  body: messageBody.nullable(),
  link: z.object({ type: z.string(), message: z.object({ mid: providerKey }) }).nullable().optional(),
});

const envelope = z.object({ update_type: z.string() });
const timed = { timestamp: signedInt64 };

export const maxUpdateSchemas = {
  envelope,
  bot_started: z.object({ update_type: z.literal('bot_started'), ...timed, chat_id: signedInt64, user }),
  bot_stopped: z.object({ update_type: z.literal('bot_stopped'), ...timed, chat_id: signedInt64, user }),
  message_created: z.object({ update_type: z.literal('message_created'), ...timed, message }),
  message_callback: z.object({
    update_type: z.literal('message_callback'),
    ...timed,
    callback: z.object({ callback_id: providerKey, timestamp: signedInt64, payload: z.string().refine(validKeyText).optional(), user }),
    message: message.nullable(),
  }),
};

export const audioAttachmentSchema = z.object({
  type: z.literal('audio'),
  payload: z.object({ url: z.string().min(1), token: z.string().min(1) }),
});
