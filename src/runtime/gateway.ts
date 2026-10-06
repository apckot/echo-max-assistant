import { registerHealthRoutes } from '../infrastructure/http/health-routes.js';
import { PostgresHealthStore, expectedMigrations } from '../infrastructure/postgres/postgres-health-store.js';
import { HealthService } from '../modules/operations/application/health-service.js';
import type { Logger } from 'pino';
import { createMaxWebhookApp } from '../infrastructure/http/max-webhook-route.js';
import { createDatabase } from '../infrastructure/postgres/database.js';
import { acceptMaxInbound } from '../infrastructure/postgres/postgres-intake-store.js';
import { parseRuntimeConfig } from '../shared/config/config.js';

export function createGateway(environment: Record<string, unknown>, logger?: Logger) {
  const config = parseRuntimeConfig(environment, 'gateway');
  const database = createDatabase({ gateway: config.DATABASE_URL_GATEWAY, poolSize: config.GATEWAY_DB_POOL_SIZE });
  const app = createMaxWebhookApp({
    secret: config.MAX_WEBHOOK_SECRET,
    bodyLimit: config.WEBHOOK_BODY_LIMIT_BYTES,
    restoreFence: () => config.RESTORE_FENCE === 'on',
    intake: (event, hash) => acceptMaxInbound(database, event, hash, config.QUEUE_HARD_LIMIT),
    logger,
  });
  app.register(async scoped => {
    registerHealthRoutes(scoped, new HealthService(new PostgresHealthStore(database), await expectedMigrations(),
      config.RESTORE_FENCE === 'on'), config.OPS_HEALTH_TOKEN);
  });
  app.addHook('onClose', () => database.close());
  return app;
}
