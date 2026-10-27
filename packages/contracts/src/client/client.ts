/**
 * `createClient({ transport })` — typed projection of every engine route +
 * a typed WS subscription handle. All response bodies are validated through
 * the existing Zod schemas in `@clod-ui/contracts`; failures surface as
 * `ClientError { kind: 'schema', issues }`.
 *
 * Spec: plans/landed/2026-04-28-clod-ui-pr13-typed-client-v1.md §4.
 */
import type { ZodType } from 'zod';

import {
  AttachmentMetaSchema,
  type AttachmentMeta,
  type AttachmentUploadBody,
} from '../attachments.ts';
import {
  ConversationsListResponseSchema,
  type ConversationsListResponse,
} from '../conversations.ts';
import { DiagnosticsResponseSchema, type DiagnosticsResponse } from '../diagnostics.ts';
import type { EventEnvelope } from '../event-envelope.ts';
import { HealthResponseSchema, type HealthResponse } from '../health.ts';
import { ModelsResponseSchema, type ModelsResponse } from '../models.ts';
import { ClaudeSettingsSchema, type ClaudeSettings } from '../settings.ts';
import { SkillsResponseSchema, type SkillsResponse } from '../skills.ts';
import { TranscriptResponseSchema, type TranscriptResponse } from '../transcript.ts';
import type { ThinkingEffort } from '../turn.ts';

import { ClientError } from './errors.ts';
import type { HttpMethod, Subscription, Transport, TransportResponse } from './transport.ts';

export interface CreateClientOptions {
  transport: Transport;
}

export interface SubmitTurnInput {
  conv_id: string;
  turn_id: string;
  user_message: string;
  model?: string;
  thinking_effort?: ThinkingEffort;
  cwd?: string;
  resume_session_id?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  system_prompt?: { mode: 'append' | 'override'; text: string };
  /** Raw-flags escape hatch — appended verbatim at the argv tail (PR #28). */
  extra_argv?: string[];
  /** File-by-reference attachments (PR #33): paths from uploadAttachment. */
  attachments?: Array<{ path: string; content_type?: string }>;
}

export interface CancelTurnInput {
  conv_id: string;
  turn_id: string;
}

