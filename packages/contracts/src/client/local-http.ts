/**
 * `LocalHttpTransport` — concrete `Transport` over `fetch` + `WebSocket`.
 *
 * Targets a Bun.serve engine reachable at `baseUrl` (default
 * `http://127.0.0.1:<port>`). Resolves the WS URL by swapping the scheme
 * (`http` → `ws`, `https` → `wss`).
 *
 * Subscribe semantics include reconnect-and-resume. The transport tracks
 * the highest `envelope.id` it has received and, on a non-clean close,
 * schedules a reconnect with exponential backoff. Each reconnect re-opens
 * the WS with `?since=<lastEventId>` appended to the URL so the engine
 * can replay missed envelopes from its replay buffer.
 *
 * Spec: plans/landed/2026-04-28-clod-ui-pr13-typed-client-v1.md §3,
 *       plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §5.
 */
import { EventEnvelopeSchema } from '../event-envelope.ts';
import { REPLAY_START_SENTINEL_ID } from '../replay.ts';

import { ClientError } from './errors.ts';
import type {
  SubscribeOptions,
  Subscription,
  Transport,
  TransportRequestOptions,
  TransportResponse,
} from './transport.ts';

/** Default backoff schedule (ms). After the last entry, the cap is reused. */
const DEFAULT_BACKOFF_MS = [250, 500, 1000, 2000, 5000];

export interface LocalHttpTransportOptions {
  /** e.g. `http://127.0.0.1:5174` (no trailing slash required). */
  baseUrl: string;
  /** Optional overrides for tests / non-browser runtimes. */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
}

export class LocalHttpTransport implements Transport {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly WebSocketCtor: typeof WebSocket;

  constructor(opts: LocalHttpTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const wsCtor = opts.WebSocket ?? globalThis.WebSocket;
    if (typeof wsCtor !== 'function') {
      throw new Error('LocalHttpTransport: no WebSocket constructor available');
    }
    this.WebSocketCtor = wsCtor;
  }

  async request(opts: TransportRequestOptions): Promise<TransportResponse> {
    const url = this.baseUrl + opts.path;
    const init: RequestInit = { method: opts.method };
    if (opts.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal !== undefined) init.signal = opts.signal;
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      throw new ClientError({
        kind: 'transport',
        message: `request to ${opts.path} failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
        path: opts.path,
      });
    }
    let body: unknown;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
    }
    return { ok: res.ok, status: res.status, body };
  }

  subscribe(opts: SubscribeOptions): Subscription {
    const reconnectCfg = opts.reconnect === false ? null : (opts.reconnect ?? {});
    const backoffMs = reconnectCfg?.backoffMs ?? DEFAULT_BACKOFF_MS;
    const maxAttempts = reconnectCfg?.maxAttempts ?? Infinity;
    const scheduler = opts.scheduler ?? {
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
    };

    /** Highest real envelope id received so far. Sentinel ids are ignored. */
    let lastEventId: string | null = opts.since ?? null;
    /** Current attempt count (resets to 0 on successful open). */
    let attempt = 0;
    /** Active socket; replaced on each reconnect. */
    let activeWs: WebSocket | null = null;
    /** Pending reconnect timer handle, if any. */
    let pendingTimer: unknown = null;
    /** Set once the consumer calls `subscription.close()`. */
    let closed = false;

    const open = (): void => {
      if (closed) return;
      const wsUrl = this.toWsUrl(opts.path, lastEventId);
      const ws = new this.WebSocketCtor(wsUrl);
      activeWs = ws;
      ws.addEventListener('open', () => {
        attempt = 0;
        opts.onOpen?.();
      });
      ws.addEventListener('message', (msg: MessageEvent) => {
        const data = typeof msg.data === 'string' ? msg.data : '';
        if (!data) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        const envelope = EventEnvelopeSchema.safeParse(parsed);
        if (!envelope.success) return;
        const env = envelope.data;
        // Update lastEventId only for non-sentinel ids that are strictly
        // greater than the current cursor. This keeps the resume cursor
        // monotonic even if the engine ever reorders or repeats.
        if (env.id !== REPLAY_START_SENTINEL_ID && (lastEventId === null || env.id > lastEventId)) {
          lastEventId = env.id;
        }
        opts.onEnvelope(env);
      });
      ws.addEventListener('close', (ev: CloseEvent) => {
        activeWs = null;
        opts.onClose?.({ code: ev.code, reason: ev.reason });
        if (closed) return;
        // 1000 = clean close (consumer-initiated or server graceful). Don't
        // reconnect on a clean close — the consumer wanted out.
        if (ev.code === 1000) return;
        if (reconnectCfg === null) return;
        if (attempt >= maxAttempts) return;
        const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 5000;
        attempt += 1;
        pendingTimer = scheduler.setTimeout(() => {
          pendingTimer = null;
          open();
        }, delay);
      });
      ws.addEventListener('error', () => {
        opts.onError?.(new Error('WebSocket transport error'));
      });
    };

    open();

    return {
      close: () => {
        closed = true;
        if (pendingTimer !== null) {
          scheduler.clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        if (activeWs !== null) {
          try {
            activeWs.close(1000, 'consumer closed');
          } catch {
            // best-effort
          }
          activeWs = null;
        }
      },
    };
  }

  private toWsUrl(path: string, sinceId: string | null): string {
    const wsBase = this.baseUrl.replace(/^http(s?):\/\//, 'ws$1://');
    if (sinceId === null) return wsBase + path;
    const sep = path.includes('?') ? '&' : '?';
    return `${wsBase}${path}${sep}since=${encodeURIComponent(sinceId)}`;
  }
}
