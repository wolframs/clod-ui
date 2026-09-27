import type { BackendEvent, ClaudeBackend, HealthStatus, TurnRequest } from '@clod-ui/backend';

export interface ChaosConfig {
  /** Delay before first event of each turn. */
  startupDelayMs?: number;
  /** Extra jitter applied to each event (uniform [0, jitter]). */
  perEventJitterMs?: number;
  /** After N events, throw to simulate a crash mid-stream. */
  crashAfterEvents?: number;
  /** Mangle the last emitted event by dropping its last field key. */
  truncateLastLine?: boolean;
  /** For `refuseSigtermFor` ms, `cancel()` resolves but the stream keeps going. */
  refuseSigtermFor?: number;
  /** After cancellation is finally honored, delay `slowExitMs` before stopping. */
  slowExitMs?: number;
  /**
   * Escalation level reported in the `turn.cancelled` envelope emitted when
   * cancel is honored. Models what the corresponding subprocess ladder
   * would have reached. Defaults to `sigint`.
   */
  cancelEscalation?: 'sigint' | 'sigterm' | 'sigkill';
  /**
   * Optional sleep implementation. Defaults to real-time `setTimeout`. A
   * FakeClock-backed sleeper would call `clock.tick(ms)` synchronously.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic RNG for jitter. Defaults to Math.random. */
  rng?: () => number;
}

/**
 * Decorator wrapping any `ClaudeBackend` with controllable faults. Used by
 * chaos tests and the cancel-ladder spine tests.
 */
export class ChaosBackend implements ClaudeBackend {
  private readonly inner: ClaudeBackend;
  private readonly cfg: ChaosConfig;
  private readonly cancelState = new Map<string, { requestedAt: number; honored: boolean }>();

  constructor(inner: ClaudeBackend, cfg: ChaosConfig = {}) {
    this.inner = inner;
    this.cfg = cfg;
  }

  async *startTurn(req: TurnRequest): AsyncIterable<BackendEvent> {
    const sleep = this.cfg.sleep ?? defaultSleep;
    const rng = this.cfg.rng ?? Math.random;
    const escalation = this.cfg.cancelEscalation ?? 'sigint';

    // Startup delay is cancellable: wake early if cancel arrives.
    if (this.cfg.startupDelayMs) {
      const deadline = Date.now() + this.cfg.startupDelayMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        await sleep(Math.min(25, remaining));
        if (this.cancelState.has(req.turn_id)) {
          yield { kind: 'turn.cancelled', turn_id: req.turn_id, escalation } as BackendEvent;
          return;
        }
      }
    }

    let emitted = 0;
    let lastEvent: BackendEvent | null = null;

    for await (const ev of this.inner.startTurn(req)) {
      if (this.cfg.perEventJitterMs && this.cfg.perEventJitterMs > 0) {
        await sleep(Math.floor(rng() * this.cfg.perEventJitterMs));
      }

      if (this.cfg.crashAfterEvents != null && emitted >= this.cfg.crashAfterEvents) {
        throw new Error('ChaosBackend: simulated crash');
      }

      const cancelState = this.cancelState.get(req.turn_id);
      if (cancelState) {
        const elapsed = Date.now() - cancelState.requestedAt;
        if (this.cfg.refuseSigtermFor == null || elapsed >= this.cfg.refuseSigtermFor) {
          cancelState.honored = true;
          if (this.cfg.slowExitMs) await sleep(this.cfg.slowExitMs);
          yield { kind: 'turn.cancelled', turn_id: req.turn_id, escalation } as BackendEvent;
          return;
        }
      }

      emitted++;
      lastEvent = ev;
      yield ev;
    }

    // Inner iterator ended without us intercepting a cancel-honor — but the
    // cancel may have arrived during the last inner-event delay and caused
    // the inner backend to return silently. Emit a terminal turn.cancelled
    // in that case so the envelope contract is preserved.
    if (this.cancelState.has(req.turn_id) && !this.cancelState.get(req.turn_id)?.honored) {
      yield { kind: 'turn.cancelled', turn_id: req.turn_id, escalation } as BackendEvent;
      return;
    }

    // `truncateLastLine` is a write-side chaos — surfaced as a parse error via
    // emitting a malformed shape. We do it by re-yielding the last event with
    // a missing turn_id field, which downstream parsers will reject.
    if (this.cfg.truncateLastLine && lastEvent) {
      const { turn_id: _turn_id, ...rest } = lastEvent;
      yield rest as unknown as BackendEvent;
    }
  }

  async cancel(turnId: string): Promise<void> {
    this.cancelState.set(turnId, { requestedAt: Date.now(), honored: false });
    await this.inner.cancel(turnId);
  }

  async version(): Promise<string> {
    return this.inner.version();
  }

  async health(): Promise<HealthStatus> {
    return this.inner.health();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
