import { createServer, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { createDelivery } from '../../../src/runtime/delivery.js';
import { deliveryFixture } from '../../support/delivery-fixture.js';

let f: Awaited<ReturnType<typeof deliveryFixture>>;
let environment: Record<string, unknown>;
let baseUrl: string;
const responses: ServerResponse[] = [];
const server = createServer((_request, response) => { responses.push(response); });
const runtimes: ReturnType<typeof createDelivery>[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  const deadline = performance.now() + 3000;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Delivery condition timed out');
    await pause(10);
  }
}
const rows = async (table: string) => (await f.postgres.pool.query(`SELECT * FROM public.${table}
  ${table === 'delivery_attempts' ? 'ORDER BY attempt_number, phase DESC' : ''}`)).rows;
const start = (extra: Record<string, unknown> = {}) => {
  const runtime = createDelivery({ ...environment, ...extra }, { baseUrl, timeoutMs: 1000 });
  runtimes.push(runtime);
  return runtime;
};
const reply = () => responses[0]!.end(JSON.stringify({ message: { body: { mid: 'confirmed' } } }));
beforeAll(async () => {
  f = await deliveryFixture();
  environment = {
    ...Object.fromEntries(Object.entries(f.pools).map(([role, pool]) =>
      [`DATABASE_URL_${role === 'migrator' ? 'MIGRATIONS' : role.toUpperCase()}`, pool.options.connectionString])),
    MAX_BOT_TOKEN: 'test-token', MAX_WEBHOOK_SECRET: 'test-secret', MAX_WEBHOOK_URL: 'https://example.org/hook',
    RESTORE_FENCE: 'off', DELIVERY_CONCURRENCY: 1,
    WORK_LEASE_MS: 2400, WORK_LEASE_RENEW_MS: 600, HANDLER_TIMEOUT_MS: 20,
  };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);
beforeEach(async () => {
  responses.length = 0;
  await f.postgres.pool.query('TRUNCATE public.users CASCADE; UPDATE public.system_state SET restore_fence=false');
});
afterEach(async () => {
  for (const response of responses) response.destroy();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await f?.close();
});

test('environment and enabled or missing database fence prevent claims; reopening resumes polling', async () => {
  await f.seed();
  const disabled = start({ RESTORE_FENCE: 'on' });
  await pause(150);
  await disabled.stop();
  expect((await rows('delivery_work'))[0].lease_generation).toBe('0');
  await f.postgres.pool.query('UPDATE public.system_state SET restore_fence=true');
  const runtime = start();
  await pause(150);
  expect((await rows('delivery_work'))[0].lease_generation).toBe('0');
  const [state] = (await f.postgres.pool.query('DELETE FROM public.system_state RETURNING *')).rows;
  try {
    await pause(150);
    expect((await rows('delivery_work'))[0].lease_generation).toBe('0');
    expect(responses).toHaveLength(0);
  } finally {
    await f.postgres.pool.query('INSERT INTO public.system_state(id,schema_version,restore_fence) VALUES(1,$1,false)',
      [state.schema_version]);
  }
  await until(async () => responses.length === 1);
  reply();
  await until(async () => (await rows('delivery_work'))[0].state === 'sent');
  await runtime.stop();
  expect(await rows('delivery_attempts')).toMatchObject([
    { phase: 'started', attempt_number: 1 }, { phase: 'completed', certainty: 'sent' },
  ]);
});

test.each([false, true])('stop drains admitted send and renewal; completion fence=%s', async (fenced) => {
  await f.seed();
  const runtime = start();
  await until(async () => responses.length === 1);
  const initialExpiry = (await rows('delivery_work'))[0].lease_until.getTime();
  let closed = false;
  const stopped = runtime.stop().then(() => { closed = true; });
  await until(async () => (await rows('delivery_work'))[0].lease_until.getTime() > initialExpiry + 100);
  expect(closed).toBe(false);
  if (fenced) await f.postgres.pool.query('UPDATE public.system_state SET restore_fence=true');
  reply();
  await stopped;
  expect(responses).toHaveLength(1);
  expect((await f.postgres.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='echo_delivery'"))
    .rows[0].n).toBe(0);
  if (fenced) {
    expect(await rows('delivery_attempts')).toMatchObject([{ phase: 'started' }]);
    expect((await rows('outbound_messages'))[0].status).toBe('sending');
    await f.postgres.pool.query(`UPDATE public.system_state SET restore_fence=false;
      UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 second'`);
    const recovered = start();
    await until(async () => (await rows('delivery_work'))[0].state === 'uncertain');
    await recovered.stop();
  }
  expect(await rows('delivery_attempts')).toMatchObject([
    { phase: 'started', attempt_number: 1 },
    { phase: 'completed', attempt_number: 1, certainty: fenced ? 'uncertain' : 'sent' },
  ]);
  expect((await rows('delivery_work'))[0].state).toBe(fenced ? 'uncertain' : 'sent');
  expect(responses).toHaveLength(1);
});

test('stop bounds a blocked admission by the configured transaction budget', async () => {
  const outbound = await f.seed();
  const lock = await f.postgres.pool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM public.outbound_messages WHERE id=$1 FOR UPDATE', [outbound.id]);
    const runtime = start();
    await until(async () => (await f.postgres.pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE usename='echo_delivery' AND wait_event_type='Lock'`)).rowCount! > 0);
    const began = performance.now();
    await runtime.stop();
    expect(performance.now() - began).toBeLessThan(700);
    expect(responses).toHaveLength(0);
    expect(await rows('delivery_attempts')).toEqual([]);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
});
