import { describe, expect, test } from 'vitest';
import { ZodError } from 'zod';
import { parseRuntimeConfig } from '../../src/shared/config/config.js';

const validEnv = {
  DATABASE_URL_GATEWAY: 'postgres://gateway:password@localhost/echo',
  DATABASE_URL_WORKER: 'postgres://worker:password@localhost/echo',
  DATABASE_URL_DELIVERY: 'postgres://delivery:password@localhost/echo',
  DATABASE_URL_SCHEDULER: 'postgres://scheduler:password@localhost/echo',
  DATABASE_URL_MIGRATIONS: 'postgres://migrations:password@localhost/echo',
  MAX_BOT_TOKEN: 'bot-token',
  MAX_WEBHOOK_SECRET: 'webhook-secret',
  MAX_WEBHOOK_URL: 'https://example.org/max/webhook',
} as const;

async function parse(input: Record<string, unknown>) {
  return parseRuntimeConfig(input);
}

describe('runtime configuration', () => {
  test('applies bounded operational defaults without defaulting secrets', async () => {
    const config = await parse(validEnv);
    expect(config.DATABASE_URL_GATEWAY).toBe(validEnv.DATABASE_URL_GATEWAY);
    expect(config.MAX_BOT_TOKEN).toBe(validEnv.MAX_BOT_TOKEN);
    expect(config.GATEWAY_DB_POOL_SIZE).toBe(10);
    expect(config.WORKER_CONCURRENCY).toBe(10);
    expect(config.DELIVERY_CONCURRENCY).toBe(5);
    expect(config.QUEUE_HARD_LIMIT).toBe(100_000);
    expect(config.WORK_LEASE_MS).toBe(60_000);
    expect(config.WORK_LEASE_RENEW_MS).toBe(20_000);
    expect(config.HANDLER_TIMEOUT_MS).toBe(5_000);
    expect(config.MAX_VOICE_BYTES).toBe(25 * 1024 * 1024);
    expect(config.MAX_VOICE_DURATION_MS).toBe(20 * 60_000);
    expect(config.RESTORE_FENCE).toBe('on');
    expect(config.FOUNDATION_ECHO_ENABLED).toBe(false);
  });

  test.each([
    'DATABASE_URL_GATEWAY', 'DATABASE_URL_WORKER', 'DATABASE_URL_DELIVERY',
    'DATABASE_URL_SCHEDULER', 'DATABASE_URL_MIGRATIONS',
    'MAX_BOT_TOKEN', 'MAX_WEBHOOK_SECRET', 'MAX_WEBHOOK_URL',
  ])('requires %s explicitly', async (key) => {
    const input: Record<string, unknown> = { ...validEnv };
    delete input[key];
    await expect(parse(input)).rejects.toThrow();
  });

  test('rejects malformed URLs and blank secrets', async () => {
    await expect(parse({ ...validEnv, DATABASE_URL_WORKER: 'https://db.example' })).rejects.toThrow();
    await expect(parse({ ...validEnv, MAX_WEBHOOK_URL: 'http://example.org/hook' })).rejects.toThrow();
    await expect(parse({ ...validEnv, MAX_WEBHOOK_SECRET: '   ' })).rejects.toThrow();
  });

  test.each([
    ['DATABASE_URL_WORKER', 'postgres://user:synthetic-password@'],
    ['MAX_WEBHOOK_URL', 'https://user:synthetic-password@'],
  ])('returns a sanitized ZodError for malformed %s', (key, value) => {
    let thrown: unknown;
    try {
      parseRuntimeConfig({ ...validEnv, [key]: value });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ZodError);
    const details = JSON.stringify(thrown);
    expect(details).not.toContain('synthetic-password');
    expect((thrown as Error).message).not.toContain('synthetic-password');
  });

  test('parses explicit numeric settings and rejects invalid ranges', async () => {
    const config = await parse({ ...validEnv, WORKER_CONCURRENCY: '12', QUEUE_HARD_LIMIT: '50000' });
    expect(config.WORKER_CONCURRENCY).toBe(12);
    expect(config.QUEUE_HARD_LIMIT).toBe(50_000);
    await expect(parse({ ...validEnv, WORKER_CONCURRENCY: '0' })).rejects.toThrow();
    await expect(parse({ ...validEnv, DELIVERY_CONCURRENCY: '1.5' })).rejects.toThrow();
    await expect(parse({ ...validEnv, QUEUE_HARD_LIMIT: 'not-a-number' })).rejects.toThrow();
  });

  test('enforces lease, renewal, and handler timing order', async () => {
    await expect(parse({ ...validEnv, WORK_LEASE_RENEW_MS: '60000' })).rejects.toThrow();
    await expect(parse({ ...validEnv, HANDLER_TIMEOUT_MS: '60000' })).rejects.toThrow();
    await expect(parse({ ...validEnv, WORK_LEASE_MS: '10000', WORK_LEASE_RENEW_MS: '9000', HANDLER_TIMEOUT_MS: '9500' })).rejects.toThrow();
  });

  test('requires explicit production opt-in for foundation echo', async () => {
    await expect(parse({ ...validEnv, NODE_ENV: 'production' })).rejects.toThrow();
    const config = await parse({ ...validEnv, NODE_ENV: 'production', FOUNDATION_ECHO_ENABLED: 'true' });
    expect(config.FOUNDATION_ECHO_ENABLED).toBe(true);
    await expect(parse({ ...validEnv, FOUNDATION_ECHO_ENABLED: 'yes' })).rejects.toThrow();
  });

  test('keeps restore fence closed unless explicitly set to off', async () => {
    expect((await parse({ ...validEnv, RESTORE_FENCE: 'off' })).RESTORE_FENCE).toBe('off');
    await expect(parse({ ...validEnv, RESTORE_FENCE: 'false' })).rejects.toThrow();
  });

  test('accepts unrelated process environment variables', async () => {
    expect((await parse({ ...validEnv, PATH: '/usr/bin' })).MAX_BOT_TOKEN).toBe('bot-token');
  });

  test('caps ingress body and future voice limits at the product maximum', async () => {
    await expect(parse({ ...validEnv, WEBHOOK_BODY_LIMIT_BYTES: '1048577' })).rejects.toThrow();
    await expect(parse({ ...validEnv, MAX_VOICE_BYTES: String(25 * 1024 * 1024 + 1) })).rejects.toThrow();
    await expect(parse({ ...validEnv, MAX_VOICE_DURATION_MS: '1200001' })).rejects.toThrow();
  });
});
