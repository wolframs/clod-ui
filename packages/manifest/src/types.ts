/**
 * Manifest event taxonomy. Every state change for a conversation is represented
 * as an appended event; projected state is the pure fold over these.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Phase 3.
 * IMPL: PR #6 (plans/landed/2026-04-23-clod-ui-pr6-sqlite-manifest-v1.md).
 */

export interface ManifestEventBase {
  seq: number;
  ts: number;
  hash_prev?: string;
  hash_self: string;
}

/**
 * Effort names a manifest may hold: the CLI's own levels (PR #42) and the
 * pre-#42 names. Kept as plain literals: this package does not depend on
 * contracts. No engine path writes `settings.applied` yet.
 */
export type ThinkingEffortName =
  | 'auto'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultracode'
  | 'off'
  | 'think'
  | 'think_hard'
  | 'think_harder'
  | 'ultrathink';

export type ManifestEvent = ManifestEventBase &
  (
    | { kind: 'conversation.created'; title?: string }
    | { kind: 'conversation.titled'; title: string }
    | { kind: 'session.captured'; session_id: string }
    | {
        kind: 'settings.applied';
        model?: string;
        thinking_effort?: ThinkingEffortName;
        system_prompt?: { mode: 'append' | 'override'; text: string };
        allowed_tools?: string[];
        disallowed_tools?: string[];
      }
    | {
        kind: 'attachment.added';
        attachment_id: string;
        relative_path: string;
        content_hash: string;
        bytes: number;
      }
    | {
        kind: 'artifact.observed';
        relative_path: string;
        content_hash: string;
        bytes: number;
      }
    | { kind: 'model.changed'; from?: string; to: string }
    | {
        kind: 'tool_config.changed';
        allowed_tools?: string[];
        disallowed_tools?: string[];
      }
    | { kind: 'skills.changed'; enabled: string[] }
    | {
        kind: 'system_prompt.changed';
        mode: 'append' | 'override';
        text: string;
      }
  );

export type ManifestEventKind = ManifestEvent['kind'];

/** The shape supplied to `appendEvent` — the writer attaches seq + hash chain. */
export type ManifestEventInput = DistributiveOmit<
  ManifestEvent,
  'seq' | 'hash_prev' | 'hash_self' | 'ts'
> & { ts?: number };

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Projected state of a conversation, computed by folding over the manifest.
 * Cache-coherent invariant: SQLite is always reproducible from `fold(readAll())`.
 */
export interface ConversationState {
  title?: string;
  created_at?: number;
  claude_session_id?: string;
  model?: string;
  thinking_effort?: ThinkingEffortName;
  system_prompt?: { mode: 'append' | 'override'; text: string };
  allowed_tools?: string[];
  disallowed_tools?: string[];
  enabled_skills: string[];
  attachments: Array<{
    id: string;
    relative_path: string;
    content_hash: string;
    bytes: number;
  }>;
  artifacts: Array<{
    relative_path: string;
    content_hash: string;
    bytes: number;
  }>;
}

export interface ManifestReader {
  readAll(convId: string): Promise<ManifestEvent[]>;
}

export interface ManifestWriter {
  appendEvent(convId: string, event: ManifestEventInput): Promise<ManifestEvent>;
}
