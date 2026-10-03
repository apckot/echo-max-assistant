import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { UserId } from '../../shared/types/identity.js';

export type { UserId } from '../../shared/types/identity.js';

export type SystemRole = 'gateway' | 'worker' | 'delivery' | 'scheduler';
export type TenantRole = SystemRole;
export type DbErrorCode = 'DB_INVALID_USER_ID' | 'DB_TIMEOUT' | 'DB_CONFLICT' |
  'DB_UNAVAILABLE' | 'DB_INVALID_INPUT' | 'DB_FAILURE' | 'DB_CLOSED' | 'DB_ROLE_MISMATCH';

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

type DatabaseUrls = Partial<Record<SystemRole, string>> & { poolSize?: number };
const roles: readonly SystemRole[] = ['gateway', 'worker', 'delivery', 'scheduler'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function databaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '22007' || code === '22008' || code === '22021' || code === '22023' || code === '22P05' || code === '22P02') {
    return new DatabaseError('DB_INVALID_INPUT', 'Database input invalid');
  }
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
  const configuredRoles = roles.filter((role) => urls[role] !== undefined);
  if (!configuredRoles.length) throw new DatabaseError('DB_ROLE_MISMATCH', 'Database role configuration invalid');
  for (const role of configuredRoles) {
    try {
      const url = new URL(urls[role]!);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        decodeURIComponent(url.username) !== `echo_${role}` || url.searchParams.has('user')) {
        throw new Error('role mismatch');
      }
    } catch {
      throw new DatabaseError('DB_ROLE_MISMATCH', 'Database role configuration invalid');
    }
  }
  const pools = Object.fromEntries(configuredRoles.map((role) => [role, new Pool({
    connectionString: urls[role], max: urls.poolSize ?? 10,
    ...(role === 'gateway' ? { connectionTimeoutMillis: 150 } : {}),
  })])) as Record<SystemRole, Pool>;
  // pg removes failed idle clients before emitting; contain the event without raw diagnostics.
  for (const role of configuredRoles) pools[role].on('error', () => {});
  let closed = false;

  async function transaction<T>(role: SystemRole, userId: UserId | undefined, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    if (closed) throw new DatabaseError('DB_CLOSED', 'Database is closed');
    if (!configuredRoles.includes(role)) throw new DatabaseError('DB_FAILURE', 'Database operation failed');
    if (userId !== undefined && (!uuid.test(userId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(userId))) {
      throw new DatabaseError('DB_INVALID_USER_ID', 'Internal user ID required');
    }
    const deadline = role === 'gateway' ? performance.now() + 150 : Infinity;
    let client: PoolClient | undefined;
    let released = false;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new DatabaseError('DB_TIMEOUT', 'Database operation timed out');
    let rejectDeadline: (error: DatabaseError) => void;
    const deadlineReached = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const release = (discard: boolean) => {
      if (client && !released) {
        released = true;
        client.release(discard);
      }
    };
    const expire = () => {
      expired = true;
      active = false;
      // Destroy the session instead of waiting for SQL or the application callback.
      // PostgreSQL rolls back an open transaction when its connection closes.
      release(true);
      rejectDeadline(timeout);
    };
    const checkDeadline = () => {
      if (expired || performance.now() >= deadline) {
        if (!expired) expire();
        throw timeout;
      }
    };
    let active = true;
    let begun = false;
    let discardClient = false;
    const run = async () => {
      try {
        client = await pools[role].connect().catch((error: unknown) => { throw databaseError(error); });
        // A pool acquisition can finish after the caller's deadline. Never use it.
        checkDeadline();
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
              checkDeadline();
              const result = await client!.query<T>(sql, params ? [...params] : []);
              return result.rows;
            } catch (error) {
              throw databaseError(error);
            }
          },
        };
        checkDeadline();
        const result = await fn(tx);
        checkDeadline();
        active = false;
        // COMMIT acknowledgement can be lost; callers must retry idempotently.
        await client.query('COMMIT');
        checkDeadline();
        return result;
      } catch (error) {
        active = false;
        if (begun && !expired) {
          try { await client!.query('ROLLBACK'); } catch { discardClient = true; }
        }
        if (expired) throw timeout;
        if (error instanceof DatabaseError || !(error instanceof Error) || !('code' in error)) throw error;
        throw databaseError(error);
      } finally {
        release(discardClient || expired);
      }
    };
    if (role === 'gateway') timer = setTimeout(expire, Math.max(0, deadline - performance.now()));
    try {
      return await Promise.race([run(), deadlineReached]);
    } finally {
      clearTimeout(timer);
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
      await Promise.all(configuredRoles.map((role) => pools[role].end()));
    },
  };
}
