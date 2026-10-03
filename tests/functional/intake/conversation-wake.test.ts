import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const sql = 'SELECT inbound_event_id, status FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)';
const args = (key: string, chat = '456', user = '123') =>
  [user, chat, key, '2026-10-01T00:00:00.123Z', JSON.stringify({ kind: 'text', text: 'private message' }), 'a'.repeat(64)];

describe('durable conversation wake', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let gateway: Pool;
  let worker: Pool;
  let scheduler: Pool;
  let listener: PoolClient;
  const notifications: string[] = [];
  const barriers = new Map<string, () => void>();
  let barrierSequence = 0;

  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    const url = (role: string) => {
      const value = new URL(postgres.pool.options.connectionString!);
      value.username = `echo_${role}`;
      value.password = 'isolated-test-password';
      return value.toString();
    };
    for (const role of ['migrator', 'gateway', 'worker', 'scheduler']) {
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    }
    migrator = new Pool({ connectionString: url('migrator') });
    gateway = new Pool({ connectionString: url('gateway') });
    worker = new Pool({ connectionString: url('worker') });
    scheduler = new Pool({ connectionString: url('scheduler') });
    await runMigrations(migrator, `${root}migrations`);
    listener = await postgres.pool.connect();
    listener.on('notification', (message) => {
      if (message.channel === 'conversation_work_wake') notifications.push(message.payload ?? '');
      if (message.channel === 'test_wake_barrier') barriers.get(message.payload ?? '')?.();
    });
    await listener.query('LISTEN conversation_work_wake');
    await listener.query('LISTEN test_wake_barrier');
  }, 120_000);
  beforeEach(async () => {
    await postgres.pool.query('TRUNCATE public.users CASCADE');
    notifications.length = 0;
  });
  afterAll(async () => {
    listener?.release();
    await Promise.all([migrator?.end(), gateway?.end(), worker?.end(), scheduler?.end()]);
    await postgres?.stop();
  });

  const accept = async (key: string, chat?: string, user?: string) => (await gateway.query(sql, args(key, chat, user))).rows[0];
  const work = async () => (await postgres.pool.query(`SELECT conversation_id, user_id, state, available_at,
    attempt_count, last_error_code, lease_owner, lease_until, lease_generation
    FROM public.conversation_work ORDER BY conversation_id`)).rows;
  // PostgreSQL delivers notifications in commit order. A received marker proves
  // every earlier committed wake has also reached this listening connection.
  const drainNotifications = async () => {
    const marker = String(++barrierSequence);
    const received = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { barriers.delete(marker); reject(new Error('notification barrier timed out')); }, 5000);
      barriers.set(marker, () => { clearTimeout(timeout); barriers.delete(marker); resolve(); });
    });
    await gateway.query("SELECT pg_notify('test_wake_barrier', $1)", [marker]);
    await received;
  };

  test('concurrent distinct events create one work row and duplicate intake does not notify', async () => {
    const accepted = await Promise.all([accept('message:one'), accept('message:two')]);
    expect(accepted.map((row) => row.status)).toEqual(['created', 'created']);
    const rows = await work();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'ready', attempt_count: 0, last_error_code: null,
      lease_owner: null, lease_until: null, lease_generation: '0' });
    expect(rows[0].available_at).toBeInstanceOf(Date);
    await drainNotifications();
    expect(notifications).toEqual([rows[0].conversation_id, rows[0].conversation_id]);
    const before = rows[0];
    expect((await accept('message:one')).status).toBe('duplicate');
    await drainNotifications();
    expect(await work()).toEqual([before]);
    expect(notifications).toEqual([before.conversation_id, before.conversation_id]);
  });

  test('rollback loses event, counter, work and notification together', async () => {
    const client = await gateway.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql, args('message:rollback'));
      await drainNotifications();
      expect(notifications).toEqual([]);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await drainNotifications();
    expect(notifications).toEqual([]);
    expect(await work()).toEqual([]);
    expect((await postgres.pool.query('SELECT count(*)::int AS events FROM public.inbound_events')).rows[0].events).toBe(0);
    expect((await postgres.pool.query('SELECT count(*)::int AS conversations FROM public.conversations')).rows[0].conversations).toBe(0);
  });

  test('new inbound preserves an existing lease and its generation', async () => {
    await accept('message:one');
    const id = (await work())[0].conversation_id;
    const leaseUntil = new Date('2026-10-01T00:01:00Z');
    await postgres.pool.query(`UPDATE public.conversation_work SET state = 'leased',
      lease_owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', lease_until = $1, lease_generation = 7,
      attempt_count = 2 WHERE conversation_id = $2`, [leaseUntil, id]);
    await accept('message:two');
    const leased = (await work())[0];
    expect(leased).toMatchObject({ conversation_id: id, state: 'leased',
      lease_owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', lease_until: leaseUntil, lease_generation: '7', attempt_count: 2 });
    await drainNotifications();
    const notificationCount = notifications.length;
    expect((await accept('message:two')).status).toBe('duplicate');
    await drainNotifications();
    expect((await work())[0]).toEqual(leased);
    expect(notifications).toHaveLength(notificationCount);
  });

  test('queue contains only technical columns, enforces tenant association and role boundaries', async () => {
    await accept('message:one');
    await accept('message:other', '789', '999');
    const rows = await work();
    expect(rows).toHaveLength(2);
    const columns = (await postgres.pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'conversation_work' ORDER BY ordinal_position`))
      .rows.map((row) => row.column_name);
    expect(columns).toEqual(['conversation_id', 'user_id', 'available_at', 'attempt_count',
      'last_error_code', 'lease_owner', 'lease_until', 'lease_generation', 'state']);
    await expect(gateway.query('SELECT * FROM public.conversation_work')).rejects.toMatchObject({ code: '42501' });
    await expect(gateway.query('UPDATE public.conversation_work SET state = $1', ['dead']))
      .rejects.toMatchObject({ code: '42501' });
    expect((await scheduler.query('SELECT count(*)::int AS count FROM public.conversation_work')).rows[0].count).toBe(2);
    expect((await worker.query('SELECT count(*)::int AS count FROM public.conversation_work')).rows[0].count).toBe(2);
    expect((await worker.query('SELECT * FROM public.inbound_events')).rows).toEqual([]);
    await expect(postgres.pool.query(`UPDATE public.conversation_work SET user_id = $1
      WHERE conversation_id = $2`, [rows[1].user_id, rows[0].conversation_id]))
      .rejects.toMatchObject({ code: '23503' });
  });
});
