import { afterAll, beforeAll, expect, test } from 'vitest';
import { createGateway } from '../../../src/runtime/gateway.js';
import { deliveryFixture } from '../../support/delivery-fixture.js';
let f: Awaited<ReturnType<typeof deliveryFixture>>;
let app: ReturnType<typeof createGateway>;
beforeAll(async () => {
  f = await deliveryFixture();
  app = createGateway({ ...Object.fromEntries(Object.entries(f.pools).map(([r,p]) =>
    [`DATABASE_URL_${r === 'migrator' ? 'MIGRATIONS' : r.toUpperCase()}`, p.options.connectionString])),
    MAX_BOT_TOKEN:'token', MAX_WEBHOOK_SECRET:'secret', MAX_WEBHOOK_URL:'https://example.org/hook',
    OPS_HEALTH_TOKEN:'ops-secret', RESTORE_FENCE:'off' });
},120_000);
afterAll(async () => { await app?.close(); await f?.close(); });
test('live, readiness and protected content-free degradation have distinct meanings',async () => {
  expect((await app.inject('/health/live')).statusCode).toBe(200);
  expect((await app.inject('/health/ready')).statusCode).toBe(200);
  expect((await app.inject('/ops/health')).statusCode).toBe(401);
  const ops = () => app.inject({url:'/ops/health',headers:{authorization:'Bearer ops-secret'}});
  const seed = await f.seed();
  const snapshot = (await ops()).json();
  expect(snapshot).toMatchObject({ready:true, queue:{depth:1}, delivery:{pending:1}, backup:'unknown',subscription:{status:'unknown'},deletion:{pending:0}});
  expect(JSON.stringify(snapshot)).not.toMatch(/private|external|ops-secret|token/);
  expect(JSON.stringify(snapshot)).not.toContain(seed.user_id);
  await f.postgres.pool.query('UPDATE public.system_state SET restore_fence=true');
  expect((await app.inject('/health/live')).statusCode).toBe(200);
  expect((await app.inject('/health/ready')).statusCode).toBe(503);
  await f.postgres.pool.query('UPDATE public.system_state SET restore_fence=false; UPDATE public.schema_migrations SET checksum=repeat(\'0\',64) WHERE name=\'0001_roles_and_extensions.sql\'');
  expect((await app.inject('/health/ready')).statusCode).toBe(503);
  f.pools.gateway.on('error', () => {});
  await f.postgres.pool.query('ALTER ROLE echo_gateway NOLOGIN');
  await f.postgres.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='echo_gateway'");
  expect((await app.inject('/health/live')).statusCode).toBe(200);
  expect((await app.inject('/health/ready')).statusCode).toBe(503);
  // stop() is idempotent for the container; close fixture pools separately after this assertion.
});
