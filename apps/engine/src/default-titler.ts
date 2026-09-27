/**
 * `DefaultTitler` — `claude -p` invocation backed by Haiku, with budget +
 * fallback delegation. Implements the same `Titler` contract as
 * `FallbackTitler` so the engine wiring is unchanged.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 3.5 (LLM half)
 * IMPL: plans/landed/2026-04-26-clod-ui-pr11-default-titler-v1.md
 *
 * Failure handling: every failure path (spawn error, non-zero exit,
 * timeout, empty / whitespace / malformed output) silently delegates to
 * the configured fallback. The `Titler` contract — always returns a
 * non-empty string — is preserved end-to-end.
 */
import { FallbackTitler } from './titler.ts';
import type { Titler, TitlerInput } from './titler.ts';

const DEFAULT_BINARY = 'claude';
const DEFAULT_MODEL = 'haiku';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_USER_CHARS = 1000;
const DEFAULT_MAX_ASSISTANT_CHARS = 1000;

/** Lower bound on word count after cleaning before we accept the title. */
const MIN_WORDS = 1;
/** Upper bound; >MAX_WORDS almost certainly means the model produced an essay. */
const MAX_WORDS = 12;

export interface DefaultTitlerOptions {
  /** CLI binary (path or PATH name). Default: 'claude'. */
  claudeBinary?: string;
  /** Model alias or id passed to `--model`. Default: 'haiku'. */
  model?: string;
  /** Wall-clock budget for the spawn (ms). Default: 5000. */
  timeoutMs?: number;
  /** Working directory for the spawn. Default: `process.cwd()`. */
  cwd?: string;
  /** Extra env vars merged over the inherited env. Default: none. */
  env?: Record<string, string>;
  /** Per-input char caps; oversized inputs are truncated with a ` …` marker. */
  maxUserMessageChars?: number;
  maxAssistantChars?: number;
  /**
   * Test seam: if provided, this function is invoked instead of spawning
   * the CLI. Receives the constructed prompt + argv + budget; returns the
   * raw stdout (which the titler then cleans). Throw to simulate a CLI
   * failure path.
   */
  invokeForTest?: (args: { prompt: string; argv: string[]; timeoutMs: number }) => Promise<string>;
  /**
   * Fallback titler used on every failure path. Default: `new FallbackTitler()`.
   * Override only for tests that want to assert the fallback was invoked.
   */
  fallback?: Titler;
}

/**
 * LLM-backed `Titler` implementation. Spawns `claude -p` against a Haiku
 * model and cleans the response into a 4-6 word title. On any failure path,
 * delegates to a configurable fallback (default: `FallbackTitler`).
 */
export class DefaultTitler implements Titler {
  private readonly binary: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;
  private readonly env: Record<string, string> | undefined;
  private readonly maxUserMessageChars: number;
  private readonly maxAssistantChars: number;
  private readonly invokeForTest: DefaultTitlerOptions['invokeForTest'];
  private readonly fallback: Titler;

  constructor(opts: DefaultTitlerOptions = {}) {
    this.binary = opts.claudeBinary ?? DEFAULT_BINARY;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env;
    this.maxUserMessageChars = opts.maxUserMessageChars ?? DEFAULT_MAX_USER_CHARS;
    this.maxAssistantChars = opts.maxAssistantChars ?? DEFAULT_MAX_ASSISTANT_CHARS;
    this.invokeForTest = opts.invokeForTest;
    this.fallback = opts.fallback ?? new FallbackTitler();
  }

  async suggestTitle(input: TitlerInput): Promise<string> {
    const prompt = this.buildPrompt(input);
    const argv = this.buildArgv(prompt);

    let raw: string;
    try {
      raw = this.invokeForTest
        ? await this.invokeForTest({ prompt, argv, timeoutMs: this.timeoutMs })
        : await this.invokeCli(prompt, argv);
    } catch {
      // Spawn / exit / timeout failure → fallback. Never propagate.
      return this.fallback.suggestTitle(input);
    }

    const cleaned = cleanTitle(raw);
    if (cleaned === null) {
      return this.fallback.suggestTitle(input);
    }
    return cleaned;
  }

