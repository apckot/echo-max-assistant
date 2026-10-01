import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { startPostgres } from '../../support/postgres.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const migrationDirectory = fileURLToPath(new URL('../../../migrations', import.meta.url));
const roles = ['gateway', 'worker', 'delivery', 'scheduler'] as const;
const testPassword = 'isolated-test-password';

describe('protected system state', () => {
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let migrator: Pool;
  const applicationPools: Pool[] = [];

  beforeAll(async () => {
    postgres = await startPostgres();
    await postgres.pool.query(await readFile(`${root}bootstrap/roles.sql`, 'utf8'));
    const adminUrl = new URL(postgres.pool.options.connectionString!);
    for (const role of [...roles, 'migrator']) {
      await postgres.pool.query(`ALTER ROLE echo_${role} PASSWORD '${testPassword}'`);
    }
    const databaseName = decodeURIComponent(adminUrl.pathname.slice(1));
    await postgres.pool.query(`ALTER DATABASE "${databaseName.replaceAll('"', '""')}" OWNER TO echo_migrator`);
    const roleUrl = (role: string) => {
      const url = new URL(adminUrl);
      url.username = `echo_${role}`;
      url.password = testPassword;
      return url.toString();
    };
    migrator = new Pool({ connectionString: roleUrl('migrator') });
    await runMigrations(migrator, migrationDirectory);
    for (const role of roles) applicationPools.push(new Pool({ connectionString: roleUrl(role) }));
  }, 120_000);

  afterAll(async () => {
    await Promise.all(applicationPools.map((pool) => pool.end()));
    await migrator?.end();
    await postgres?.stop();
  });

  test('initializes one state row with schema version and safe restore defaults', async () => {
    const result = await migrator.query<{
      id: number; schema_version: number; restore_fence: boolean;
      restored_snapshot_at: Date | null; deployment_epoch: string;
    }>(`SELECT id, schema_version, restore_fence, restored_snapshot_at, deployment_epoch
        FROM public.system_state`);
    expect(result.rows).toEqual([{
      id: 1, schema_version: 2, restore_fence: false,
      restored_snapshot_at: null, deployment_epoch: '0',
    }]);
  });

  test('migrator can set and clear the restore fence with snapshot and deployment epoch', async () => {
    const restoredAt = '2026-10-01T00:00:00.000Z';
    const fenced = await migrator.query<{
      restore_fence: boolean; restored_snapshot_at: Date; deployment_epoch: string;
    }>(`UPDATE public.system_state
        SET restore_fence = true, restored_snapshot_at = $1, deployment_epoch = 1
        WHERE id = 1
        RETURNING restore_fence, restored_snapshot_at, deployment_epoch`, [restoredAt]);
    expect(fenced.rows).toEqual([{
      restore_fence: true, restored_snapshot_at: new Date(restoredAt), deployment_epoch: '1',
    }]);
    const unfenced = await migrator.query<{ restore_fence: boolean }>(
      'UPDATE public.system_state SET restore_fence = false WHERE id = 1 RETURNING restore_fence',
    );
    expect(unfenced.rows).toEqual([{ restore_fence: false }]);
  });

  test('rejects extra state rows and invalid versions or epochs', async () => {
    await expect(migrator.query('INSERT INTO public.system_state (id, schema_version) VALUES (2, 2)'))
      .rejects.toMatchObject({ code: '23514' });
    await expect(migrator.query('UPDATE public.system_state SET schema_version = 0 WHERE id = 1'))
      .rejects.toMatchObject({ code: '23514' });
    await expect(migrator.query('UPDATE public.system_state SET deployment_epoch = -1 WHERE id = 1'))
      .rejects.toMatchObject({ code: '23514' });
  });

  test.each(roles)('%s cannot read or change system state with its own credential', async (role) => {
    const pool = applicationPools[roles.indexOf(role)]!;
    expect((await pool.query('SELECT current_user AS role')).rows[0]?.role).toBe(`echo_${role}`);
    await expect(pool.query('SELECT * FROM public.system_state'))
      .rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('UPDATE public.system_state SET restore_fence = false WHERE id = 1'))
      .rejects.toMatchObject({ code: '42501' });
  });
});
