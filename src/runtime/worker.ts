import { randomUUID } from 'node:crypto';
import { createDatabase, type Database, type DbTx } from '../infrastructure/postgres/database.js';
import { PostgresConversationQueue } from '../infrastructure/postgres/postgres-conversation-queue.js';
import { PostgresFencedConversation } from '../infrastructure/postgres/postgres-fenced-conversation.js';
import { PostgresOrderedHead } from '../infrastructure/postgres/postgres-ordered-head.js';
import { PostgresAtomicProcessing } from '../infrastructure/postgres/postgres-atomic-processing.js';
import type { ConversationLease, ConversationQueue } from '../modules/intake/application/conversation-queue.js';
import { FoundationInboundHandler } from '../modules/intake/application/inbound-handler.js';
import { ProcessInbound } from '../modules/intake/application/process-inbound.js';
import { parseRuntimeConfig } from '../shared/config/config.js';

type WorkerOptions = { queue: ConversationQueue; process: Pick<ProcessInbound, 'run'>;
  close: () => Promise<void>; concurrency: number; leaseMs: number; renewMs: number; enabled?: boolean };

// Ports supplied here must settle; createWorker supplies bounded database operations.
export function startWorkerLoop(options: WorkerOptions) {
  const ownerId = randomUUID();
  const active = new Set<Promise<void>>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  let stopping = false;
  let scan: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;
  function launch(lease: ConversationLease) {
    let renewal: Promise<unknown> | undefined;
    const timer = setInterval(() => {
      if (stopping || renewal) return;
      // Independent of processing: never await this from inside its transaction.
      renewal = Promise.resolve().then(() => options.queue.renew(lease, options.leaseMs))
        .catch(() => {}).finally(() => { renewal = undefined; });
    }, options.renewMs);
    timers.add(timer);
    const task = Promise.resolve().then(() => options.process.run(lease)).catch(() => {
      // DB/lease failures are reclaimed after expiry; the processor owns retries.
    }).finally(async () => {
      clearInterval(timer); timers.delete(timer);
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
      stopping = true; clearInterval(scanTimer);
      for (const timer of timers) clearInterval(timer);
      stopped = (async () => { await scan; await Promise.all(active); await options.close(); })();
    }
    return stopped;
  } };
}

export function createWorker(environment: Record<string, unknown>) {
  const config = parseRuntimeConfig(environment, 'worker');
  const database = createDatabase({ worker: config.DATABASE_URL_WORKER, poolSize: config.WORKER_CONCURRENCY,
    workerTransactionTimeoutMs: config.WORK_LEASE_RENEW_MS });
  const guard = <T>(fn: (tx: DbTx) => Promise<T>) => async (tx: DbTx) => {
    // Acquire before conversation/work locks and retain through transaction commit.
    await tx.query('SELECT public.guard_worker_restore_fence()'); return fn(tx);
  };
  const guarded: Database = {
    systemTransaction: (role, fn) => database.systemTransaction(role, guard(fn)),
    tenantTransaction: (role, userId, fn) => database.tenantTransaction(role, userId, guard(fn)),
    close: () => database.close(),
  };
  return startWorkerLoop({ queue: new PostgresConversationQueue(guarded),
    process: new ProcessInbound(new PostgresAtomicProcessing(new PostgresOrderedHead(
      new PostgresFencedConversation(guarded))), new FoundationInboundHandler(), config.HANDLER_TIMEOUT_MS),
    close: () => guarded.close(), concurrency: config.WORKER_CONCURRENCY,
    leaseMs: config.WORK_LEASE_MS, renewMs: config.WORK_LEASE_RENEW_MS, enabled: config.RESTORE_FENCE === 'off' });
}
