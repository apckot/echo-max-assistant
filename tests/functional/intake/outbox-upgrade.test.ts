import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

describe('outbox upgrade from schema 12', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  let gateway: Pool;
  let directory: string;
  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    for (const role of ['migrator', 'gateway'])
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
    const url = (role: string) => {
      const value = new URL(postgres.pool.options.connectionString!);
      value.username = `echo_${role}`; value.password = 'isolated-test-password'; return value.toString();
    };
    migrator = new Pool({ connectionString: url('migrator') });
    gateway = new Pool({ connectionString: url('gateway') });
    directory = await mkdtemp(join(tmpdir(), 'echo-max-upgrade-'));
    for (const name of (await readdir(`${root}migrations`)).filter((name) => /^00(?:0[1-9]|1[0-2])_.*\.sql$/.test(name)))
      await copyFile(`${root}migrations/${name}`, join(directory, name));
    await runMigrations(migrator, directory);
  }, 120_000);
  afterAll(async () => {
    await Promise.all([gateway?.end(), migrator?.end()]);
    if (directory) await rm(directory, { recursive: true, force: true });
    await postgres?.stop();
  });

  test('materializes old receipt drafts in order without changing events or replaying handlers', async () => {
    for (const [key, payload] of [
      ['one', { kind: 'text', text: 'private' }],
      ['two', { kind: 'lifecycle', lifecycleType: 'started' }],
    ] as const) await gateway.query('SELECT * FROM public.accept_max_inbound($1,$2,$3,$4,$5,$6)',
      ['9001', '9001', `message:9001:${key}`, '2026-10-01T00:00:00Z', JSON.stringify(payload), 'a'.repeat(64)]);
    const sources = (await migrator.query<{ id: string; user_id: string; conversation_id: string; sequence: string }>(
      'SELECT id, user_id, conversation_id, sequence FROM public.inbound_events ORDER BY sequence')).rows;
    expect(sources).toHaveLength(2);
    for (const [index, source] of sources.entries()) await migrator.query(`INSERT INTO public.processing_receipts
      (user_id, conversation_id, inbound_event_id, receipt_type, receipt_version, result)
      VALUES ($1,$2,$3,'foundation_echo',1,$4::jsonb)`, [source!.user_id, source!.conversation_id, source!.id,
      JSON.stringify({ receiptType: 'foundation_echo', receiptVersion: 1, messages: index === 0
        ? [{ version: 1, kind: 'text', text: 'alpha' }, { version: 1, kind: 'text', text: 'beta' }] : [] })]);
    await migrator.query("UPDATE public.inbound_events SET processing_status = 'applied', processed_at = clock_timestamp()");
    await migrator.query('UPDATE public.conversations SET next_apply_sequence = 3');
    const before = {
      receipts: (await migrator.query('SELECT * FROM public.processing_receipts ORDER BY inbound_event_id')).rows,
      events: (await migrator.query('SELECT * FROM public.inbound_events ORDER BY sequence')).rows,
      conversations: (await migrator.query('SELECT * FROM public.conversations')).rows,
    };
    await copyFile(`${root}migrations/0013_transactional_outbox.sql`, join(directory, '0013_transactional_outbox.sql'));
    await runMigrations(migrator, directory);
    const outbound = (await migrator.query(`SELECT user_id, conversation_id, source_inbound_event_id,
      message_index, payload, dedupe_key, status FROM public.outbound_messages ORDER BY message_index`)).rows;
    expect(outbound).toEqual([0, 1].map((index) => ({ user_id: sources[0]!.user_id,
      conversation_id: sources[0]!.conversation_id, source_inbound_event_id: sources[0]!.id,
      message_index: index, payload: { version: 1, kind: 'text', text: index === 0 ? 'alpha' : 'beta' },
      dedupe_key: `response:${sources[0]!.id}:${index}:v1`, status: 'pending' })));
    expect((await migrator.query(`SELECT w.user_id, w.state, m.source_inbound_event_id FROM public.delivery_work w
      JOIN public.outbound_messages m ON m.id = w.outbound_message_id ORDER BY m.message_index`)).rows)
      .toEqual([0, 1].map(() => ({ user_id: sources[0]!.user_id, state: 'ready', source_inbound_event_id: sources[0]!.id })));
    expect((await migrator.query('SELECT * FROM public.processing_receipts ORDER BY inbound_event_id')).rows).toEqual(before.receipts);
    expect((await migrator.query('SELECT * FROM public.inbound_events ORDER BY sequence')).rows).toEqual(before.events);
    expect((await migrator.query('SELECT * FROM public.conversations')).rows).toEqual(before.conversations);
    await runMigrations(migrator, directory);
    expect((await migrator.query('SELECT count(*)::int AS count FROM public.outbound_messages')).rows).toEqual([{ count: 2 }]);
    expect((await migrator.query('SELECT count(*)::int AS count FROM public.delivery_work')).rows).toEqual([{ count: 2 }]);
  });
});
