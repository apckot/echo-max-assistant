import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { createWorker } from '../../../src/runtime/worker.js';
import { FoundationInboundHandler } from '../../../src/modules/intake/application/inbound-handler.js';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let postgres: Awaited<ReturnType<typeof startPostgres>>;
let migrator: Pool; let gateway: Pool; let worker: Pool;
let environment: Record<string, unknown>;
const runtimes: ReturnType<typeof createWorker>[] = [];
const start = (extra: Record<string, unknown> = {}) => {
  const runtime = createWorker({ ...environment, ...extra }); runtimes.push(runtime); return runtime;
};
beforeAll(async () => {
  postgres = await startPostgres();
  await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
  const url = (role: string) => { const value = new URL(postgres.pool.options.connectionString!);
    value.username = `echo_${role}`; value.password = 'isolated-test-password'; return value.toString(); };
  for (const role of ['migrator', 'gateway', 'worker', 'delivery', 'scheduler'])
    await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
  migrator = new Pool({ connectionString: url('migrator') });
  gateway = new Pool({ connectionString: url('gateway') }); worker = new Pool({ connectionString: url('worker') });
  await runMigrations(migrator, `${root}migrations`);
  environment = { DATABASE_URL_GATEWAY: url('gateway'), DATABASE_URL_WORKER: url('worker'),
    DATABASE_URL_DELIVERY: url('delivery'), DATABASE_URL_SCHEDULER: url('scheduler'), DATABASE_URL_MIGRATIONS: url('migrator'),
    MAX_BOT_TOKEN: 'test-token', MAX_WEBHOOK_SECRET: 'test-secret', MAX_WEBHOOK_URL: 'https://example.org/hook',
    RESTORE_FENCE: 'off', WORKER_CONCURRENCY: 1, HANDLER_TIMEOUT_MS: 20, WORK_LEASE_RENEW_MS: 300, WORK_LEASE_MS: 1200 };
}, 120_000);
beforeEach(async () => {
  await postgres.pool.query('TRUNCATE public.users CASCADE; UPDATE public.system_state SET restore_fence = false');
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop())); vi.restoreAllMocks();
  await postgres.pool.query('DROP TRIGGER IF EXISTS slow_receipt ON public.processing_receipts');
});
afterAll(async () => { await Promise.all([migrator?.end(), gateway?.end(), worker?.end()]); await postgres?.stop(); });
const add = async (sequence: number, chat = '3000') => gateway.query(
  'SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)', [chat, chat, `message:${chat}:${sequence}`,
    '2026-10-01T00:00:00Z', JSON.stringify({ kind: 'text', text: 'private' }), 'a'.repeat(64)]);
const receipts = async () => (await postgres.pool.query(`SELECT r.id, r.inbound_event_id, r.result, e.sequence
  FROM public.processing_receipts r JOIN public.inbound_events e ON e.id = r.inbound_event_id ORDER BY e.sequence`)).rows;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => Promise<boolean>) => {
  const deadline = performance.now() + 2500;
  while (!(await check())) { if (performance.now() >= deadline) throw new Error('Worker condition timed out'); await pause(10); }
};

test('runtime honors config fence and production opt-in; database guard is worker-only and fails closed', async () => {
  await add(1);
  expect(() => start({ NODE_ENV: 'production' })).toThrow();
  const fenced = start({ RESTORE_FENCE: 'on' }); await pause(150); await fenced.stop(); expect(await receipts()).toEqual([]);
  await expect(worker.query('SELECT * FROM public.system_state')).rejects.toMatchObject({ code: '42501' });
  await expect(gateway.query('SELECT public.guard_worker_restore_fence()')).rejects.toMatchObject({ code: '42501' });
  await migrator.query('UPDATE public.system_state SET restore_fence = true');
  await expect(worker.query('SELECT public.guard_worker_restore_fence()')).rejects.toMatchObject({ code: 'P0001' });
  const running = start({ NODE_ENV: 'production', FOUNDATION_ECHO_ENABLED: 'true' });
  await pause(150); expect(await receipts()).toEqual([]);
  expect((await postgres.pool.query('SELECT lease_generation FROM public.conversation_work')).rows[0].lease_generation).toBe('0');
  await migrator.query('UPDATE public.system_state SET restore_fence = false');
  await until(async () => (await receipts()).length === 1); await running.stop();
  const state = (await migrator.query('DELETE FROM public.system_state RETURNING *')).rows[0]!;
  await expect(worker.query('SELECT public.guard_worker_restore_fence()')).rejects.toMatchObject({ code: 'P0001' });
  await migrator.query('INSERT INTO public.system_state (id,schema_version) VALUES (1,$1)', [state.schema_version]);
});

