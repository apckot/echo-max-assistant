import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

type Migration = { name: string; sql: string; checksum: string };

async function readMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql, 'utf8').digest('hex') };
  }));
}

export async function runMigrations(pool: Pool, directory: string): Promise<void> {
  const migrations = await readMigrations(directory);
  const client = await pool.connect();
  try {
    // Session lock covers table creation, checksum checks, and every migration transaction.
    await client.query('SELECT pg_advisory_lock(1698727768, 1296127058)');
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

      const applied = await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM public.schema_migrations',
      );
      const checksums = new Map(applied.rows.map(({ name, checksum }) => [name, checksum]));
      for (const migration of migrations) {
        const previous = checksums.get(migration.name);
        if (previous && previous !== migration.checksum) {
          throw new Error(`Migration checksum mismatch: ${migration.name}`);
        }
      }

      for (const migration of migrations) {
        if (checksums.has(migration.name)) continue;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            'INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)',
            [migration.name, migration.checksum],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(1698727768, 1296127058)');
    }
  } finally {
    client.release();
  }
}
