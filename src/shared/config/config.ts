import { z } from 'zod';

const postgresUrl = z.url({ protocol: /^(postgres|postgresql)$/ });
const secret = z.string().trim().min(1);
const positiveInteger = (defaultValue: number, maximum: number) =>
  z.coerce.number<number>().int().positive().max(maximum).default(defaultValue);

const runtimeConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL_GATEWAY: postgresUrl,
  DATABASE_URL_WORKER: postgresUrl,
  DATABASE_URL_DELIVERY: postgresUrl,
  DATABASE_URL_SCHEDULER: postgresUrl,
  DATABASE_URL_MIGRATIONS: postgresUrl,
  MAX_BOT_TOKEN: secret,
  MAX_WEBHOOK_SECRET: secret,
  MAX_WEBHOOK_URL: z.url({ protocol: /^https$/ }),
  RESTORE_FENCE: z.enum(['on', 'off']).default('on'),
  FOUNDATION_ECHO_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  GATEWAY_DB_POOL_SIZE: positiveInteger(10, 100),
  WORKER_CONCURRENCY: positiveInteger(10, 100),
  DELIVERY_CONCURRENCY: positiveInteger(5, 100),
  QUEUE_HARD_LIMIT: positiveInteger(100_000, 1_000_000),
  WEBHOOK_BODY_LIMIT_BYTES: positiveInteger(1024 * 1024, 1024 * 1024),
  WORK_LEASE_MS: positiveInteger(60_000, 300_000),
  WORK_LEASE_RENEW_MS: positiveInteger(20_000, 300_000),
  HANDLER_TIMEOUT_MS: positiveInteger(5_000, 5_000),
  MAX_VOICE_BYTES: positiveInteger(25 * 1024 * 1024, 25 * 1024 * 1024),
  MAX_VOICE_DURATION_MS: positiveInteger(20 * 60_000, 20 * 60_000),
}).superRefine((config, context) => {
  if (config.WORK_LEASE_RENEW_MS >= config.WORK_LEASE_MS) {
    context.addIssue({ code: 'custom', path: ['WORK_LEASE_RENEW_MS'], message: 'Renewal must precede lease expiry' });
  }
  if (config.HANDLER_TIMEOUT_MS >= config.WORK_LEASE_MS || config.HANDLER_TIMEOUT_MS >= config.WORK_LEASE_RENEW_MS) {
    context.addIssue({ code: 'custom', path: ['HANDLER_TIMEOUT_MS'], message: 'Handler must finish before lease renewal' });
  }
  if (config.NODE_ENV === 'production' && !config.FOUNDATION_ECHO_ENABLED) {
    context.addIssue({ code: 'custom', path: ['FOUNDATION_ECHO_ENABLED'], message: 'Foundation echo requires explicit production opt-in' });
  }
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function parseRuntimeConfig(input: Record<string, unknown>): RuntimeConfig {
  return runtimeConfigSchema.parse(input);
}
