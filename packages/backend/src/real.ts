import { classifyCliFailure } from './classify-error.ts';
import { compose } from './compose.ts';
import { parseStreamJsonLine } from './parse-stream-json.ts';
import type {
  BackendEvent,
  BackendOptions,
  ClaudeBackend,
  HealthStatus,
  TurnRequest,
} from './types.ts';

/**
 * Real Claude Code CLI backend.
 *
 * PR #2: `health()` + `version()` with a background probe.
 * PR #4: `startTurn()` spawns the real CLI with composed flags, pipes the
 * stream-JSON stdin, reads NDJSON stdout, and yields parsed `BackendEvent`s.
 * `cancel()` sends SIGTERM to the subprocess's process group (minimal — the
 * full SIGINT → SIGTERM → SIGKILL ladder lands in PR #5).
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr2-health-probe-v1.md (§1)
 *       plans/landed/2026-04-23-clod-ui-pr4-real-startturn-v1.md (§3)
 *       plans/2026-04-23-clod-ui-architecture-v2.md Task 2.3 (full) + 2.7 (health wiring)
 */

export interface RealClaudeBackendOptions extends BackendOptions {
  /** Interval (ms) between background probe refreshes once started. Default 5000. */
  refreshIntervalMs?: number;
  /** Max wall-time (ms) for a single `claude --version` spawn. Default 3000. */
  probeTimeoutMs?: number;
  /**
   * Maximum age (ms) of the cached probe before `health()` triggers a
   * fire-and-forget refresh. Default = `refreshIntervalMs`.
   */
  staleAfterMs?: number;
  /**
   * Regex applied to stdout; the first capture group becomes `version`.
   * Default matches strings like `2.1.118 (Claude Code)`.
   */
  versionRegex?: RegExp;
  /**
   * Milliseconds between SIGINT (initial cancel) and SIGTERM escalation. Default 500.
   */
  graceTermMs?: number;
  /**
   * Milliseconds between SIGTERM and SIGKILL escalation. Default 500.
   */
  graceKillMs?: number;
}

