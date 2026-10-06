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
      id: 1, schema_version: 21, restore_fence: false,
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

  test('delivery guard exposes only its narrow protected admission capability', async () => {
    const metadata = await migrator.query(`SELECT p.prosecdef, p.proconfig,
      pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
      WHERE p.oid = 'public.guard_delivery_restore_fence()'::regprocedure`);
    expect(metadata.rows).toEqual([{
      prosecdef: true, proconfig: ['search_path=pg_catalog'], owner: 'echo_migrator',
    }]);
    for (const role of roles) {
      const pool = applicationPools[roles.indexOf(role)]!;
      if (role === 'delivery') {
        await expect(pool.query('SELECT public.guard_delivery_restore_fence()')).resolves.toBeDefined();
      } else {
        await expect(pool.query('SELECT public.guard_delivery_restore_fence()'))
          .rejects.toMatchObject({ code: '42501' });
      }
    }
    const acl = await migrator.query(`SELECT EXISTS (
      SELECT FROM pg_proc p, aclexplode(p.proacl) acl
      WHERE p.oid = 'public.guard_delivery_restore_fence()'::regprocedure
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    ) AS public_execute`);
    expect(acl.rows).toEqual([{ public_execute: false }]);
  });

  test('delivery guard rejects enabled and missing fences and admits after clearing', async () => {
    const delivery = applicationPools[roles.indexOf('delivery')]!;
    try {
      await migrator.query('UPDATE public.system_state SET restore_fence = true WHERE id = 1');
      await expect(delivery.query('SELECT public.guard_delivery_restore_fence()'))
        .rejects.toMatchObject({ code: 'P0001', message: 'Delivery unavailable' });
      await migrator.query('UPDATE public.system_state SET restore_fence = false WHERE id = 1');
      await expect(delivery.query('SELECT public.guard_delivery_restore_fence()')).resolves.toBeDefined();
      await migrator.query('DELETE FROM public.system_state WHERE id = 1');
      await expect(delivery.query('SELECT public.guard_delivery_restore_fence()'))
        .rejects.toMatchObject({ code: 'P0001', message: 'Delivery unavailable' });
    } finally {
      await migrator.query(`INSERT INTO public.system_state (id, schema_version) VALUES (1, 21)
        ON CONFLICT (id) DO UPDATE SET restore_fence = false`);
    }
  });

  test('delivery guard keeps the fence row locked through later work until COMMIT', async () => {
    const delivery = await applicationPools[roles.indexOf('delivery')]!.connect();
    const operator = await migrator.connect();
    try {
      await delivery.query('BEGIN');
      // Future callers must guard before queue/tenant locks: fence-first matches ingress/worker
      // and keeps restore admission ordered without holding any lock across a MAX request.
      await delivery.query('SELECT public.guard_delivery_restore_fence()');
      await delivery.query('SELECT 1 AS later_work');
      await operator.query('BEGIN');
      // A restore_fence UPDATE takes NO KEY UPDATE, so a weaker KEY SHARE guard is insufficient.
      await expect(operator.query('SELECT id FROM public.system_state WHERE id = 1 FOR NO KEY UPDATE NOWAIT'))
        .rejects.toMatchObject({ code: '55P03' });
      await operator.query('ROLLBACK');
      await delivery.query('COMMIT');
      await operator.query('BEGIN');
      await operator.query('SELECT id FROM public.system_state WHERE id = 1 FOR NO KEY UPDATE NOWAIT');
      await operator.query('UPDATE public.system_state SET restore_fence = true WHERE id = 1');
      await operator.query('COMMIT');
      await expect(delivery.query('SELECT public.guard_delivery_restore_fence()'))
        .rejects.toMatchObject({ code: 'P0001' });
    } finally {
      await delivery.query('ROLLBACK');
      await operator.query('ROLLBACK');
      await operator.query('UPDATE public.system_state SET restore_fence = false WHERE id = 1');
      delivery.release();
      operator.release();
    }
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