test('guard holds fence activation until an admitted transaction finishes', async () => {
  const client = await worker.connect(); let activated = false;
  try {
    await client.query('BEGIN'); await client.query('SELECT public.guard_worker_restore_fence()');
    const activation = migrator.query('UPDATE public.system_state SET restore_fence = true').then(() => { activated = true; });
    await pause(30); expect(activated).toBe(false);
    await client.query('COMMIT'); await activation; expect(activated).toBe(true);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('configured lower handler deadline records one retry and stop closes its worker pool', async () => {
  await add(1); const late = vi.spyOn(FoundationInboundHandler.prototype, 'handle').mockImplementation(() => new Promise(() => {}));
  const runtime = start({ HANDLER_TIMEOUT_MS: 10 });
  await until(async () => (await postgres.pool.query('SELECT attempt_count FROM public.inbound_events')).rows[0].attempt_count === 1);
  await runtime.stop(); expect(late).toHaveBeenCalledTimes(1); expect(await receipts()).toEqual([]);
  expect((await postgres.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='echo_worker' AND state='idle in transaction'")).rows[0].n).toBe(0);
});

test('same database restart preserves committed ordered drafts and reclaims precommit abandonment without duplicates', async () => {
  await add(1); const first = start(); await until(async () => (await receipts()).length === 1); await first.stop();
  const committed = await receipts();
  expect(committed[0].result).toEqual({ receiptType: 'foundation_echo', receiptVersion: 1,
    messages: [{ version: 1, kind: 'text', text: 'Получено сообщение №1.' }] });
  await postgres.pool.query(`CREATE OR REPLACE FUNCTION public.delay_receipt() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$;
    CREATE TRIGGER slow_receipt BEFORE INSERT ON public.processing_receipts FOR EACH ROW EXECUTE FUNCTION public.delay_receipt()`);
  await add(2); const abandoned = start();
  await until(async () => (await postgres.pool.query(`SELECT 1 FROM pg_stat_activity
    WHERE usename='echo_worker' AND wait_event='PgSleep'`)).rowCount! > 0);
  const began = performance.now(); await abandoned.stop(); expect(performance.now() - began).toBeLessThan(1500);
  expect(await receipts()).toEqual(committed);
  const abandonedWork = (await postgres.pool.query('SELECT state, lease_generation FROM public.conversation_work')).rows[0]!;
  expect(abandonedWork.state).toBe('leased');
  expect((await postgres.pool.query('SELECT attempt_count FROM public.inbound_events ORDER BY sequence')).rows).toEqual([{ attempt_count: 0 }, { attempt_count: 0 }]);
  await postgres.pool.query('DROP TRIGGER slow_receipt ON public.processing_receipts');
  const restarted = start(); await until(async () => (await receipts()).length === 2);
  await until(async () => (await postgres.pool.query('SELECT available_at::text FROM public.conversation_work')).rows[0].available_at === 'infinity');
  await restarted.stop(); const saved = await receipts();
  expect(saved[0]).toEqual(committed[0]); expect(saved.map((row) => row.sequence)).toEqual(['1', '2']);
  expect(saved[1].result).toEqual({ receiptType: 'foundation_echo', receiptVersion: 1,
    messages: [{ version: 1, kind: 'text', text: 'Получено сообщение №2.' }] });
  expect(new Set(saved.map((row) => row.inbound_event_id)).size).toBe(2);
  expect((await postgres.pool.query('SELECT next_apply_sequence FROM public.conversations')).rows[0].next_apply_sequence).toBe('3');
  const replay = start(); await pause(200); await replay.stop(); expect(await receipts()).toEqual(saved);
  await until(async () => (await postgres.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='echo_worker' AND pid <> ALL($1::int[])",
    [(await worker.query('SELECT pg_backend_pid() pid')).rows.map((row) => row.pid)])).rows[0].n === 0);
});
