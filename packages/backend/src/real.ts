import { tmpdir } from 'node:os';

import type { ModelInfo } from '@clod-ui/contracts';

import { classifyCliFailure } from './classify-error.ts';
import { compose } from './compose.ts';
import type { ComposeResult } from './compose.ts';
import { controlResponseFor, initializeRequestLine, parseModelList } from './models.ts';
import { parseStreamJsonLine } from './parse-stream-json.ts';
import type {
  BackendEvent,
  BackendOptions,
  ClaudeBackend,
  HealthStatus,
  TurnRequest,
} from './types.ts';
import { warmReusable } from './warm-reuse.ts';
import type { NextTurnShape } from './warm-reuse.ts';

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
  /**
   * PR #39: keep a conversation's CLI process alive between turns and retire
   * it after this many idle milliseconds. 0 (default) = one process per turn.
   */
  warmIdleMs?: number;
  /**
   * PR #40: at most this many warm processes; at the cap the least recently
   * used idle one is retired, or the turn runs as a one-shot. Default 4.
   */
  warmMax?: number;
}

const DEFAULT_REFRESH_MS = 5000;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_VERSION_REGEX = /^\s*(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/;
const DEFAULT_GRACE_TERM_MS = 500;
const DEFAULT_GRACE_KILL_MS = 500;
/** Retirement ladder (PR #40 §1, PR #41): stdin EOF → group SIGTERM → group SIGKILL, ≈2.5s worst case. */
const RETIRE_EOF_MS = 1000;
const RETIRE_TERM_MS = 1000;
const RETIRE_KILL_MS = 500;
/** stderr kept per turn (the tail; PR #40 §5). */
const STDERR_CAP = 64 * 1024;
const DEFAULT_WARM_MAX = 4;
/** PR #42: how long a model list stays fresh, and how long one probe may take. */
const MODELS_TTL_MS = 10 * 60 * 1000;
const MODELS_PROBE_TIMEOUT_MS = 15_000;

type Escalation = 'sigint' | 'sigterm' | 'sigkill';

/**
 * One spawned CLI process. A one-shot serves a single turn; a warm one
 * (`keepWarm`) serves its conversation's turns until retired.
 */
interface ProcHandle {
  proc: ReturnType<typeof Bun.spawn>;
  argv: string[];
  cwd: string;
  /** From the process's `system/init`; `warmReusable` matches it to the turn's resume id. */
  sessionId?: string;
  keepWarm: boolean;
  /**
   * The turn that owns this process, by its line queue; null = idle. Cleanup
   * acts only for its own turn (PR #41): a finished turn's late `finally`
   * must not retire a process the next turn already took over.
   */
  owner: LineQueue | null;
  /** For `warmMax` eviction (LRU). */
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Where the stdout pump delivers lines: the current turn's queue, or none. */
  sink: LineQueue | null;
  /** stdout reached EOF. */
  exited: boolean;
  retiring: Promise<void> | null;
  /** stderr since the current turn began, capped to its last STDERR_CAP chars. */
  stderr: string;
  stderrDone: Promise<void>;
}

/** Single-consumer line queue between a process's stdout pump and a turn. `null` = EOF. */
class LineQueue {
  private readonly items: Array<string | null> = [];
  private waiter: ((v: string | null) => void) | null = null;

  push(v: string | null): void {
    const w = this.waiter;
    if (w !== null) {
      this.waiter = null;
      w(v);
    } else {
      this.items.push(v);
    }
  }

  next(): Promise<string | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as string | null);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

interface StdinSink {
  write: (chunk: Uint8Array) => unknown;
  flush: () => unknown;
  end: () => unknown;
}

interface ActiveTurn {
  proc: ReturnType<typeof Bun.spawn>;
  cancelRequested: boolean;
  escalation: Escalation | null;
  graceTermTimer: ReturnType<typeof setTimeout> | null;
  graceKillTimer: ReturnType<typeof setTimeout> | null;
}

export class RealClaudeBackend implements ClaudeBackend {
  private readonly binary: string;
  readonly claudeBinary: string;
  private readonly spawnEnv: Record<string, string>;
  private readonly refreshIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly versionRegex: RegExp;
  private readonly graceTermMs: number;
  private readonly graceKillMs: number;
  private readonly warmIdleMs: number;
  private readonly warmMax: number;

  private cached: HealthStatus = { cli: 'missing' };
  private cachedAt = 0;
  private refreshInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Active turns, keyed by turn_id → active-turn state. Used by cancel(). */
  private readonly active = new Map<string, ActiveTurn>();

  /** Warm processes (PR #39), keyed by conv_id. */
  private readonly warm = new Map<string, ProcHandle>();

  /** PR #42: last model list, and the probe in flight (shared by callers). */
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;
  private modelsInFlight: Promise<ModelInfo[]> | null = null;

  /**
   * Every spawned process until its retirement completes (PR #40, PR #43):
   * what `stop()` retires and waits for.
   */
  private readonly live = new Set<ProcHandle>();

  constructor(opts: RealClaudeBackendOptions = {}) {
    this.binary = opts.claudeBinary ?? 'claude';
    this.claudeBinary = this.binary;
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
    this.warmIdleMs = opts.warmIdleMs ?? 0;
    this.warmMax = opts.warmMax ?? DEFAULT_WARM_MAX;
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

  /**
   * Stop the refresh loop, retire every live CLI process (warm, busy or
   * one-shot) and wait until each is gone, bounded by the retirement ladder
   * (PR #40 §1); then await any in-flight probe. Idempotent.
   */
  async stop(): Promise<void> {
    await Promise.all([...this.live].map((handle) => this.retire(handle)));
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
   * PR #39: the argv of the conversation's warm process when `startTurn(req)`
   * would feed it this turn; undefined when the turn spawns a fresh process.
   */
  reusableArgv(req: TurnRequest): string[] | undefined {
    const warm = this.warm.get(req.conv_id);
    if (warm === undefined) return undefined;
    const composed = compose(req, { claudeBinary: this.binary });
    return this.canReuse(warm, req, composed.argv, composed.cwd) ? [...warm.argv] : undefined;
  }

  /**
   * Run one turn and yield parsed `BackendEvent`s as NDJSON lines arrive on
   * stdout. Terminator semantics:
   *
   *  - A normal `turn.result` or stream-JSON-originated `turn.error` wins.
   *  - If the subprocess exits without a terminator AND cancel was requested,
   *    emit `turn.cancelled{escalation}` (escalation = highest signal sent).
   *  - If the subprocess exits without a terminator and cancel was NOT
   *    requested, emit a `turn.error` classified by `classifyCliFailure`.
   *
   * Process lifecycle (PR #39): with `warmIdleMs` = 0 every turn spawns
   * `claude -p --input-format stream-json …`, writes its message and closes
   * stdin. With `warmIdleMs` > 0 stdin stays open after the `result`; the
   * conversation's next turn is written to the same process when
   * `warmReusable` allows, so the CLI boots and runs its SessionStart hooks
   * once per conversation instead of once per turn. PR #40: one stdout pump
   * per process routes lines to the turn that owns it; a busy warm process
   * refuses a second turn; retirement is a bounded SIGTERM → SIGKILL ladder.
   *
   * Detached (`detached: true`) so every process has its own process group
   * and `cancel` can `kill(-pgid, sig)` the whole tree.
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

    const existing = this.warm.get(req.conv_id);
    if (existing !== undefined && existing.owner !== null) {
      // The engine admits one turn per conversation, so this is a broken
      // invariant. A second process resuming the same session beside the busy
      // one would fork it; refuse instead (PR #40 §4).
      yield {
        kind: 'turn.error',
        turn_id: req.turn_id,
        error: {
          kind: 'unknown',
          retryable: true,
          detail: `conversation ${req.conv_id} already has a turn running in CLI pid ${existing.proc.pid}`,
        },
      };
      return;
    }

    let handle: ProcHandle;
    let reused = false;
    if (existing !== undefined && this.canReuse(existing, req, composed.argv, composed.cwd)) {
      handle = existing;
      reused = true;
      if (handle.idleTimer !== null) clearTimeout(handle.idleTimer);
      handle.idleTimer = null;
    } else {
      if (existing !== undefined) void this.retire(existing);
      const keepWarm = this.warmIdleMs > 0 && this.makeWarmRoom();
      try {
        handle = this.spawnProcess(composed, keepWarm);
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
      if (keepWarm) this.warm.set(req.conv_id, handle);
    }
    // Attach before any await: from here the pump delivers to this turn.
    const sink = new LineQueue();
    handle.owner = sink;
    handle.sink = sink;
    handle.lastUsed = Date.now();
    handle.stderr = '';
    if (handle.exited) sink.push(null);
    const { proc } = handle;

    const turnState: ActiveTurn = {
      proc,
      cancelRequested: false,
      escalation: null,
      graceTermTimer: null,
      graceKillTimer: null,
    };
    this.active.set(req.turn_id, turnState);

    // Write the stream-JSON user message. A one-shot closes stdin so the CLI
    // sees EOF and exits after the turn; a warm process keeps it open.
    try {
      const writer = proc.stdin as unknown as StdinSink;
      await Promise.resolve(writer.write(composed.stdin));
      if (handle.keepWarm) await Promise.resolve(writer.flush());
      else await Promise.resolve(writer.end());
    } catch {
      // stdin write errors usually indicate the child died before we got
      // here; the stdout reader + exit handling will surface the real error.
    }

    let terminated = false;
    // A reused process may still print the tail of an earlier turn: until this
    // turn's own system/init, only a `result` (one per message, so never a
    // stale one) is let through (PR #40 §2).
    let awaitingInit = reused;
    let lastResultSubtype: string | undefined;
    // Without --include-partial-messages each `assistant.delta` is a whole
    // text block, one per assistant message. A turn that calls tools has
    // several; joined bare they run together ("…the code.Now the tests").
    let emittedText = false;
    try {
      for (;;) {
        // A warm process outlives the turn: stop at the terminator instead
        // of reading on to EOF (the next turn's lines are not ours).
        if (terminated && handle.keepWarm) break;
        const line = await sink.next();
        if (line === null) break;
        const parsed = parseStreamJsonLine(line);
        if (awaitingInit) {
          if (parsed.some((ev) => ev.kind === 'system.init')) awaitingInit = false;
          else if (!parsed.some((ev) => ev.kind === 'turn.result' || ev.kind === 'turn.error')) {
            if (parsed.length > 0) this.noteStray(handle, line);
            continue;
          }
        }
        // Track the result subtype before the parsed events are handled: an
        // error result yields turn.error, and the classifier below needs it.
        const subtypeMatch = /"subtype"\s*:\s*"([^"]+)"/.exec(line);
        if (subtypeMatch !== null && line.includes('"type":"result"')) {
          lastResultSubtype = subtypeMatch[1];
        }
        for (const ev of parsed) {
          if (ev.kind === 'assistant.delta') {
            if (ev.text === '') continue;
            const text = emittedText ? `\n\n${ev.text}` : ev.text;
            emittedText = true;
            yield { kind: 'assistant.delta', text, turn_id: req.turn_id };
            continue;
          }
          if (ev.kind === 'system.init') handle.sessionId = ev.session_id;
          // Intercept parser-coarse turn.error and refine with stderr classifier.
          if (ev.kind === 'turn.error') {
            terminated = true;
            // The CLI often reports the failure on stdout (`result` text,
            // e.g. "Invalid model: x") with stderr empty: classify on both,
            // and keep that text over a generic "CLI crashed".
            const stderr = handle.stderr;
            const stdoutDetail = ev.error.detail;
            const classified = classifyCliFailure({
              raw_stderr: [stderr, stdoutDetail ?? ''].filter((t) => t !== '').join('\n'),
              ...(lastResultSubtype !== undefined ? { cli_subtype: lastResultSubtype } : {}),
            });
            const { raw_stderr: _combined, ...rest } = classified;
            const refined = {
              ...rest,
              ...(stderr !== '' ? { raw_stderr: stderr } : {}),
              ...(rest.kind === 'cli_crashed' &&
              stdoutDetail !== undefined &&
              lastResultSubtype !== 'error_max_turns'
                ? { detail: stdoutDetail.slice(0, 200) }
                : {}),
            } as typeof classified;
            // Settle before announcing (PR #40 §3): an errored warm process
            // serves no further turn.
            if (handle.keepWarm) void this.retire(handle);
            yield {
              kind: 'turn.error',
              turn_id: req.turn_id,
              error: refined,
            };
            continue;
          }
          if (ev.kind === 'turn.result') {
            terminated = true;
            // Settle before announcing (PR #40 §3): the engine may admit the
            // conversation's next turn while this generator is suspended.
            if (handle.keepWarm) {
              if (turnState.cancelRequested) void this.retire(handle);
              else this.release(handle, sink);
            }
            yield { ...ev, turn_id: req.turn_id } as BackendEvent;
            continue;
          }
          yield { ...ev, turn_id: req.turn_id } as BackendEvent;
        }
      }

      if (terminated && handle.keepWarm) return;

      const exitCode = await proc.exited;
      await handle.stderrDone;
      if (!terminated) {
        const raw = handle.stderr;
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
      if (handle.sink === sink) handle.sink = null;
      // Still owned by this turn = it did not end cleanly (EOF, cancel, a
      // one-shot, or the consumer stopped iterating): this process serves no
      // further turn. Owned by a later turn = not ours to touch.
      if (handle.owner === sink) void this.retire(handle);
    }
  }

  private canReuse(warm: ProcHandle, req: TurnRequest, argv: string[], cwd: string): boolean {
    if (this.warmIdleMs <= 0 || warm.owner !== null || warm.exited || warm.retiring !== null)
      return false;
    if (warm.proc.exitCode !== null) return false;
    const next: NextTurnShape = { argv, cwd };
    if (req.resume_session_id !== undefined) next.resume_session_id = req.resume_session_id;
    return warmReusable(warm, next);
  }

  /**
   * Make room for one more warm process under `warmMax` by retiring the least
   * recently used idle one. False when every warm process is busy: the turn
   * then runs as a one-shot.
   */
  private makeWarmRoom(): boolean {
    if (this.warm.size < this.warmMax) return true;
    let lru: ProcHandle | undefined;
    for (const h of this.warm.values()) {
      if (h.owner === null && (lru === undefined || h.lastUsed < lru.lastUsed)) lru = h;
    }
    if (lru === undefined) return false;
    void this.retire(lru);
    return true;
  }

  private spawnProcess(composed: ComposeResult, keepWarm: boolean): ProcHandle {
    const proc = Bun.spawn(composed.argv, {
      cwd: composed.cwd,
      env: { ...this.spawnEnv, ...composed.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      // macOS/Linux: new process group, so kill(-pgid) reaches the whole tree.
      // Bun honors `detached` on Unix.
      ...({ detached: true } as Record<string, unknown>),
    });
    const handle: ProcHandle = {
      proc,
      argv: composed.argv,
      cwd: composed.cwd,
      keepWarm,
      owner: null,
      lastUsed: Date.now(),
      idleTimer: null,
      sink: null,
      exited: false,
      retiring: null,
      stderr: '',
      stderrDone: Promise.resolve(),
    };
    // Tracked until its whole process group is gone, not just the leader
    // (PR #43): a leader that exits on its own still has its group swept,
    // and stop() still waits for that sweep.
    this.live.add(handle);
    void proc.exited.then(() => {
      void this.retire(handle);
    });
    // The one stdout reader for the process's whole life (PR #40 §2): lines go
    // to the attached turn; with none attached they are strays.
    void (async () => {
      try {
        for await (const line of readLines(proc.stdout as ReadableStream<Uint8Array>)) {
          if (handle.sink !== null) handle.sink.push(line);
          else this.noteStray(handle, line);
        }
      } catch {
        // stream errored: treated as EOF
      }
      handle.exited = true;
      this.forget(handle);
      handle.sink?.push(null);
    })();
    handle.stderrDone = drainStream(proc.stderr as ReadableStream<Uint8Array>, (chunk) => {
      handle.stderr = (handle.stderr + chunk).slice(-STDERR_CAP);
    });
    return handle;
  }

  /** A warm turn ended cleanly: detach it and wait for the next one. */
  private release(handle: ProcHandle, sink: LineQueue): void {
    if (handle.owner !== sink) return;
    handle.sink = null;
    handle.owner = null;
    handle.idleTimer = setTimeout(() => {
      if (handle.owner === null) void this.retire(handle);
    }, this.warmIdleMs);
    unrefTimer(handle.idleTimer);
  }

  private noteStray(handle: ProcHandle, line: string): void {
    // eslint-disable-next-line no-console
    console.warn(
      `[backend] dropped a stray stdout line from CLI pid ${handle.proc.pid}: ${line.slice(0, 160)}`,
    );
  }

  private forget(handle: ProcHandle): void {
    for (const [conv, h] of this.warm) {
      if (h === handle) this.warm.delete(conv);
    }
  }

  /**
   * Take a process out of service and see its whole process group gone
   * (PR #40 §1, PR #41): close stdin (an idle CLI exits on EOF), then, while
   * anything is left in the group (leader or descendants), SIGTERM and then
   * SIGKILL it, each after a bounded wait. Memoised: every caller awaits one
   * ladder.
   */
  private retire(handle: ProcHandle): Promise<void> {
    if (handle.retiring !== null) return handle.retiring;
    this.forget(handle);
    handle.owner = null;
    if (handle.idleTimer !== null) clearTimeout(handle.idleTimer);
    handle.idleTimer = null;
    const { proc } = handle;
    handle.retiring = (async () => {
      if (proc.exitCode === null) {
        try {
          void (proc.stdin as unknown as StdinSink).end();
        } catch {
          // already closed
        }
        await exitedWithin(proc, RETIRE_EOF_MS);
      }
      // Done means the whole process group is gone, not just the CLI leader
      // (PR #41): descendants that outlive it get the same TERM → KILL steps.
      if (groupAlive(proc.pid)) {
        signalGroup(proc.pid, 'SIGTERM');
        if (!(await groupGoneWithin(proc, RETIRE_TERM_MS))) {
          signalGroup(proc.pid, 'SIGKILL');
          await groupGoneWithin(proc, RETIRE_KILL_MS);
        }
      }
      this.live.delete(handle);
    })();
    return handle.retiring;
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
    unrefTimer(turn.graceTermTimer);
    unrefTimer(turn.graceKillTimer);
  }

  /**
   * The CLI's own model list (PR #42): spawn the configured binary with hooks
   * disabled, send the stream-json `initialize` control request, read the
   * reply, retire the process. Fresh for MODELS_TTL_MS; concurrent callers
   * share one probe. Rejects when the CLI is missing, errors or times out.
   */
  async listModels(opts: { cwd?: string } = {}): Promise<ModelInfo[]> {
    const cache = this.modelsCache;
    if (cache !== null && Date.now() - cache.at < MODELS_TTL_MS) return cache.models;
    if (this.modelsInFlight !== null) return this.modelsInFlight;
    const probe = this.probeModels(opts.cwd ?? tmpdir()).then((models) => {
      this.modelsCache = { at: Date.now(), models };
      return models;
    });
    this.modelsInFlight = probe;
    try {
      return await probe;
    } finally {
      this.modelsInFlight = null;
    }
  }

  private async probeModels(cwd: string): Promise<ModelInfo[]> {
    if (this.cached.cli === 'missing') throw new Error(`claude binary not found at ${this.binary}`);
    const argv = [
      this.binary,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      // A listing must not run the project's hooks (PR #42 evidence: with
      // this, initialize runs none and writes no transcript).
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
    ];
    const handle = this.spawnProcess({ argv, env: {}, cwd, stdin: new Uint8Array() }, false);
    const sink = new LineQueue();
    handle.owner = sink;
    handle.sink = sink;
    if (handle.exited) sink.push(null);
    const requestId = `models-${Date.now()}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`model list probe timed out after ${MODELS_PROBE_TIMEOUT_MS}ms`)),
        MODELS_PROBE_TIMEOUT_MS,
      );
    });
    try {
      const writer = handle.proc.stdin as unknown as StdinSink;
      await Promise.resolve(
        writer.write(new TextEncoder().encode(initializeRequestLine(requestId) + '\n')),
      );
      await Promise.resolve(writer.flush());
      const read = (async (): Promise<ModelInfo[]> => {
        for (;;) {
          const line = await sink.next();
          if (line === null) {
            throw new Error(`CLI exited before answering initialize: ${handle.stderr.slice(-300)}`);
          }
          const response = controlResponseFor(line, requestId);
          if (response !== undefined) return parseModelList(response);
        }
      })();
      return await Promise.race([read, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void this.retire(handle);
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

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

/** True once `proc` exited, false if `ms` passed first. */
async function exitedWithin(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<boolean> {
  if (proc.exitCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const done = await Promise.race([proc.exited.then(() => true as const), timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return done;
}

/** Whether any process is left in group `pgid` (signal 0 probes without sending). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM: a member exists but is not ours to signal; count it as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True once the leader has exited and its group is empty, false if `ms` passed first. */
async function groupGoneWithin(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (proc.exitCode !== null && !groupAlive(proc.pid)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(25);
  }
}

/** Signal a whole process group; quiet when it is already gone. */
function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // ESRCH: no process left in the group
  }
}
