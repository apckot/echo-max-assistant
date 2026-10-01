import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import pino, { type Logger } from 'pino';
import { InvalidMaxUpdateError, mapMaxUpdate, type NormalizedInbound } from '../max/update-mapper.js';

export type MaxWebhookDependencies = {
  secret: string;
  restoreFence: () => boolean | Promise<boolean>;
  intake: (event: NormalizedInbound, rawSha256: string) => Promise<{ status: 'created' | 'duplicate' }>;
  logger?: Logger;
};

const BODY_LIMIT = 1024 * 1024;
const numericIdFields = new Set(['user_id', 'chat_id', 'timestamp']);

function sameSecret(candidate: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

function parseMaxJson(body: string): unknown {
  return JSON.parse(body, (key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && numericIdFields.has(key) ? context?.source ?? value : value);
}

export function createMaxWebhookApp(dependencies: MaxWebhookDependencies) {
  const rawHashes = new WeakMap<object, string>();
  const app = Fastify({
    loggerInstance: dependencies.logger ?? pino(),
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: BODY_LIMIT,
  });

  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (request, body, done) => {
    try {
      const raw = body as Buffer;
      const parsed = parseMaxJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      rawHashes.set(request, createHash('sha256').update(raw).digest('hex'));
      done(null, parsed);
    }
    catch { done(new InvalidMaxUpdateError()); }
  });

  app.setErrorHandler((error, request, reply) => {
    const errorStatus = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const status = error instanceof InvalidMaxUpdateError || errorStatus === 400 || errorStatus === 413 || errorStatus === 415 ? 400 : 503;
    app.log.info({ code: status === 400 ? 'max_webhook_invalid_body' : 'max_webhook_failure', correlationId: request.id });
    reply.code(status).send({ code: status === 400 ? 'invalid_body' : 'temporarily_unavailable' });
  });

  app.post('/webhooks/max', {
    onRequest: async (request, reply) => {
      const supplied = request.headers['x-max-bot-api-secret'];
      const candidate = typeof supplied === 'string' ? supplied : '';
      if (!sameSecret(candidate, dependencies.secret) || typeof supplied !== 'string') {
        app.log.info({ code: 'max_webhook_unauthorized', correlationId: request.id });
        reply.code(401).send({ code: 'unauthorized' });
      }
    },
  }, async (request, reply) => {
    let event: ReturnType<typeof mapMaxUpdate>;
    try { event = mapMaxUpdate(request.body); }
    catch (error) {
      if (error instanceof InvalidMaxUpdateError) {
        app.log.info({ code: 'max_webhook_invalid_body', correlationId: request.id });
        return reply.code(400).send({ code: 'invalid_body' });
      }
      throw error;
    }
    if (event.status === 'ignored') {
      app.log.info({ code: 'max_webhook_ignored', correlationId: request.id });
      return reply.code(200).send({ code: 'ok' });
    }
    if (await dependencies.restoreFence()) {
      app.log.info({ code: 'max_webhook_fenced', correlationId: request.id });
      return reply.code(503).send({ code: 'temporarily_unavailable' });
    }
    await dependencies.intake(event, rawHashes.get(request)!);
    app.log.info({ code: 'max_webhook_accepted', correlationId: request.id });
    return reply.code(200).send({ code: 'ok' });
  });

  return app;
}
