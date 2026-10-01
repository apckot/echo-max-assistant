import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

export async function startPostgres() {
  const container = await new PostgreSqlContainer('postgres:17').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });

  return {
    pool,
    async stop() {
      try {
        await pool.end();
      } finally {
        await container.stop();
      }
    },
  };
}