export interface SubscribeHandlers {
  onEnvelope?: (env: EventEnvelope) => void;
  onOpen?: () => void;
  onClose?: (ev: { code: number; reason: string }) => void;
  onError?: (err: Error) => void;
  /**
   * Per-kind handler dispatch. Each registered key fires only for envelopes
   * whose `kind` matches; multiple registrations under the same key are
   * unsupported (last write wins). The catch-all `onEnvelope` still fires
   * alongside any matching `on[kind]` handler.
   *
   * Spec: plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §6.
   *
   * Type-narrowing of `env.payload` per kind is deferred — see
   * // TODO(payload-narrowing) in the plan §8.
   */
  on?: Record<string, (env: EventEnvelope) => void>;
  /**
   * Reconnect-and-resume policy. Defaults to enabled with exponential
   * backoff. See `SubscribeOptions.reconnect` in the transport for the
   * shape; `false` disables reconnects.
   */
  reconnect?:
    | false
    | {
        backoffMs?: number[];
        maxAttempts?: number;
      };
  /**
   * Initial replay cursor — an envelope `id` value. When provided, the
   * subscription opens with `?since=<value>` so the engine replays
   * envelopes from its replay buffer that the consumer hasn't seen.
   */
  since?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface Client {
  // ---- /health -----------------------------------------------------------
  getHealth(opts?: RequestOptions): Promise<HealthResponse>;

  // ---- /settings (opt-in) ------------------------------------------------
  getSettings(opts?: RequestOptions): Promise<ClaudeSettings>;
  putSettings(body: ClaudeSettings, opts?: RequestOptions): Promise<ClaudeSettings>;
  patchSettings(body: Partial<ClaudeSettings>, opts?: RequestOptions): Promise<ClaudeSettings>;

  // ---- /conversations (opt-in) ------------------------------------------
  getConversations(opts?: RequestOptions): Promise<ConversationsListResponse>;
  /**
   * Read the historical JSONL transcript for a conversation. Companion to
   * the live `transcript.updated` wire envelope; the array is the same
   * shape, just sourced from the on-disk file rather than a watcher tick.
   *
   * Opt-in via persistence + transcripts on the engine side; absent
   * configuration surfaces as `ClientError { kind: 'not_configured' }`.
   * Unknown conversation surfaces as `ClientError { kind: 'http', status: 404 }`.
   */
  getTranscript(conv_id: string, opts?: RequestOptions): Promise<TranscriptResponse>;
  /** Skills discovery (PR #31). 404 → ClientError.kind 'not_configured'. */
  getSkills(opts?: RequestOptions): Promise<SkillsResponse>;
  /** The CLI's own model list (PR #42). 404 → 'not_configured'. */
  getModels(opts?: RequestOptions): Promise<ModelsResponse>;
  /** Per-turn diagnostics ring (PR #32). 404 → 'not_configured'. */
  getDiagnostics(opts?: RequestOptions): Promise<DiagnosticsResponse>;
  /** Attachment intake (PR #33). 404 → 'not_configured'. */
  uploadAttachment(
    conv_id: string,
    body: AttachmentUploadBody,
    opts?: RequestOptions,
  ): Promise<AttachmentMeta>;

  // ---- turns ------------------------------------------------------------
  submitTurn(input: SubmitTurnInput, opts?: RequestOptions): Promise<void>;
  cancelTurn(input: CancelTurnInput, opts?: RequestOptions): Promise<void>;

  // ---- /ws --------------------------------------------------------------
  subscribe(handlers: SubscribeHandlers): Subscription;
}

export function createClient(opts: CreateClientOptions): Client {
  const { transport } = opts;

  async function send<T>(req: {
    method: HttpMethod;
    path: string;
    body?: unknown;
    schema?: ZodType<T>;
    signal?: AbortSignal;
  }): Promise<T> {
    const reqOpts: Parameters<Transport['request']>[0] = {
      method: req.method,
      path: req.path,
    };
    if (req.body !== undefined) reqOpts.body = req.body;
    if (req.signal !== undefined) reqOpts.signal = req.signal;
    const res: TransportResponse = await transport.request(reqOpts);
    if (!res.ok) {
      // Detect the engine's opt-in 404 surface (`{ error: '<surface> not configured' }`).
      if (res.status === 404 && isNotConfigured(res.body)) {
        throw new ClientError({
          kind: 'not_configured',
          message: notConfiguredMessage(res.body),
          status: 404,
          path: req.path,
        });
      }
      throw new ClientError({
        kind: 'http',
        message: `${req.method} ${req.path} returned ${res.status}`,
        status: res.status,
        path: req.path,
      });
    }
    if (!req.schema) {
      // Caller doesn't care about the body (e.g. submitTurn/cancelTurn).
      return undefined as T;
    }
    const parsed = req.schema.safeParse(res.body);
    if (!parsed.success) {
      throw new ClientError({
        kind: 'schema',
        message: `${req.method} ${req.path} response failed schema validation`,
        issues: parsed.error.issues,
        path: req.path,
      });
    }
    return parsed.data;
  }

  return {
    getHealth: (o) =>
      send({
        method: 'GET',
        path: '/health',
        schema: HealthResponseSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    getSettings: (o) =>
      send({
        method: 'GET',
        path: '/settings',
        schema: ClaudeSettingsSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    putSettings: (body, o) =>
      send({
        method: 'PUT',
        path: '/settings',
        body,
        schema: ClaudeSettingsSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    patchSettings: (body, o) =>
      send({
        method: 'PATCH',
        path: '/settings',
        body,
        schema: ClaudeSettingsSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    getConversations: (o) =>
      send({
        method: 'GET',
        path: '/conversations',
        schema: ConversationsListResponseSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    getSkills: (o) =>
      send({
        method: 'GET',
        path: '/skills',
        schema: SkillsResponseSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    getModels: (o) =>
      send({
        method: 'GET',
        path: '/models',
        schema: ModelsResponseSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    getDiagnostics: (o) =>
      send({
        method: 'GET',
        path: '/diagnostics',
        schema: DiagnosticsResponseSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    uploadAttachment: (conv_id, body, o) =>
      send({
        method: 'POST',
        path: `/conversations/${encodeURIComponent(conv_id)}/attachments`,
        body,
        schema: AttachmentMetaSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    getTranscript: (conv_id, o) =>
      send({
        method: 'GET',
        path: `/conversations/${encodeURIComponent(conv_id)}/transcript`,
        schema: TranscriptResponseSchema,
        ...(o?.signal ? { signal: o.signal } : {}),
      }),
    submitTurn: async (input, o) => {
      const { conv_id, ...rest } = input;
      await send({
        method: 'POST',
        path: `/conversations/${encodeURIComponent(conv_id)}/turns`,
        body: rest,
        ...(o?.signal ? { signal: o.signal } : {}),
      });
    },
    cancelTurn: async (input, o) => {
      await send({
        method: 'POST',
        path: `/conversations/${encodeURIComponent(input.conv_id)}/cancel`,
        body: { turn_id: input.turn_id },
        ...(o?.signal ? { signal: o.signal } : {}),
      });
    },
    subscribe: (handlers) => {
      const dispatch = (env: EventEnvelope): void => {
        const handler = handlers.on?.[env.kind];
        if (handler) handler(env);
        handlers.onEnvelope?.(env);
      };
      return transport.subscribe({
        path: '/ws',
        onEnvelope: dispatch,
        ...(handlers.onOpen ? { onOpen: handlers.onOpen } : {}),
        ...(handlers.onClose ? { onClose: handlers.onClose } : {}),
        ...(handlers.onError ? { onError: handlers.onError } : {}),
        ...(handlers.reconnect !== undefined ? { reconnect: handlers.reconnect } : {}),
        ...(handlers.since !== undefined ? { since: handlers.since } : {}),
      });
    },
  };
}

function isNotConfigured(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const err = (body as Record<string, unknown>)['error'];
  return typeof err === 'string' && err.endsWith('not configured');
}

function notConfiguredMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const err = (body as Record<string, unknown>)['error'];
    if (typeof err === 'string') return err;
  }
  return 'surface not configured';
}
