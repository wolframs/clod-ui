/**
 * Transport adapter — the seam between the typed client and the wire.
 *
 * Concrete implementations: `LocalHttpTransport` (this package), future
 * `RemoteWS`. Tests inject a `FakeTransport` to exercise the client without
 * any network.
 *
 * Spec: plans/landed/2026-04-28-clod-ui-pr13-typed-client-v1.md §3.
 */
import type { EventEnvelope } from '../event-envelope.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface TransportRequestOptions {
  method: HttpMethod;
  /** Path relative to the engine, e.g. `/health`, `/settings`, `/conversations`. */
  path: string;
  /** JSON-serializable body. Sent only on POST/PUT/PATCH. */
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * HTTP response surface returned by the transport. The transport is
 * responsible for parsing the body but not for validating it — the client
 * runs the Zod schema check itself so schema errors carry `kind: 'schema'`
 * instead of `kind: 'transport'`.
 */
export interface TransportResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON body if Content-Type was `application/json`, else `undefined`. */
  body: unknown;
}

export interface SubscribeOptions {
  /** WS path, conventionally `/ws`. */
  path: string;
  /** Receives every successfully-parsed-and-validated envelope. */
  onEnvelope: (env: EventEnvelope) => void;
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason: string }) => void;
  /**
   * Receives transport-level errors only. Per-envelope parse failures are
   * silent (matches the TypedTestClient precedent — the wire is allowed to
   * carry envelopes from a future engine version that the client doesn't
   * understand yet, and that must not blow up the consumer).
   */
  onError?: (err: Error) => void;
  /**
   * Reconnect-and-resume policy. Default: enabled, exponential backoff
   * `[250, 500, 1000, 2000, 5000]` ms (capped at 5000 for further attempts).
   * Set to `false` to disable reconnects (clean close behaves the same).
   *
   * Spec: plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §5.
   */
  reconnect?:
    | false
    | {
        backoffMs?: number[];
        maxAttempts?: number;
      };
  /**
   * Initial replay cursor — an envelope `id` value. When provided, the
   * transport opens with `?since=<value>` so the engine replays buffered
   * envelopes whose `id` is lexicographically greater than `since` before
   * delivering live ones. Subsequent reconnects use the largest `id`
   * observed so far (or this value if none seen yet).
   */
  since?: string;
  /**
   * Optional clock injection for tests. The transport calls this to schedule
   * reconnect attempts; tests substitute a manual scheduler so attempts are
   * deterministic.
   */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export interface Subscription {
  close(): void;
}

export interface Transport {
  request(opts: TransportRequestOptions): Promise<TransportResponse>;
  subscribe(opts: SubscribeOptions): Subscription;
}
