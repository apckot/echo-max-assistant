import { randomUUID } from 'node:crypto';
import { createMaxSender } from '../infrastructure/max/max-client.js';
import { createDatabase, type Database, type DbTx } from '../infrastructure/postgres/database.js';
import { PostgresDeliveryQueue } from '../infrastructure/postgres/postgres-delivery-queue.js';
import { PostgresDeliveryAdmission } from '../infrastructure/postgres/postgres-delivery-admission.js';
import { PostgresDeliveryCompletion } from '../infrastructure/postgres/postgres-delivery-completion.js';
import type { DeliveryLease, DeliveryQueue } from '../modules/delivery/application/delivery-queue.js';
import { DeliveryWorker } from '../modules/delivery/application/delivery-worker.js';
import { parseRuntimeConfig } from '../shared/config/config.js';

type DeliveryOptions = { queue: DeliveryQueue; worker: Pick<DeliveryWorker, 'run'>;
  close: () => Promise<void>; concurrency: number; leaseMs: number; renewMs: number; enabled?: boolean };

// Custom ports must settle; only createDelivery supplies bounded production I/O.
export function startDeliveryLoop(options: DeliveryOptions) {
  const ownerId = randomUUID();
  const active = new Set<Promise<void>>();
  let stopping = false;
  let scan: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;
  function launch(lease: DeliveryLease) {
    let renewal: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (renewal) return;
      // Keep admitted sends authoritative while stop waits for actual certainty.
      // Renewal is independent; never await it while holding tenant locks.
      renewal = Promise.resolve().then(() => options.queue.renew(lease, options.leaseMs))
        .catch(() => {}).finally(() => { renewal = undefined; });
    }, options.renewMs);
    const task = Promise.resolve().then(() => stopping ? undefined : options.worker.run(lease)).catch(() => {
      // Reclaim recovers durable started attempts uncertain; never resend here.
    }).finally(async () => {
      clearInterval(timer);
      await renewal;
    }).then(() => { active.delete(task); });
    active.add(task);
  }
  function poll() {
    if (stopping || scan || options.enabled === false || active.size >= options.concurrency) return;
    scan = Promise.resolve().then(() => stopping ? [] : options.queue.claim({ ownerId,
      limit: options.concurrency - active.size, leaseMs: options.leaseMs }))
      .then((leases) => { if (!stopping) for (const lease of leases) launch(lease); })
      .catch(() => {}).finally(() => { scan = undefined; });
  }
  const scanTimer = options.enabled === false ? undefined : setInterval(poll, 100);
  poll();
  return { stop(): Promise<void> {
    if (!stopped) {
      stopping = true;
      clearInterval(scanTimer);
      stopped = (async () => { await scan; await Promise.all(active); await options.close(); })();
    }
    return stopped;
  } };
}

export function createDelivery(environment: Record<string, unknown>,
  max: { baseUrl?: string; timeoutMs?: number } = {}) {
  const config = parseRuntimeConfig(environment, 'delivery');
  const timeoutMs = max.timeoutMs ?? 5000;
  const transactionMs = Math.floor(config.WORK_LEASE_RENEW_MS / 2);
  // Claim ACK + admission + sender + completion must fit even without renewal.
  // Initial claim ACK + heartbeat interval + renewal must also fit the lease.
  // These are I/O budgets for a responsive event loop, not OS realtime guarantees.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || transactionMs < 1 ||
    3 * transactionMs + timeoutMs >= config.WORK_LEASE_MS ||
    config.WORK_LEASE_RENEW_MS + 2 * transactionMs >= config.WORK_LEASE_MS) {
    throw new Error('invalid_delivery_timing');
  }
  // Validate sender options before allocating a pool or starting any timer.
  const sender = createMaxSender({ token: config.MAX_BOT_TOKEN, baseUrl: max.baseUrl, timeoutMs });
  const database = createDatabase({ delivery: config.DATABASE_URL_DELIVERY, poolSize: config.DELIVERY_CONCURRENCY,
    deliveryTransactionTimeoutMs: transactionMs });
  const guard = <T>(fn: (tx: DbTx) => Promise<T>) => async (tx: DbTx) => {
    // Fence first, before queue/tenant locks, and retain it through COMMIT.
    await tx.query('SELECT public.guard_delivery_restore_fence()');
    return fn(tx);
  };
  const guarded: Database = {
    systemTransaction: (role, fn) => database.systemTransaction(role, guard(fn)),
    tenantTransaction: (role, userId, fn) => database.tenantTransaction(role, userId, guard(fn)),
    close: () => database.close(),
  };
  return startDeliveryLoop({ queue: new PostgresDeliveryQueue(guarded),
    worker: new DeliveryWorker(new PostgresDeliveryAdmission(guarded), sender, new PostgresDeliveryCompletion(guarded)),
    close: () => guarded.close(), concurrency: config.DELIVERY_CONCURRENCY,
    leaseMs: config.WORK_LEASE_MS, renewMs: config.WORK_LEASE_RENEW_MS, enabled: config.RESTORE_FENCE === 'off' });
}