  /** Compose the minimal Haiku prompt. Exposed for assertion in unit tests. */
  buildPrompt(input: TitlerInput): string {
    const userTrunc = truncate(input.user_message, this.maxUserMessageChars);
    const assistantTrunc = truncate(input.assistant_text, this.maxAssistantChars);
    return [
      'Read the conversation excerpt below and respond with a 4-6 word title that summarizes its topic. Reply with the title only — no quotes, no preamble, no trailing period.',
      '',
      `User: ${userTrunc}`,
      `Assistant: ${assistantTrunc}`,
      '',
      'Title:',
    ].join('\n');
  }

  /** Compose the argv passed to `claude -p`. Exposed for assertion in unit tests. */
  buildArgv(prompt: string): string[] {
    return [this.binary, '-p', prompt, '--model', this.model, '--output-format', 'text'];
  }

  /**
   * Spawn `claude -p` and return its stdout. Throws on non-zero exit,
   * spawn error, or timeout. Caller maps any throw to the fallback path.
   */
  private async invokeCli(_prompt: string, argv: string[]): Promise<string> {
    const spawnEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') spawnEnv[k] = v;
    }
    if (this.env) Object.assign(spawnEnv, this.env);

    const proc = Bun.spawn(argv, {
      cwd: this.cwd,
      env: spawnEnv,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // process may have already exited
      }
    }, this.timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }

    try {
      const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
      const [stdout, exitCode] = await Promise.all([
        new Response(stdoutStream).text().catch(() => ''),
        proc.exited,
      ]);

      if (timedOut) throw new Error('default-titler: timed out');
      if (exitCode !== 0) {
        throw new Error(`default-titler: claude exited with code ${String(exitCode)}`);
      }
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Truncate `s` to `max` chars, appending ` …` when cropping. Pure.
 * Empty input returns the empty string verbatim (no marker).
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + ' …';
}

/**
 * Clean a raw stdout string into a title, or return `null` to signal
 * "fall back". Pure; covered by the unit-test table.
 *
 * Steps:
 *   1. Take the first non-empty trimmed line.
 *   2. Strip a leading `Title:` echo, if present.
 *   3. Strip surrounding matched quotes / backticks.
 *   4. Strip surrounding markdown emphasis markers (`**`, `*`, `__`, `_`).
 *   5. Strip a trailing `.`, `,`, `;`, `:` cluster.
 *   6. Re-trim, reject empty.
 *   7. Reject if word count is outside [MIN_WORDS, MAX_WORDS].
 */
export function cleanTitle(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;

  // 1. First non-empty trimmed line.
  const lines = raw.split(/\r?\n/);
  let candidate = '';
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 0) {
      candidate = t;
      break;
    }
  }
  if (candidate.length === 0) return null;

  // 2. Drop a leading `Title:` echo.
  const titleEcho = /^title\s*:\s*/i;
  candidate = candidate.replace(titleEcho, '');

  // 3. Strip surrounding matched quotes / backticks (one pass).
  for (const [open, close] of [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['“', '”'],
    ['‘', '’'],
  ] as const) {
    if (candidate.startsWith(open) && candidate.endsWith(close) && candidate.length >= 2) {
      candidate = candidate.slice(open.length, candidate.length - close.length);
      break;
    }
  }

  // 4. Strip surrounding markdown emphasis (one pass, longest match first).
  for (const marker of ['**', '__', '*', '_']) {
    if (
      candidate.startsWith(marker) &&
      candidate.endsWith(marker) &&
      candidate.length >= marker.length * 2
    ) {
      candidate = candidate.slice(marker.length, candidate.length - marker.length);
      break;
    }
  }

  // 5. Strip trailing punctuation cluster.
  candidate = candidate.replace(/[.,;:]+\s*$/u, '');

  // 6. Re-trim + reject empty.
  candidate = candidate.trim();
  if (candidate.length === 0) return null;

  // 7. Word-count band check.
  const words = candidate.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < MIN_WORDS || words.length > MAX_WORDS) return null;

  return candidate;
}
