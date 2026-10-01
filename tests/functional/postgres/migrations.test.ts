import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../../../src/infrastructure/postgres/migrations.js';
import { startPostgres } from '../../support/postgres.js';

describe('PostgreSQL migrations', () => {
  let database: Awaited<ReturnType<typeof startPostgres>>;
  let directory: string;

  beforeAll(async () => {
    database = await startPostgres();
  }, 120_000);

  beforeEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = await mkdtemp(join(tmpdir(), 'echo-max-migrations-'));
    await database.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  });

  afterAll(async () => {
    if (database) await database.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function migration(name: string, sql: string) {
    await writeFile(join(directory, name), sql);
  }

  test('applies ordered migrations once and rejects a changed checksum', async () => {
    await migration('001_create.sql', 'CREATE TABLE migration_probe (id integer PRIMARY KEY);');
    await migration('002_insert.sql', 'INSERT INTO migration_probe (id) VALUES (1);');

    await runMigrations(database.pool, directory);
    await runMigrations(database.pool, directory);
    expect((await database.pool.query('SELECT id FROM migration_probe')).rows).toEqual([{ id: 1 }]);
    expect((await database.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows)
      .toEqual([{ name: '001_create.sql' }, { name: '002_insert.sql' }]);

    await migration('002_insert.sql', 'INSERT INTO migration_probe (id) VALUES (2);');
    await expect(runMigrations(database.pool, directory)).rejects.toThrow(/checksum/i);
    expect((await database.pool.query('SELECT id FROM migration_probe')).rows).toEqual([{ id: 1 }]);
    await migration('002_insert.sql', 'INSERT INTO migration_probe (id) VALUES (1);');
  });

  test('rolls back failed SQL and does not record it as applied', async () => {
    await migration('001_fails.sql', 'CREATE TABLE rolled_back (id integer); SELECT 1 / 0;');
    await expect(runMigrations(database.pool, directory)).rejects.toThrow();
    expect((await database.pool.query("SELECT to_regclass('rolled_back') AS table_name")).rows[0])
      .toEqual({ table_name: null });
    expect((await database.pool.query("SELECT name FROM schema_migrations WHERE name = '001_fails.sql'")).rows)
      .toEqual([]);
  });

  test('serializes concurrent runners across separate connections', async () => {
    await migration('001_slow.sql', 'SELECT pg_sleep(0.2); CREATE TABLE migration_probe (id integer PRIMARY KEY); INSERT INTO migration_probe (id) VALUES (3);');
    const secondPool = new Pool({ connectionString: database.pool.options.connectionString });
    try {
      await Promise.all([
        runMigrations(database.pool, directory),
        runMigrations(secondPool, directory),
      ]);
    } finally {
      await secondPool.end();
    }
    expect((await database.pool.query('SELECT id FROM migration_probe ORDER BY id')).rows)
      .toEqual([{ id: 3 }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM schema_migrations WHERE name = '001_slow.sql'")).rows)
      .toEqual([{ count: 1 }]);
  });
});
