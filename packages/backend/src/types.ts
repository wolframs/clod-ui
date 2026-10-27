import type { ClodError, HealthCliStatus, ModelInfo, ThinkingEffort } from '@clod-ui/contracts';

/**
 * Event shapes emitted by a backend. Mirrors the wire-layer event kinds but
 * as plain objects (no EventEnvelope wrapping) — the engine wraps these into
 * envelopes before publishing to clients.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md §"Wire Protocol" + Task 2.2.
 */
export type BackendEvent =
  | { kind: 'system.init'; turn_id: string; session_id: string; model?: string }
  | { kind: 'assistant.delta'; turn_id: string; text: string }
  | { kind: 'assistant.complete'; turn_id: string }
  | { kind: 'thinking.delta'; turn_id: string; text: string }
  | { kind: 'thinking.complete'; turn_id: string }
  | {
      kind: 'tool.use';
      turn_id: string;
      tool_use_id: string;
      name: string;
      input: unknown;
    }
  | {
      kind: 'tool.result';
      turn_id: string;
      tool_use_id: string;
      content: unknown;
    }
  | {
      kind: 'tool.error';
      turn_id: string;
      tool_use_id: string;
      message: string;
    }
  | {
      kind: 'turn.result';
      turn_id: string;
      usage?: TurnUsage;
    }
  | { kind: 'turn.cancelled'; turn_id: string; escalation: 'sigint' | 'sigterm' | 'sigkill' }
  | { kind: 'turn.error'; turn_id: string; error: ClodError };

/**
 * Token usage of a whole turn, from the CLI's `result` line. `input_tokens`
 * counts only the uncached part of the prompt; the cache fields (PR #39)
 * carry the rest, so read / (read + write + input) is the turn's cache hit.
 */
export interface TurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface TurnRequest {
  turn_id: string;
  conv_id: string;
  resume_session_id?: string;
  user_message: string;
  model?: string;
  /** Canonical vocabulary lives in `@clod-ui/contracts` (PR #24, D2). */
  thinking_effort?: ThinkingEffort;
  system_prompt?: { mode: 'append' | 'override'; text: string };
  allowed_tools?: string[];
  disallowed_tools?: string[];
  /**
   * Raw-flags escape hatch (PR #28, Task 5.8): appended verbatim at the
   * very end of the composed argv — after every composed flag and after
   * the backend-level `ComposeOptions.extraArgv` — so the most specific
   * source wins by trailing duplication.
   */
  extra_argv?: string[];
  cwd: string;
  /**
   * `data_base64` is engine-populated at turn time for image attachments
   * (PR #33 smoke evidence): the CLI's stream-json input rejects
   * path-source image blocks; the API-standard base64 source works. The
   * wire body still carries only `{ path, content_type? }`.
   */
  attachments?: Array<{ path: string; content_type?: string; data_base64?: string }>;
  skills?: string[];
}

export interface HealthStatus {
  cli: HealthCliStatus;
  version?: string;
}

export interface BackendOptions {
  /** Override the `claude` binary path; defaults to `claude` on PATH. */
  claudeBinary?: string;
  /** Extra env for every subprocess spawn (merged over inherited env). */
  env?: Record<string, string>;
  /** Override CWD used for spawned processes; per-turn cwd in `TurnRequest` takes precedence. */
  defaultCwd?: string;
}

export interface ClaudeBackend {
  /**
   * The binary this backend spawns, when it spawns one (PR #38). Lets the
   * diagnostics ring record the argv that really ran, wrapper included.
   */
  readonly claudeBinary?: string;
  /**
   * PR #39: when `startTurn(req)` would feed this turn to the conversation's
   * already-running CLI process, that process's spawn argv; otherwise
   * undefined (a fresh spawn of `compose(req)`). Lets diagnostics record the
   * argv that really runs. Backends without warm processes omit it.
   */
  reusableArgv?(req: TurnRequest): string[] | undefined;
  startTurn(req: TurnRequest): AsyncIterable<BackendEvent>;
  cancel(turnId: string): Promise<void>;
  /**
   * PR #42: the models this CLI offers, as it reports them itself. `cwd` is
   * where the probe runs (project settings apply). Backends without a CLI
   * omit it; the engine's `GET /models` is then not configured.
   */
  listModels?(opts?: { cwd?: string }): Promise<ModelInfo[]>;
  version(): Promise<string>;
  health(): Promise<HealthStatus>;
}
