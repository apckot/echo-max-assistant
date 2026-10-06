import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { createGateway } from '../../../src/runtime/gateway.js';
import { createWorker } from '../../../src/runtime/worker.js';
import { createDelivery } from '../../../src/runtime/delivery.js';
import { deliveryFixture } from '../../support/delivery-fixture.js';

let f: Awaited<ReturnType<typeof deliveryFixture>>;
let environment: Record<string, unknown>;
let baseUrl: string;
type Call = { url: URL; headers: IncomingHttpHeaders; text: string; response: ServerResponse };
const calls: Call[] = [];
let hold = false;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text: string };
  const call = { url: new URL(request.url!, baseUrl), headers: request.headers, text: body.text, response };
  calls.push(call); // Barrier proves the remote endpoint consumed the entire body.
  if (!hold) confirm(call);
});
const confirm = (call: Call) => call.response.end(JSON.stringify({ message: { body: { mid: 'confirmed' } } }));
const gateways: ReturnType<typeof createGateway>[] = [];
const workers: ReturnType<typeof createWorker>[] = [];
const deliveries: ReturnType<typeof createDelivery>[] = [];
const gateway = () => {
  const app = createGateway(environment, pino({ level: 'silent' })); gateways.push(app); return app;
};
const worker = () => { const value = createWorker(environment); workers.push(value); return value; };
const delivery = (timeoutMs = 500, extra: Record<string, unknown> = {}) => {
  const value = createDelivery({ ...environment, ...extra }, { baseUrl, timeoutMs });
  deliveries.push(value); return value;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Checkpoint condition timed out');
    await pause(20);
  }
}
const rows = async (table: string) => {
  const order = table === 'delivery_attempts' ? 'recorded_at, phase DESC' :
    table === 'delivery_work' ? 'outbound_message_id' : table === 'conversation_work' ? 'conversation_id' : 'id';
  return (await f.postgres.pool.query(`SELECT * FROM public.${table} ORDER BY ${order}`)).rows;
};
const sent = async (count: number) => until(async () =>
  (await rows('delivery_work')).filter((row) => row.state === 'sent').length === count);
const processed = async (count: number) => until(async () => (await rows('processing_receipts')).length === count);
const user = (id: string) => ({ user_id: id, is_bot: false });
const message = (id: string, mid: string, chat = id) => ({ sender: user(id),
  recipient: { chat_id: chat, chat_type: 'dialog' }, body: { mid, text: 'private text marker' } });
const text = (id: string, mid: string, chat = id) => ({ update_type: 'message_created',
  timestamp: '1790856000000', message: message(id, mid, chat) });
const callback = (id: string, chat: string) => ({ update_type: 'message_callback', timestamp: '1790856000001',
  callback: { callback_id: 'callback-one', timestamp: '1790856000001', payload: 'private callback marker', user: user(id) },
  message: message(id, 'button-message', chat) });
const lifecycle = (id: string, type: 'bot_started' | 'bot_stopped', timestamp: string) =>
  ({ update_type: type, timestamp, chat_id: id, user: user(id) });
const post = (app: ReturnType<typeof createGateway>, payload: object | string,
  headers: Record<string, string> = { 'x-max-bot-api-secret': 'test-secret' }, url = '/webhooks/max') =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
const accepted = async (app: ReturnType<typeof createGateway>, payload: object | string) => {
  const response=await post(app,payload);
  expect(response.statusCode,`Ingress boundary: ${response.body}`).toBe(200); // One attempt, never retry.
};

