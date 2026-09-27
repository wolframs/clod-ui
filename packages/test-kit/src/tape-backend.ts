import { readFile } from 'node:fs/promises';

import type { BackendEvent, ClaudeBackend, HealthStatus, TurnRequest } from '@clod-ui/backend';

import type { FakeClock } from './clock.ts';

/**
 * Tape file shape. Recorded by `record-tape` (see bin/record-tape.ts) against
 * a real `claude -p` invocation.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr1-foundation-v2.md Task 6.5.
 */
export interface CliTape {
  cc_version: string;
  recorded_at: number;
  argv: string[];
  env_redacted: Record<string, string>;
  stdin_b64: string;
  events: Array<{ ts_ms: number; line: string }>;
  stderr: Array<{ ts_ms: number; line: string }>;
  exit_code: number;
}

export interface TapeBackendOptions {
  clock?: FakeClock;
  /** Flag names where our new argv may differ from the tape's without failing the check. */
  allowArgvDeltas?: string[];
  /** Version to return from `version()`. Defaults to the tape's `cc_version`. */
  version?: string;
  /** Health status to return. */
  health?: HealthStatus;
}

export class TapeArgvMismatchError extends Error {
  constructor(
    message: string,
    readonly expected: string[],
    readonly actual: string[],
  ) {
    super(message);
    this.name = 'TapeArgvMismatchError';
  }
}

/**
 * Replays a recorded tape. Validates that the current flag composer's argv is
 * compatible with the recorded argv (modulo explicitly-allowed deltas). Under a
 * FakeClock, event timings advance the clock; without one, they sleep real-time.
 */
export class TapeBackend implements ClaudeBackend {
  private readonly tape: CliTape;
  private readonly options: TapeBackendOptions;
  private readonly cancelled = new Set<string>();

  constructor(tape: CliTape, options: TapeBackendOptions = {}) {
    this.tape = tape;
    this.options = options;
  }

  static async load(path: string, options: TapeBackendOptions = {}): Promise<TapeBackend> {
    const raw = await readFile(path, 'utf8');
    const tape = JSON.parse(raw) as CliTape;
    return new TapeBackend(tape, options);
  }

  /**
   * Validate a candidate argv against the tape's recorded argv. Returns true
   * iff every non-allowed flag matches; throws `TapeArgvMismatchError` otherwise.
   */
  validateArgv(actual: string[]): true {
    const expected = this.tape.argv;
    const allow = new Set(this.options.allowArgvDeltas ?? []);
    const actualFiltered = stripAllowedFlags(actual, allow);
    const expectedFiltered = stripAllowedFlags(expected, allow);
    if (!arraysEqual(actualFiltered, expectedFiltered)) {
      throw new TapeArgvMismatchError(
        `tape argv mismatch: expected ${JSON.stringify(expectedFiltered)} got ${JSON.stringify(
          actualFiltered,
        )}`,
        expectedFiltered,
        actualFiltered,
      );
    }
    return true;
  }

  async *startTurn(req: TurnRequest): AsyncIterable<BackendEvent> {
    let lastTs = 0;
    for (const { ts_ms, line } of this.tape.events) {
      if (this.cancelled.has(req.turn_id)) return;
      const delta = Math.max(0, ts_ms - lastTs);
      lastTs = ts_ms;
      if (delta > 0) {
        if (this.options.clock) {
          this.options.clock.tick(delta);
        } else {
          await new Promise<void>((r) => setTimeout(r, delta));
        }
      }
      const parsed = tryParseNdjson(line);
      if (!parsed) continue;
      const mapped = mapRawEventToBackendEvent(parsed, req.turn_id);
      if (mapped) yield mapped;
    }
  }

  async cancel(turnId: string): Promise<void> {
    this.cancelled.add(turnId);
  }

  async version(): Promise<string> {
    return this.options.version ?? this.tape.cc_version;
  }

  async health(): Promise<HealthStatus> {
    return this.options.health ?? { cli: 'ok', version: this.tape.cc_version };
  }
}

function stripAllowedFlags(argv: string[], allow: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok == null) continue;
    if (allow.has(tok)) {
      // skip the flag and, heuristically, its value if present
      const next = argv[i + 1];
      if (next != null && !next.startsWith('-')) i++;
      continue;
    }
    out.push(tok);
  }
  return out;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function tryParseNdjson(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Minimal mapping from raw Claude Code stream-json lines to our BackendEvent
 * shape. Extended in Phase 2 as the real parser lands. PR #1 only exercises
 * the shapes used by the test-kit's hand-authored fixture.
 */
function mapRawEventToBackendEvent(
  raw: Record<string, unknown>,
  turnId: string,
): BackendEvent | null {
  const kind = raw['type'];
  if (typeof kind !== 'string') return null;
  switch (kind) {
    case 'system.init':
      return {
        kind: 'system.init',
        turn_id: turnId,
        session_id: String(raw['session_id'] ?? ''),
      };
    case 'assistant.delta':
      return {
        kind: 'assistant.delta',
        turn_id: turnId,
        text: String(raw['text'] ?? ''),
      };
    case 'turn.result':
      return { kind: 'turn.result', turn_id: turnId };
    default:
      return null;
  }
}
