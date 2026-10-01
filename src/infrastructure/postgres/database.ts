import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export type SystemRole = 'gateway' | 'worker' | 'delivery' | 'scheduler';
export type TenantRole = SystemRole;
export type UserId = string & { readonly __userId: unique symbol };
export type DbErrorCode = 'DB_INVALID_USER_ID' | 'DB_TIMEOUT' | 'DB_CONFLICT' |
  'DB_UNAVAILABLE' | 'DB_FAILURE' | 'DB_CLOSED' | 'DB_ROLE_MISMATCH';

export class DatabaseError extends Error {
  constructor(readonly code: DbErrorCode, message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export interface DbTx {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface Database {
  systemTransaction<T>(role: SystemRole, fn: (tx: DbTx) => Promise<T>): Promise<T>;
  tenantTransaction<T>(role: TenantRole, userId: UserId, fn: (tx: DbTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type DatabaseUrls = Record<SystemRole, string> & { poolSize?: number };
const roles: readonly SystemRole[] = ['gateway', 'worker', 'delivery', 'scheduler'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function databaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '57014' || code === '55P03') return new DatabaseError('DB_TIMEOUT', 'Database operation timed out');
  if (code === '40001' || code === '40P01' || code === '23505') {
    return new DatabaseError('DB_CONFLICT', 'Database operation conflicted');
  }
  if (typeof code === 'string' && code.startsWith('08')) {
    return new DatabaseError('DB_UNAVAILABLE', 'Database unavailable');
  }
  return new DatabaseError('DB_FAILURE', 'Database operation failed');
}

export function createDatabase(urls: DatabaseUrls): Database {
  for (const role of roles) {
    try {
      const url = new URL(urls[role]);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        decodeURIComponent(url.username) !== `echo_${role}` || url.searchParams.has('user')) {
        throw new Error('role mismatch');
      }
    } catch {
      throw new DatabaseError('DB_ROLE_MISMATCH', 'Database role configuration invalid');
    }
  }
  const pools = Object.fromEntries(roles.map((role) => [role, new Pool({
    connectionString: urls[role], max: urls.poolSize ?? 10,
  })])) as Record<SystemRole, Pool>;
  let closed = false;

  async function transaction<T>(role: SystemRole, userId: UserId | undefined, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    if (closed) throw new DatabaseError('DB_CLOSED', 'Database is closed');
    if (!roles.includes(role)) throw new DatabaseError('DB_FAILURE', 'Database operation failed');
    if (userId !== undefined && (!uuid.test(userId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(userId))) {
      throw new DatabaseError('DB_INVALID_USER_ID', 'Internal user ID required');
    }
    let client: PoolClient;
    try {
      client = await pools[role].connect();
    } catch (error) {
      throw databaseError(error);
    }
    let active = true;
    let begun = false;
    let discardClient = false;
    try {
      await client.query('BEGIN');
      begun = true;
      if (userId !== undefined) {
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      }
      await client.query(role === 'gateway'
        ? "SET LOCAL statement_timeout = '150ms'" : "SET LOCAL statement_timeout = '5s'");
      await client.query(role === 'gateway'
        ? "SET LOCAL lock_timeout = '100ms'" : "SET LOCAL lock_timeout = '1s'");
      const tx: DbTx = {
        async query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]> {
          if (!active) throw new DatabaseError('DB_CLOSED', 'Transaction is closed');
          try {
            const result = await client.query<T>(sql, params ? [...params] : []);
            return result.rows;
          } catch (error) {
            throw databaseError(error);
          }
        },
      };
      const result = await fn(tx);
      active = false;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      active = false;
      if (begun) {
        try { await client.query('ROLLBACK'); } catch { discardClient = true; }
      }
      if (error instanceof DatabaseError || !(error instanceof Error) || !('code' in error)) throw error;
      throw databaseError(error);
    } finally {
      client.release(discardClient);
    }
  }

  return {
    systemTransaction: (role, fn) => transaction(role, undefined, fn),
    tenantTransaction: async (role, userId, fn) => {
      if (!userId) throw new DatabaseError('DB_INVALID_USER_ID', 'Internal user ID required');
      return transaction(role, userId, fn);
    },
    async close() {
      closed = true;
      await Promise.all(roles.map((role) => pools[role].end()));
    },
  };
}
