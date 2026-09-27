import { EventEnvelopeSchema } from '@clod-ui/contracts';
import type { EventEnvelope, HealthResponse } from '@clod-ui/contracts';

/**
 * Typed HTTP + WS client used by L3 spine tests. Targets `MockEngineServer`
 * in PR #1; in Phase 2 it will point at `apps/engine` with the same contract.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr1-foundation-v2.md Task 6.7.
 */
export interface TypedTestClientOptions {
  baseUrl: string;
  wsUrl?: string;
}

export interface SubmitTurnInput {
  conv_id: string;
  turn_id: string;
  user_message: string;
  model?: string;
  cwd?: string;
}

export interface EventMatcher {
  kind?: string;
  conv_id?: string;
  predicate?: (envelope: EventEnvelope) => boolean;
}

export class TypedTestClient {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private ws?: WebSocket;
  private readonly buffers = new Map<string, EventEnvelope[]>();
  private readonly waiters: Array<{
    matcher: EventMatcher;
    resolve: (env: EventEnvelope) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(opts: TypedTestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.wsUrl = opts.wsUrl ?? this.baseUrl.replace(/^http/, 'ws') + '/ws';
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      const onOpen = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        resolve();
      };
      const onError = (ev: Event) => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        reject(new Error(`ws connect failed: ${String(ev)}`));
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
    this.ws.addEventListener('message', (msg) => {
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
      this.onEnvelope(envelope.data);
    });
  }

  async close(): Promise<void> {
    this.ws?.close();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('client closed'));
    }
    this.waiters.length = 0;
  }

  async health(): Promise<HealthResponse> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`/health returned ${res.status}`);
    return (await res.json()) as HealthResponse;
  }

  async submitTurn(input: SubmitTurnInput): Promise<void> {
    const res = await fetch(`${this.baseUrl}/conversations/${input.conv_id}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        turn_id: input.turn_id,
        user_message: input.user_message,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      }),
    });
    if (!res.ok) throw new Error(`submitTurn failed: ${res.status}`);
  }

  async cancelTurn(convId: string, turnId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/conversations/${convId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn_id: turnId }),
    });
    if (!res.ok) throw new Error(`cancelTurn failed: ${res.status}`);
  }

  /** Await the next envelope that matches. `timeout` defaults to 2000ms. */
  awaitEvent(matcher: EventMatcher, opts: { timeout?: number } = {}): Promise<EventEnvelope> {
    const timeout = opts.timeout ?? 2000;
    return new Promise<EventEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`awaitEvent timed out after ${timeout}ms`));
      }, timeout);
      this.waiters.push({ matcher, resolve, reject, timer });
      // If a matching envelope was buffered, fire immediately.
      this.drainWaiters();
    });
  }

  recordEvents(convId: string): EventEnvelope[] {
    const arr = this.buffers.get(convId);
    return arr ? [...arr] : [];
  }

  private onEnvelope(envelope: EventEnvelope): void {
    if (envelope.conv_id) {
      let arr = this.buffers.get(envelope.conv_id);
      if (!arr) {
        arr = [];
        this.buffers.set(envelope.conv_id, arr);
      }
      arr.push(envelope);
    }
    this.drainWaiters();
  }

  private drainWaiters(): void {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (!w) continue;
      // Match against the most recent envelope first for each waiter.
      // We scan all buffers; tests rarely have more than a handful of conversations.
      let matched: EventEnvelope | undefined;
      for (const arr of this.buffers.values()) {
        for (const env of arr) {
          if (matchesEnvelope(env, w.matcher)) {
            matched = env;
            break;
          }
        }
        if (matched) break;
      }
      if (matched) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(matched);
      }
    }
  }
}

function matchesEnvelope(env: EventEnvelope, m: EventMatcher): boolean {
  if (m.kind != null && env.kind !== m.kind) return false;
  if (m.conv_id != null && env.conv_id !== m.conv_id) return false;
  if (m.predicate && !m.predicate(env)) return false;
  return true;
}