beforeAll(async () => {
  f = await deliveryFixture();
  environment = {
    ...Object.fromEntries(Object.entries(f.pools).map(([role, pool]) =>
      [`DATABASE_URL_${role === 'migrator' ? 'MIGRATIONS' : role.toUpperCase()}`, pool.options.connectionString])),
    MAX_BOT_TOKEN: 'test-token', MAX_WEBHOOK_SECRET: 'test-secret', MAX_WEBHOOK_URL: 'https://example.org/hook',
    RESTORE_FENCE: 'off', WORKER_CONCURRENCY: 2, DELIVERY_CONCURRENCY: 2,
    WORK_LEASE_MS: 6000, WORK_LEASE_RENEW_MS: 2000, HANDLER_TIMEOUT_MS: 500,
  };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);
beforeEach(async () => {
  calls.length = 0; hold = false;
  await f.postgres.pool.query('TRUNCATE public.users CASCADE; UPDATE public.system_state SET restore_fence=false');
});
afterEach(async () => {
  hold = false;
  for (const call of calls) call.response.destroy();
  await Promise.all([...workers.splice(0), ...deliveries.splice(0)].map((runtime) => runtime.stop()));
  await Promise.all(gateways.splice(0).map((app) => app.close()));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await f?.close();
});

test('shared-secret authentication has zero effects; duplicate text/callback survive all runtime restarts', async () => {
  const id = '9223372036854775807'; const chat = '-9223372036854775808';
  // Numeric JSON tokens beyond JS safe integer must survive parsing and the eventual MAX recipient.
  const raw = JSON.stringify(text(id, 'text-one', chat)).replaceAll(`"${id}"`, id).replaceAll(`"${chat}"`, chat);
  const button = callback(id, chat);
  let app = gateway(); await app.ready();
  const idleWorker = worker(); const idleDelivery = delivery();
  for (const [headers, url] of [
    [{}, '/webhooks/max'], [{ 'x-max-bot-api-secret': 'wrong' }, '/webhooks/max'],
    [{}, '/webhooks/max?secret=test-secret'],
  ] as const) expect((await post(app, raw, headers, url)).statusCode).toBe(401);
  for (const table of ['users', 'channel_accounts', 'conversations', 'inbound_events', 'conversation_work',
    'processing_receipts', 'outbound_messages', 'delivery_work', 'delivery_attempts']) expect(await rows(table)).toEqual([]);
  expect(calls).toHaveLength(0);
  await idleWorker.stop(); await idleDelivery.stop();
  await accepted(app, raw); await accepted(app, raw);
  await accepted(app, button); await accepted(app, button);
  await app.close(); app = gateway(); await app.ready();
  await accepted(app, raw); await accepted(app, button);
  expect(await rows('inbound_events')).toHaveLength(2);
  expect(await rows('channel_accounts')).toMatchObject([{ external_user_id: id }]);
  expect(await rows('conversations')).toMatchObject([{ external_conversation_id: chat, next_inbound_sequence: '3' }]);
  const processing = worker(); await processed(2); await processing.stop();
  const receipts = await rows('processing_receipts'); const outbound = await rows('outbound_messages');
  expect(outbound).toHaveLength(2); expect(await rows('delivery_attempts')).toEqual([]);
  const sending = delivery(); await sent(2); await sending.stop();
  expect(calls.map((call) => call.text)).toEqual(['Получено сообщение №1.', 'Кнопка устарела или уже использована']);
  for (const call of calls) {
    expect(call.url.pathname).toBe('/messages');
    expect([...call.url.searchParams]).toEqual([['user_id', id]]);
    expect(call.headers.authorization === environment.MAX_BOT_TOKEN).toBe(true);
    expect(call.text.includes('private')).toBe(false);
  }
  expect(await rows('processing_receipts')).toEqual(receipts);
  expect((await rows('outbound_messages')).map((row) => row.id)).toEqual(outbound.map((row) => row.id));
  worker(); const restarted = delivery();
  await app.close(); app = gateway(); await app.ready();
  await accepted(app, raw); await accepted(app, button);
  // A new event makes restarted worker/delivery execute real scans before checking no duplicate send.
  await accepted(app, text(id, 'text-two', chat)); await sent(3); await restarted.stop();
  expect(calls).toHaveLength(3); expect(calls[2]!.text).toBe('Получено сообщение №3.');
  for (const table of ['inbound_events', 'processing_receipts', 'outbound_messages', 'delivery_work'])
    expect(await rows(table)).toHaveLength(3);
  const attempts = await rows('delivery_attempts');
  expect(attempts).toHaveLength(6);
  expect(attempts.filter((row) => row.phase === 'started')).toHaveLength(3);
  expect(attempts.filter((row) => row.phase === 'completed').map((row) => row.certainty)).toEqual(['sent', 'sent', 'sent']);
}, 20_000);

test.each([false, true])('consumed body timeout never resends after restart; completion fenced=%s', async (fenced) => {
  const app = gateway(); await app.ready(); await accepted(app, text('101', 'lost-response'));
  const processing = worker(); await processed(1); await processing.stop();
  hold = true; const sending = delivery();
  await until(async () => calls.length === 1);
  if (fenced) await f.postgres.pool.query('UPDATE public.system_state SET restore_fence=true');
  await sending.stop();
  if (fenced) {
    expect(await rows('delivery_attempts')).toMatchObject([{ phase: 'started', attempt_number: 1 }]);
    // Simulate expiry only; application work and outbox were created exclusively by public runtimes.
    await f.postgres.pool.query(`UPDATE public.system_state SET restore_fence=false;
      UPDATE public.delivery_work SET lease_until=clock_timestamp()-interval '1 second'`);
  } else {
    expect((await rows('delivery_work'))[0]).toMatchObject({ state: 'uncertain', attempt_count: 1 });
    expect(await rows('delivery_attempts')).toMatchObject([{ phase: 'started', attempt_number: 1 },
      { phase: 'completed', attempt_number: 1, certainty: 'uncertain', code: 'timeout' }]);
  }
  const restarted = delivery();
  await until(async () => (await rows('delivery_work'))[0].state === 'uncertain');
  const attempts = await rows('delivery_attempts');
  expect(attempts).toMatchObject([{ phase: 'started', attempt_number: 1 },
    { phase: 'completed', attempt_number: 1, certainty: 'uncertain', code: fenced ? 'attempt_abandoned' : 'timeout' }]);
  expect(attempts).toHaveLength(2);
  hold = false; worker();
  await accepted(app, text('102', 'fresh-after-timeout')); await sent(1); await restarted.stop();
  expect(calls.map((call) => call.url.searchParams.get('user_id'))).toEqual(['101', '102']);
  expect(await rows('processing_receipts')).toHaveLength(2);
  expect((await rows('delivery_work')).map((row) => row.state).sort()).toEqual(['sent', 'uncertain']);
}, 20_000);

test('public stop/start cancels an old pending reply and admits a fresh event', async () => {
  const app = gateway(); await app.ready(); await accepted(app, text('201', 'old-pending'));
  const processing = worker(); await processed(1); await processing.stop();
  const old = (await rows('outbound_messages'))[0];
  expect(old.status).toBe('pending');
  await accepted(app, lifecycle('201', 'bot_stopped', '1790856000002'));
  await accepted(app, lifecycle('201', 'bot_started', '1790856000003'));
  await accepted(app, text('201', 'new-after-start'));
  worker(); const sending = delivery(); await processed(4); await sent(1); await sending.stop();
  expect(await rows('conversations')).toMatchObject([{ state: 'active', delivery_cancelled_through_sequence: '1',
    next_inbound_sequence: '5', next_apply_sequence: '5' }]);
  expect((await rows('outbound_messages')).find((row) => row.id === old.id).status).toBe('cancelled');
  expect((await rows('delivery_work')).find((row) => row.outbound_message_id === old.id))
    .toMatchObject({ state: 'cancelled', attempt_count: 0 });
  expect(calls.map((call) => call.text)).toEqual(['Получено сообщение №4.']);
  expect(await rows('delivery_attempts')).toHaveLength(2);
}, 20_000);

test('a blocked tenant permits another tenant to progress; replies stay ordered and API stop drains actual certainty', async () => {
  const app = gateway(); await app.ready(); worker();
  await accepted(app, text('301', 'first-ordered')); await processed(1);
  hold = true; const sending = delivery(2000);
  try {
    await until(async () => calls.length === 1);
    await Promise.all([accepted(app, text('302', 'independent-tenant')), accepted(app, text('301', 'second-ordered'))]);
    await processed(3); await until(async () => calls.length === 2);
    const independent = calls.find((call) => call.url.searchParams.get('user_id') === '302')!;
    confirm(independent); await sent(1);
    expect(calls.filter((call) => call.url.searchParams.get('user_id') === '301')).toHaveLength(1);
    confirm(calls[0]!); await until(async () => calls.length === 3);
    expect(calls.filter((call) => call.url.searchParams.get('user_id') === '301').map((call) => call.text))
      .toEqual(['Получено сообщение №1.', 'Получено сообщение №2.']);
    const began = performance.now(); const stopped = sending.stop();
    confirm(calls[2]!); await stopped;
    expect(performance.now() - began).toBeLessThan(6500);
    expect(calls.map((call) => [call.url.searchParams.get('user_id'), call.text])).toEqual([
      ['301', 'Получено сообщение №1.'], ['302', 'Получено сообщение №1.'], ['301', 'Получено сообщение №2.'],
    ]);
    expect((await rows('delivery_work')).map((row) => row.state)).toEqual(['sent', 'sent', 'sent']);
    expect((await rows('delivery_attempts')).filter((row) => row.phase === 'completed')
      .map((row) => row.certainty)).toEqual(['sent', 'sent', 'sent']);
    expect((await rows('users')).length).toBe(2);
    expect((await rows('outbound_messages')).map((row) => row.user_id).sort())
      .toEqual((await rows('processing_receipts')).map((row) => row.user_id).sort());
  } finally {
    hold = false;
    for (const call of calls) if (!call.response.destroyed && !call.response.writableEnded) confirm(call);
    await sending.stop();
  }
}, 20_000);
