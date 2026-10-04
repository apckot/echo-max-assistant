import { OutboundMessageDraftSchema } from '../../modules/delivery/domain/outbound-message.js';
import type { OutboundSender, SendOutcome } from '../../modules/delivery/application/sender.js';

const invalidUnicode = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const invalidConfiguration = (): never => { throw new Error('invalid_max_sender_configuration'); };

export interface MaxSenderOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

function validRecipient(value: string): boolean {
  if (typeof value !== 'string' || value.length > (value.startsWith('-') ? 20 : 19)) return false;
  if (!/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(value)) return false;
  const id = BigInt(value);
  return id >= -(1n << 63n) && id <= (1n << 63n) - 1n;
}

function retryAfter(value: string | null): number | 'unschedulable' | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const millis = Number(trimmed) * 1000;
    return Number.isSafeInteger(millis) && Date.now() + millis <= 8640000000000000 ? millis : 'unschedulable';
  }
  // Accept HTTP-date shapes only; Date.parse also accepts malformed numeric seconds.
  if (!/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  const delay = Math.max(0, date - Date.now());
  return Number.isSafeInteger(delay) ? delay : undefined;
}

function preconnectionFailure(error: unknown): boolean {
  const visited = new Set<object>();
  function proven(value: unknown): boolean {
    if (!value || typeof value !== 'object' || visited.has(value) || visited.size >= 32) return false;
    visited.add(value);
    if (value instanceof AggregateError) {
      const errors: unknown = value.errors;
      if (!Array.isArray(errors)) return false;
      const length = errors.length;
      if (!Number.isInteger(length) || length <= 0 || length > 32) return false;
      for (let index = 0; index < length; index++) if (!proven(errors[index])) return false;
      return true;
    }
    const candidate = value as { code?: unknown; cause?: unknown; syscall?: unknown };
    if (candidate.code === 'ECONNREFUSED' && candidate.syscall === 'connect') return true;
    if ((candidate.code === 'ENOTFOUND' || candidate.code === 'EAI_AGAIN') && candidate.syscall === 'getaddrinfo') return true;
    return proven(candidate.cause);
  }
  try { return proven(error); } catch { return false; }
}

async function boundedBody(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function createMaxSender(options: MaxSenderOptions): OutboundSender {
  if (!options || typeof options.token !== 'string' || !options.token || /[\u0000-\u001f\u007f]/.test(options.token)) invalidConfiguration();
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
  if (![timeoutMs, maxResponseBytes].every((value) => Number.isSafeInteger(value) && value > 0) || timeoutMs > 2147483647) invalidConfiguration();
  let base: URL | undefined;
  try { base = new URL(options.baseUrl ?? 'https://platform-api2.max.ru'); }
  catch { invalidConfiguration(); }
  if (!base || base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)))) invalidConfiguration();
  const fetcher = options.fetchImpl ?? fetch;
  return {
    async send(recipientAddress, message): Promise<SendOutcome> {
      const parsed = OutboundMessageDraftSchema.safeParse(message);
      if (!validRecipient(recipientAddress) || !parsed.success || invalidUnicode.test(parsed.data.text) || [...parsed.data.text].length > 4000) {
        return { status: 'not_sent', code: 'invalid_input', retryable: false };
      }
      const url = new URL('/messages', base);
      url.searchParams.set('user_id', recipientAddress);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response | undefined;
      try {
        response = await fetcher(url, {
          method: 'POST', headers: { Authorization: options.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: parsed.data.text }), redirect: 'manual', signal: controller.signal,
        });
        if (response.status === 429) {
          const delay = retryAfter(response.headers.get('retry-after'));
          if (delay === 'unschedulable') return { status: 'not_sent', code: 'rate_limit_unschedulable', retryable: false };
          return { status: 'not_sent', code: 'rate_limited', retryable: true, ...(delay === undefined ? {} : { retryAfterMs: delay }) };
        }
        if ([400, 401, 403, 404, 405].includes(response.status)) return { status: 'not_sent', code: 'rejected', retryable: false };
        if (response.status >= 500 && response.status <= 599) return { status: 'uncertain', code: 'server_failure' };
        if (response.status !== 200) return { status: 'uncertain', code: 'unexpected_status' };
        const body = await boundedBody(response, maxResponseBytes);
        if (body === null) return { status: 'uncertain', code: 'response_too_large' };
        let value: unknown;
        try { value = JSON.parse(body); } catch { return { status: 'uncertain', code: 'invalid_response' }; }
        const mid = (value as { message?: { body?: { mid?: unknown } } } | null)?.message?.body?.mid;
        if (typeof mid !== 'string' || !mid || invalidUnicode.test(mid)) return { status: 'uncertain', code: 'invalid_response' };
        return { status: 'sent', externalMessageId: mid };
      } catch (error) {
        if (controller.signal.aborted) return { status: 'uncertain', code: 'timeout' };
        if (!response && preconnectionFailure(error)) return { status: 'not_sent', code: 'preconnection_failure', retryable: true };
        return { status: 'uncertain', code: 'transport_failure' };
      } finally {
        clearTimeout(timer);
        // Abort unread bodies immediately; never await a potentially unbounded drain.
        controller.abort();
        if (response && response.status !== 200) {
          try { void response.body?.cancel().catch(() => undefined); } catch { /* cleanup cannot change certainty */ }
        }
      }
    },
  };
}
