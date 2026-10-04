import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createDatabase } from '../../src/infrastructure/postgres/database.js';
import { runMigrations } from '../../src/infrastructure/postgres/migrations.js';
import { startPostgres } from './postgres.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export async function deliveryFixture() {
  const postgres = await startPostgres();
  await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
  const url = (role: string) => {
    const value = new URL(postgres.pool.options.connectionString!);
    value.username = `echo_${role}`;
    value.password = 'isolated-test-password';
    return value.toString();
  };
  const roles = ['migrator', 'gateway', 'worker', 'delivery', 'scheduler'] as const;
  for (const role of roles) await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD 'isolated-test-password'`);
  const pools = Object.fromEntries(roles.map((role) => [role, new Pool({ connectionString: url(role) })])) as Record<typeof roles[number], Pool>;
  await runMigrations(pools.migrator, `${root}migrations`);
  const database = createDatabase({ delivery: url('delivery') });
  let externalId = 500;
  return { postgres, pools, database,
    async seed() {
      const external = String(++externalId);
      await pools.gateway.query('SELECT * FROM public.accept_max_inbound($1,$1,$2,$3,$4,$5)',
        [external, `message:${external}`, '2026-10-01T00:00:00Z',
          JSON.stringify({ kind: 'text', text: 'private input' }), 'a'.repeat(64)]);
      const result = await postgres.pool.query<{ id: string; user_id: string }>(`INSERT INTO public.outbound_messages
        (user_id, conversation_id, source_inbound_event_id, message_index, payload, dedupe_key)
        SELECT user_id, conversation_id, id, 0, '{"version":1,"kind":"text","text":"private output"}',
          'response:' || id::text || ':0:v1' FROM public.inbound_events WHERE provider_event_key = $1
        RETURNING id, user_id`, [`message:${external}`]);
      const work = result.rows[0]!;
      await postgres.pool.query('INSERT INTO public.delivery_work (outbound_message_id,user_id) VALUES ($1,$2)', [work.id, work.user_id]);
      return work;
    },
    async close() {
      await database.close();
      await Promise.all(Object.values(pools).map((pool) => pool.end()));
      await postgres.stop();
    },
  };
}
