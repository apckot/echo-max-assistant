import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createGateway } from '../../../src/runtime/gateway.js';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { parseRuntimeConfig, type RuntimeConfig } from '../../../src/shared/config/config.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const secret = 'private-webhook-secret';
const text = (mid = 'private-mid', user = 123456789) => JSON.stringify({ update_type: 'message_created', timestamp: 1,
  message: { sender: { user_id: user, is_bot: false }, recipient: { chat_id: user, chat_type: 'dialog' },
    body: { mid, text: 'private-message-text' } } });
const callback = JSON.stringify({ update_type: 'message_callback', timestamp: 1,
  callback: { callback_id: 'private-callback-id', timestamp: 2, payload: 'private-callback-payload', user: { user_id: 123456789, is_bot: false } },
  message: { recipient: { chat_id: 123456789, chat_type: 'dialog' }, body: { mid: 'private-mid' } } });
const lifecycle = (update_type: string, timestamp: number) => JSON.stringify({ update_type, timestamp,
  user: { user_id: 123456789, is_bot: false }, chat_id: 123456789 });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('guarded durable HTTP ingress', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let config: RuntimeConfig;
  let lines: string[];
  const apps: ReturnType<typeof createGateway>[] = [];
  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    const url = (role: string) => {
      const value = new URL(postgres.pool.options.connectionString!);
      value.username = `echo_${role}`; value.password = 'isolated-test-password'; return value.toString();
    };
    for (const role of ['migrator', 'gateway']) await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    migrator = new Pool({ connectionString: url('migrator') });
    await runMigrations(migrator, `${root}migrations`);
    config = parseRuntimeConfig({ DATABASE_URL_GATEWAY: url('gateway'), DATABASE_URL_MIGRATIONS: url('migrator'),
      DATABASE_URL_WORKER: url('worker'), DATABASE_URL_DELIVERY: url('delivery'), DATABASE_URL_SCHEDULER: url('scheduler'),
      MAX_BOT_TOKEN: 'private-bot-token', MAX_WEBHOOK_SECRET: secret, MAX_WEBHOOK_URL: 'https://example.test/webhooks/max',
      RESTORE_FENCE: 'off', GATEWAY_DB_POOL_SIZE: 1 });
  }, 120_000);
  beforeEach(async () => {
    lines = [];
    await postgres.pool.query('TRUNCATE public.users CASCADE; UPDATE public.system_state SET restore_fence = false');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((app) => app.close()));
    const output = lines.join('');
    for (const value of [secret, 'private-bot-token', 'private-message-text', 'private-mid', 'private-callback-id',
      'private-callback-payload', '123456789', 'isolated-test-password', 'postgresql:']) expect(output).not.toContain(value);
  });
  afterAll(async () => { await migrator?.end(); await postgres?.stop(); });
  function gateway(overrides: Partial<RuntimeConfig> = {}) {
    const settings = { ...config, ...overrides };
    const app = createGateway({ ...settings, FOUNDATION_ECHO_ENABLED: String(settings.FOUNDATION_ECHO_ENABLED) },
      pino({}, new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done(); } })));
    apps.push(app); return app;
  }
  const post = (app: ReturnType<typeof gateway>, payload = text(), auth = secret) => app.inject({
    method: 'POST', url: '/webhooks/max', headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': auth }, payload,
  });
  const snapshot = async () => (await postgres.pool.query(`SELECT
    (SELECT count(*)::int FROM public.users) AS users,
    (SELECT count(*)::int FROM public.inbound_events) AS events,
    (SELECT count(*)::int FROM public.conversation_work) AS work,
    (SELECT max(next_inbound_sequence)::text FROM public.conversations) AS next`)).rows[0];
  const empty = { users: 0, events: 0, work: 0, next: null };

  test.each([text(), callback])('commits event/work once across repeat and gateway restart: %s', async (body) => {
    const first = gateway();
    expect((await post(first, body)).statusCode).toBe(200);
    const rows = (await postgres.pool.query('SELECT id, raw_sha256 FROM public.inbound_events')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].raw_sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect((await post(first, body)).statusCode).toBe(200);
    await first.close();
    expect((await post(gateway(), body)).statusCode).toBe(200);
    expect((await postgres.pool.query('SELECT id, raw_sha256 FROM public.inbound_events')).rows).toEqual(rows);
    expect(await snapshot()).toEqual({ users: 1, events: 1, work: 1, next: '2' });
  });
  test('replayed lifecycle start preserves the later stopped state', async () => {
    const app = gateway();
    for (const body of [lifecycle('bot_started', 1), lifecycle('bot_stopped', 2), lifecycle('bot_started', 1)]) {
      expect((await post(app, body)).statusCode).toBe(200);
    }
    expect((await postgres.pool.query('SELECT state FROM public.conversations')).rows).toEqual([{ state: 'stopped' }]);
    expect(await snapshot()).toEqual({ users: 1, events: 2, work: 1, next: '3' });
  });
  test('invalid secret, JSON and configured body limit have zero effects', async () => {
    const app = gateway({ WEBHOOK_BODY_LIMIT_BYTES: 256 });
    expect((await post(app, text(), 'wrong')).statusCode).toBe(401);
    for (const body of ['{broken', JSON.stringify({ update_type: 'message_edited', padding: 'x'.repeat(256) })]) expect((await post(app, body)).statusCode).toBe(400);
    expect(await snapshot()).toEqual(empty);
  });
  test.each(['-8640000000000000', '9223372036854775807', '9007199254740991', 'nul', 'surrogate'])('permanent input %s returns closed 400 with zero effects', async (value) => {
    const body = value === 'nul' || value === 'surrogate'
      ? text().replace('private-message-text', value === 'nul' ? '\\u0000' : '\\ud800') : text().replace('"timestamp":1', `"timestamp":${value}`);
    const response = await post(gateway(), body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'invalid_body' });
    expect(await snapshot()).toEqual(empty);
  });
  test.each(['message mid', 'reply mid', 'callback id', 'callback original mid', 'callback payload'] as const)(
    'rejects malformed %s without effects or aliasing a valid Unicode key', async (field) => {
      const makeBody = (key: string, suffix = '') => {
        const value = JSON.parse(field.startsWith('callback') ? callback : text()) as {
          message: { body: { mid: string }; link?: { type: string; message: { mid: string } } };
          callback?: { callback_id: string; payload: string };
        };
        if (field === 'message mid') value.message.body.mid = key;
        if (field === 'reply mid') {
          value.message.body.mid = `reply-${suffix}`;
          value.message.link = { type: 'reply', message: { mid: key } };
        }
        if (field === 'callback id') value.callback!.callback_id = key;
        if (field === 'callback original mid') value.message.body.mid = key;
        if (field === 'callback payload') value.callback!.payload = key;
        return JSON.stringify(value);
      };
      const app = gateway();
      for (const invalid of ['key\u0000', 'key\ud800', 'key\udc00']) {
        const response = await post(app, makeBody(invalid));
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ code: 'invalid_body' });
        expect(await snapshot()).toEqual(empty);
      }
      for (const [key, suffix] of [['key\ufffd', 'replacement'], ['key\ud83d\ude80', 'astral']] as const) {
        expect((await post(app, makeBody(key, suffix))).statusCode).toBe(200);
      }
      expect(await snapshot()).toEqual({ users: 1, events: 2, work: 1, next: '3' });
      expect((await postgres.pool.query('SELECT provider_event_key FROM public.inbound_events')).rows)
        .toHaveLength(2);
    },
  );
  test('config fence and database fence refuse before identity/event/work writes', async () => {
    expect((await post(gateway({ RESTORE_FENCE: 'on' }))).statusCode).toBe(503);
    await postgres.pool.query('UPDATE public.system_state SET restore_fence = true');
    expect((await post(gateway())).statusCode).toBe(503);
    expect(await snapshot()).toEqual(empty);
  });
  test('missing fence singleton fails closed', async () => {
    await postgres.pool.query('DELETE FROM public.system_state');
    try {
      expect((await post(gateway())).statusCode).toBe(503);
      expect(await snapshot()).toEqual(empty);
    } finally { await postgres.pool.query('INSERT INTO public.system_state (id, schema_version) VALUES (1, 14)'); }
  });
  test('concurrent new events cannot cross hard limit, while durable duplicate stays successful', async () => {
    const app = gateway({ QUEUE_HARD_LIMIT: 1, GATEWAY_DB_POOL_SIZE: 2 });
    const bodies = [text('one', 111), text('two', 222)];
    const responses = await Promise.all(bodies.map((body) => post(app, body)));
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 503]);
    const accepted = bodies[responses.findIndex((r) => r.statusCode === 200)]!;
    expect((await post(app, accepted)).statusCode).toBe(200);
    expect(await snapshot()).toEqual({ users: 1, events: 1, work: 1, next: '2' });
  });
  test.each([['failed', 2, 200], ['ignored', 1, 503]] as const)('capacity follows apply pointer for %s events', async (status, next, code) => {
    const app = gateway({ QUEUE_HARD_LIMIT: 1 });
    expect((await post(app)).statusCode).toBe(200);
    await postgres.pool.query('UPDATE public.inbound_events SET processing_status = $1', [status]);
    await postgres.pool.query('UPDATE public.conversations SET next_apply_sequence = $1', [next]);
    expect((await post(app, text('next'))).statusCode).toBe(code);
    expect((await snapshot()).events).toBe(code === 200 ? 2 : 1);
  });
  test('idle database disconnect is contained and the next request reconnects', async () => {
    const app = gateway();
    expect((await post(app)).statusCode).toBe(200);
    await postgres.pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'echo_gateway'");
    await pause(50);
    expect((await post(app)).statusCode).toBe(200);
    expect(await snapshot()).toEqual({ users: 1, events: 1, work: 1, next: '2' });
  });
  test('database connection failure returns a closed retryable response', async () => {
    const broken = new URL(config.DATABASE_URL_GATEWAY); broken.port = '1';
    const response = await post(gateway({ DATABASE_URL_GATEWAY: broken.toString() }));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: 'temporarily_unavailable' });
    expect(await snapshot()).toEqual(empty);
  });
  test('deadline returns 503 without late effects, then the pool accepts retry', async () => {
    const blocker = await postgres.pool.connect();
    await blocker.query('BEGIN; LOCK TABLE public.inbound_events IN ACCESS EXCLUSIVE MODE');
    const app = gateway();
    try { expect((await post(app)).statusCode).toBe(503); }
    finally { await blocker.query('ROLLBACK'); blocker.release(); }
    await pause(200);
    expect(await snapshot()).toEqual(empty);
    expect((await post(app)).statusCode).toBe(200);
  });
  test('lost HTTP response after commit is safe to retry', async () => {
    const app = gateway();
    let loseResponse = true;
    app.addHook('onSend', async (_request, reply, payload) => {
      if (loseResponse) { loseResponse = false; reply.hijack(); reply.raw.destroy(); }
      return payload;
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await expect(fetch(`${address}/webhooks/max`, { method: 'POST', body: text(),
      headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': secret }, signal: AbortSignal.timeout(1000),
    })).rejects.toThrow();
    expect(await snapshot()).toEqual({ users: 1, events: 1, work: 1, next: '2' });
    expect((await post(app)).statusCode).toBe(200);
    expect(await snapshot()).toEqual({ users: 1, events: 1, work: 1, next: '2' });
  });
  test('close is bounded even with an unfinished HTTP request body', async () => {
    const app = gateway();
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const socket = createConnection({ host: address.hostname, port: Number(address.port) });
    await once(socket, 'connect');
    socket.write(`POST /webhooks/max HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nX-Max-Bot-Api-Secret: ${secret}\r\nContent-Length: 100\r\n\r\n{`);
    await pause(20);
    try { expect(await Promise.race([app.close().then(() => true), pause(500).then(() => false)])).toBe(true); }
    finally { socket.destroy(); }
    expect(await snapshot()).toEqual(empty);
  });
  test('fence transition holds ingress until it resolves, without intermediate writes', async () => {
    const blocker = await postgres.pool.connect();
    await blocker.query('BEGIN; UPDATE public.system_state SET restore_fence = true');
    try { expect((await post(gateway())).statusCode).toBe(503); }
    finally { await blocker.query('COMMIT'); blocker.release(); }
    expect(await snapshot()).toEqual(empty);
    expect((await post(gateway())).statusCode).toBe(503);
  });
  test('guard grants expose neither unrestricted reads nor the unguarded intake', async () => {
    const pool = new Pool({ connectionString: config.DATABASE_URL_GATEWAY });
    try {
      for (const table of ['system_state', 'users', 'inbound_events']) {
        await expect(pool.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: '42501' });
      }
      await expect(pool.query("SELECT * FROM public.accept_max_inbound_internal('1','1','x',now(),'{\"kind\":\"text\",\"text\":\"x\"}',repeat('a',64))"))
        .rejects.toMatchObject({ code: '42501' });
      expect((await postgres.pool.query(`SELECT has_function_privilege('echo_worker',
        'public.accept_max_inbound(text,text,text,timestamptz,jsonb,text,integer)', 'EXECUTE') AS allowed`)).rows)
        .toEqual([{ allowed: false }]);
    } finally { await pool.end(); }
  });
  test('lost COMMIT acknowledgement returns 503 then retry uses the durable row', async () => {
    const connect = Pool.prototype.connect;
    let delayCommit = true;
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (this: Pool, ...args: Parameters<typeof connect>) {
      if (args.length) return connect.apply(this, args);
      return connect.call(this).then((client) => {
        if (new URL(this.options.connectionString!).username === 'echo_gateway') {
          const query = client.query.bind(client);
          client.query = (async (...args: Parameters<typeof client.query>) => {
            const result = await query(...args);
            if (args[0] === 'COMMIT' && delayCommit) { delayCommit = false; await pause(220); }
            return result;
          }) as typeof client.query;
        }
        return client;
      });
    });
    const app = gateway();
    expect((await post(app)).statusCode).toBe(503);
    const rows = (await postgres.pool.query('SELECT id FROM public.inbound_events')).rows;
    expect(rows).toHaveLength(1);
    expect((await post(app)).statusCode).toBe(200);
    expect((await postgres.pool.query('SELECT id FROM public.inbound_events')).rows).toEqual(rows);
    expect(await snapshot()).toEqual({ users: 1, events: 1, work: 1, next: '2' });
    await pause(100);
  });
});
