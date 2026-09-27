import type { ClodError, HealthCliStatus } from '@clod-ui/contracts';

/**
 * Event shapes emitted by a backend. Mirrors the wire-layer event kinds but
 * as plain objects (no EventEnvelope wrapping) — the engine wraps these into
 * envelopes before publishing to clients.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md §"Wire Protocol" + Task 2.2.
 */
export type BackendEvent =
  | { kind: 'system.init'; turn_id: string; session_id: string }
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
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    }
  | { kind: 'turn.cancelled'; turn_id: string; escalation: 'sigint' | 'sigterm' | 'sigkill' }
  | { kind: 'turn.error'; turn_id: string; error: ClodError };

export interface TurnRequest {
  turn_id: string;
  conv_id: string;
  resume_session_id?: string;
  user_message: string;
  model?: string;
  thinking_effort?: 'off' | 'think' | 'think_hard' | 'think_harder' | 'ultrathink';
  system_prompt?: { mode: 'append' | 'override'; text: string };
  allowed_tools?: string[];
  disallowed_tools?: string[];
  cwd: string;
  attachments?: Array<{ path: string; content_type?: string }>;
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
  startTurn(req: TurnRequest): AsyncIterable<BackendEvent>;
  cancel(turnId: string): Promise<void>;
  version(): Promise<string>;
  health(): Promise<HealthStatus>;
}