const DEFAULT_REFRESH_MS = 5000;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_VERSION_REGEX = /^\s*(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/;
const DEFAULT_GRACE_TERM_MS = 500;
const DEFAULT_GRACE_KILL_MS = 500;

type Escalation = 'sigint' | 'sigterm' | 'sigkill';

interface ActiveTurn {
  proc: ReturnType<typeof Bun.spawn>;
  cancelRequested: boolean;
  escalation: Escalation | null;
  graceTermTimer: ReturnType<typeof setTimeout> | null;
  graceKillTimer: ReturnType<typeof setTimeout> | null;
}

export class RealClaudeBackend implements ClaudeBackend {
  private readonly binary: string;
  private readonly spawnEnv: Record<string, string>;
  private readonly refreshIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly versionRegex: RegExp;
  private readonly graceTermMs: number;
  private readonly graceKillMs: number;

  private cached: HealthStatus = { cli: 'missing' };
  private cachedAt = 0;
  private refreshInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Active turns, keyed by turn_id → active-turn state. Used by cancel(). */
  private readonly active = new Map<string, ActiveTurn>();

  constructor(opts: RealClaudeBackendOptions = {}) {
    this.binary = opts.claudeBinary ?? 'claude';
    // Build a scrubbed copy of process.env so undefineds are filtered out,
    // then overlay explicit opts.env.
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') base[k] = v;
    }
    this.spawnEnv = { ...base, ...(opts.env ?? {}) };
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.staleAfterMs = opts.staleAfterMs ?? this.refreshIntervalMs;
    this.versionRegex = opts.versionRegex ?? DEFAULT_VERSION_REGEX;
    this.graceTermMs = opts.graceTermMs ?? DEFAULT_GRACE_TERM_MS;
    this.graceKillMs = opts.graceKillMs ?? DEFAULT_GRACE_KILL_MS;
  }

  /**
   * Begin the background refresh loop. Also kicks an immediate probe so that
   * `/health` reports a fresh value quickly after engine startup.
   *
   * Idempotent: calling `start()` twice is a no-op.
   */
  start(): void {
    if (this.timer !== null) return;
    // Fire the first probe asynchronously; don't block caller.
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
    // Allow the process to exit even if the timer is still live.
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Stop the refresh loop and await any in-flight probe. Idempotent. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.refreshInFlight) {
      await this.refreshInFlight.catch(() => {
        /* swallow; we're shutting down */
      });
    }
  }

  /**
   * Return the currently-cached health. If the cache is empty or stale, kick
   * a refresh in the background — but do not await it. The contract is that
   * this method resolves within microseconds, never blocked on CLI I/O.
   */
  async health(): Promise<HealthStatus> {
    const age = Date.now() - this.cachedAt;
    if (this.cachedAt === 0 || age > this.staleAfterMs) {
      void this.refresh();
    }
    return this.cached;
  }

  async version(): Promise<string> {
    if (this.cached.cli === 'ok' && this.cached.version) return this.cached.version;
    // Force a fresh probe if we don't have a version yet.
    await this.refresh();
    if (this.cached.cli === 'ok' && this.cached.version) return this.cached.version;
    throw new Error(`claude CLI not available (cli=${this.cached.cli})`);
  }

  /**
   * Spawn `claude -p --output-format stream-json --verbose ...` with the
   * composed argv, pipe our stream-JSON stdin in, and yield parsed
   * `BackendEvent`s as NDJSON lines arrive on stdout. Terminator semantics:
   *
   *  - A normal `turn.result` or stream-JSON-originated `turn.error` wins.
   *  - If the subprocess exits without a terminator AND cancel was requested,
   *    emit `turn.cancelled{escalation}` (escalation = highest signal sent).
   *  - If the subprocess exits without a terminator and cancel was NOT
   *    requested, emit a `turn.error` classified by `classifyCliFailure`.
   *
   * Detached (`detached: true`) so every turn has its own process group and
   * `cancel` can `kill(-pgid, sig)` the whole tree.
   */
  async *startTurn(req: TurnRequest): AsyncIterable<BackendEvent> {
    // Short-circuit if the last probe said `missing`. We do NOT re-probe here
    // — health() runs on its own refresh loop.
    if (this.cached.cli === 'missing') {
      yield {
        kind: 'turn.error',
        turn_id: req.turn_id,
        error: {
          kind: 'cli_missing',
          retryable: false,
          detail: `claude binary not found at ${this.binary}`,
        },
      };
      return;
    }

    const composed = compose(req, { claudeBinary: this.binary });
    const mergedEnv: Record<string, string> = { ...this.spawnEnv, ...composed.env };

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(composed.argv, {
        cwd: composed.cwd,
        env: mergedEnv,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        // macOS/Linux: new process group, so kill(-pgid) reaches the whole tree.
        // Bun honors `detached` on Unix.
        ...({ detached: true } as Record<string, unknown>),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      yield {
        kind: 'turn.error',
        turn_id: req.turn_id,
        error: {
          kind: code === 'ENOENT' ? 'cli_missing' : 'cli_crashed',
          retryable: true,
          detail: err instanceof Error ? err.message : String(err),
        },
      };
      return;
    }

    const turnState: ActiveTurn = {
      proc,
      cancelRequested: false,
      escalation: null,
      graceTermTimer: null,
      graceKillTimer: null,
    };
    this.active.set(req.turn_id, turnState);

    // Write the stream-JSON stdin payload and close the pipe so the CLI
    // sees EOF and begins the turn.
    try {
      const writer = proc.stdin as unknown as {
        write: (chunk: Uint8Array) => unknown;
        end: () => unknown;
      };
      await Promise.resolve(writer.write(composed.stdin));
      await Promise.resolve(writer.end());
    } catch {
      // stdin write errors usually indicate the child died before we got
      // here; the stdout reader + exit handling will surface the real error.
    }

    const stderrChunks: string[] = [];
    const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
    const stderrDone = drainStream(stderrStream, (chunk) => stderrChunks.push(chunk));

    let terminated = false;
    let lastResultSubtype: string | undefined;
    try {
      const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
      for await (const line of readLines(stdoutStream)) {
        const parsed = parseStreamJsonLine(line);
        for (const ev of parsed) {
          // Intercept parser-coarse turn.error and refine with stderr classifier.
          if (ev.kind === 'turn.error') {
            terminated = true;
            const refined = classifyCliFailure({
              raw_stderr: stderrChunks.join(''),
              ...(lastResultSubtype !== undefined ? { cli_subtype: lastResultSubtype } : {}),
            });
            yield {
              kind: 'turn.error',
              turn_id: req.turn_id,
              error: refined,
            };
            continue;
          }
          if (ev.kind === 'turn.result') {
            terminated = true;
            yield { ...ev, turn_id: req.turn_id } as BackendEvent;
            continue;
          }
          // Track the latest result subtype for classifier (set by parser via
          // an unofficial side-channel in the raw line — we parse here again).
          const subtypeMatch = /"subtype"\s*:\s*"([^"]+)"/.exec(line);
          if (subtypeMatch !== null && line.includes('"type":"result"')) {
            lastResultSubtype = subtypeMatch[1];
          }
          yield { ...ev, turn_id: req.turn_id } as BackendEvent;
        }
      }

      const exitCode = await proc.exited;
      await stderrDone;
      if (!terminated) {
        const raw = stderrChunks.join('');
        if (turnState.cancelRequested && turnState.escalation !== null) {
          yield {
            kind: 'turn.cancelled',
            turn_id: req.turn_id,
            escalation: turnState.escalation,
          };
        } else {
          const refined = classifyCliFailure({
            raw_stderr: raw,
            ...(typeof exitCode === 'number' ? { exit_code: exitCode } : {}),
            ...(lastResultSubtype !== undefined ? { cli_subtype: lastResultSubtype } : {}),
          });
          yield {
            kind: 'turn.error',
            turn_id: req.turn_id,
            error: refined,
          };
        }
      }
    } finally {
      if (turnState.graceTermTimer !== null) clearTimeout(turnState.graceTermTimer);
      if (turnState.graceKillTimer !== null) clearTimeout(turnState.graceKillTimer);
      this.active.delete(req.turn_id);
    }
  }

  /**
   * Cancel a live turn with a SIGINT → SIGTERM → SIGKILL escalation ladder.
   *
   *   t=0         → SIGINT
   *   t=graceTermMs   → SIGTERM (if still alive)
   *   t=graceTermMs + graceKillMs → SIGKILL (if still alive)
   *
   * Idempotent: a second `cancel(turnId)` call on the same turn is a silent
   * no-op. `cancel(turnId)` for an unknown turn is a silent no-op.
   *
   * Each signal is delivered to the subprocess's process group
   * (negative pid) since we spawn `detached: true`. On pgid-kill failure
   * we fall back to `proc.kill(sig)` against the direct child.
   */
  async cancel(turnId: string): Promise<void> {
    const turn = this.active.get(turnId);
    if (!turn) return;
    if (turn.cancelRequested) return;
    turn.cancelRequested = true;

    sendSignal(turn.proc, 'SIGINT');
    turn.escalation = 'sigint';

    turn.graceTermTimer = setTimeout(() => {
      if (!this.active.has(turnId)) return;
      sendSignal(turn.proc, 'SIGTERM');
      turn.escalation = 'sigterm';
    }, this.graceTermMs);

    turn.graceKillTimer = setTimeout(() => {
      if (!this.active.has(turnId)) return;
      sendSignal(turn.proc, 'SIGKILL');
      turn.escalation = 'sigkill';
    }, this.graceTermMs + this.graceKillMs);

    // Allow the event loop to exit even if the timers outlive the process.
    if (typeof (turn.graceTermTimer as { unref?: () => void }).unref === 'function') {
      (turn.graceTermTimer as { unref: () => void }).unref();
    }
    if (typeof (turn.graceKillTimer as { unref?: () => void }).unref === 'function') {
      (turn.graceKillTimer as { unref: () => void }).unref();
    }
  }

  /** Expose cached-at for tests. */
  get lastProbedAt(): number {
    return this.cachedAt;
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        const result = await this.probe();
        this.cached = result;
        this.cachedAt = Date.now();
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  private async probe(): Promise<HealthStatus> {
    // If the binary isn't absolute and isn't on PATH (per spawnEnv), Bun.which
    // returns null — treat as `missing`. If an absolute path was supplied,
    // check existence by statting via `Bun.file(path).exists()`.
    const resolved = await this.resolveBinary();
    if (resolved === null) return { cli: 'missing' };

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([resolved, '--version'], {
        env: this.spawnEnv,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
    } catch (err) {
      // Belt-and-suspenders: if Bun surprises us with a sync throw, map ENOENT
      // to missing and everything else to crashed.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return { cli: 'missing' };
      return { cli: 'crashed' };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, this.probeTimeoutMs);

    // With `stdout: 'pipe'` Bun returns a ReadableStream<Uint8Array>; the
    // broader union on the type is for other stdio modes we don't use.
    const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
    const [stdout, exitCode] = await Promise.all([
      new Response(stdoutStream).text().catch(() => ''),
      proc.exited,
    ]);
    clearTimeout(timer);

    if (timedOut) return { cli: 'crashed' };
    if (exitCode !== 0) return { cli: 'crashed' };

    const match = this.versionRegex.exec(stdout.trim());
    const version = match?.[1];
    if (!version) return { cli: 'crashed' };
    return { cli: 'ok', version };
  }

  private async resolveBinary(): Promise<string | null> {
    // Absolute path — just stat it.
    if (this.binary.startsWith('/')) {
      const exists = await Bun.file(this.binary).exists();
      return exists ? this.binary : null;
    }
    // Resolve against the probe's own env.PATH (not the process's).
    const path = this.spawnEnv['PATH'];
    const which = Bun.which(this.binary, path !== undefined ? { PATH: path } : undefined);
    return which;
  }
}

/**
 * Read a byte stream as UTF-8 and yield one line at a time.
 * Trailing partial line is emitted iff non-empty when the stream closes.
 */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.length > 0) yield buffer;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) yield line;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Drain a byte stream into UTF-8 chunks via a callback. Resolves on EOF. */
async function drainStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      onChunk(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Send `sig` to the subprocess's process group. Falls back to the direct
 * child on pgid-kill failure. All throws swallowed — cancel is best-effort.
 */
function sendSignal(proc: ReturnType<typeof Bun.spawn>, sig: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid, sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      // ignore — process already reaped
    }
  }
}
