/**
 * Per-turn diagnostics (Phase 5.7, PR #32) — bounded in-memory ring,
 * wire-only by I-8 (nothing here ever touches the manifest).
 *
 * Redaction happens at record time (D1): the ring never holds raw
 * system-prompt text, so no later surface (route, panel, repro export)
 * can leak it. Stdin is recorded as a byte count only — it carries the
 * user's message.
 */

/** `BackendEvent` minus `turn_id` — exactly what ScriptedBackend replays. */
export type PendingEvent = Record<string, unknown>;

export interface DiagnosticsEvent {
  ts: number;
  kind: string;
  event: PendingEvent;
}

export interface TurnOutcome {
  kind: 'result' | 'cancelled' | 'error';
  detail?: string;
}

export interface TurnDiagnostics {
  turn_id: string;
  conv_id: string;
  started_at: number;
  /** Redacted via `redactArgv` before storage. */
  argv: string[];
  env_keys: string[];
  stdin_bytes: number;
  cwd: string;
  /** PR #39: fresh spawn, or fed to the conversation's warm process. */
  process?: 'spawned' | 'reused';
  events: DiagnosticsEvent[];
  outcome?: TurnOutcome;
}

const REDACT_AFTER = new Set(['--system-prompt', '--append-system-prompt']);

/**
 * Replace the value following a system-prompt flag with a length-only
 * placeholder. Pure; the input array is not mutated.
 */
// TODO(redact-config): operator-configurable redaction for other flags
// that may carry secrets (e.g. custom extra_argv values).
export function redactArgv(argv: string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    if (REDACT_AFTER.has(out[i] as string)) {
      const value = out[i + 1] as string;
      out[i + 1] = `[redacted ${value.length} chars]`;
      i++;
    }
  }
  return out;
}

export interface DiagnosticsRingOptions {
  capacity?: number;
  now?: () => number;
}

const DEFAULT_CAPACITY = 50;

/** Bounded ring of per-turn diagnostics; oldest turn evicted first. */
export class DiagnosticsRing {
  private readonly capacity: number;
  private readonly now: () => number;
  /** Insertion-ordered: oldest first. */
  private readonly entries = new Map<string, TurnDiagnostics>();

  constructor(opts: DiagnosticsRingOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.now = opts.now ?? Date.now;
  }

  start(entry: {
    turn_id: string;
    conv_id: string;
    argv: string[];
    env: Record<string, string>;
    stdin_bytes: number;
    cwd: string;
    process?: 'spawned' | 'reused';
  }): void {
    const record: TurnDiagnostics = {
      turn_id: entry.turn_id,
      conv_id: entry.conv_id,
      started_at: this.now(),
      argv: redactArgv(entry.argv),
      env_keys: Object.keys(entry.env),
      stdin_bytes: entry.stdin_bytes,
      cwd: entry.cwd,
      ...(entry.process !== undefined ? { process: entry.process } : {}),
      events: [],
    };
    this.entries.delete(entry.turn_id);
    this.entries.set(entry.turn_id, record);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  addEvent(turn_id: string, event: { kind: string } & Record<string, unknown>): void {
    const entry = this.entries.get(turn_id);
    if (!entry) return;
    const { turn_id: _drop, ...pending } = event as { turn_id?: string } & Record<string, unknown>;
    entry.events.push({ ts: this.now(), kind: event.kind, event: pending });
  }

  finish(turn_id: string, outcome: TurnOutcome): void {
    const entry = this.entries.get(turn_id);
    if (!entry || entry.outcome) return; // first terminator wins
    entry.outcome = outcome;
  }

  /** Most recent first. */
  list(): TurnDiagnostics[] {
    return [...this.entries.values()].reverse();
  }
}
