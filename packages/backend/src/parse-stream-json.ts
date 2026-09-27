import type { BackendEvent } from './types.ts';

/**
 * Parser for `claude -p --output-format stream-json --verbose` NDJSON output.
 *
 * Each CLI line is a single JSON object; one line may map to zero, one, or
 * several `BackendEvent`s (e.g. an `assistant` message with two content
 * blocks fans out to two events).
 *
 * Pure: no I/O, no logging, no mutation of inputs. The caller attaches a
 * `turn_id` (the CLI's output does not carry our synthetic turn ids).
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr4-real-startturn-v1.md §1.
 *       plans/2026-04-23-clod-ui-architecture-v2.md Task 2.3.
 *
 * Ground-truth shapes (from a real probe; see plan §"Ground Truth"):
 * - `{"type":"system","subtype":"init","session_id":"...",...}` → system.init
 * - `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}`
 *   → one assistant.delta per text block, one tool.use per tool_use block
 * - `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}`
 *   → one tool.result (or tool.error when is_error) per block
 * - `{"type":"result","subtype":"success"|...,"usage":{...}}` → turn.result / turn.error
 * - `{"type":"system","subtype":"hook_started"|"hook_response",...}` → ignored
 * - `{"type":"rate_limit_event",...}` → ignored
 * - anything else → ignored
 */

/** A BackendEvent without the caller-injected `turn_id`. */
export type BackendEventInput = DistributiveOmit<BackendEvent, 'turn_id'>;

// Distributive Omit — preserves the discriminated-union structure of BackendEvent.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Parse one NDJSON line. Returns `[]` for ignored or malformed input. */
export function parseStreamJsonLine(line: string): BackendEventInput[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    obj = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = obj['type'];
  if (typeof type !== 'string') return [];

  switch (type) {
    case 'system':
      return parseSystem(obj);
    case 'assistant':
      return parseAssistant(obj);
    case 'user':
      return parseUser(obj);
    case 'result':
      return parseResult(obj);
    default:
      return []; // rate_limit_event, unknown, etc.
  }
}

/** Split a multi-line NDJSON blob and parse each line. Blanks + garbage ignored. */
export function parseStreamJsonLines(text: string): BackendEventInput[] {
  const out: BackendEventInput[] = [];
  for (const line of text.split('\n')) {
    for (const ev of parseStreamJsonLine(line)) out.push(ev);
  }
  return out;
}

// ---- per-type handlers ----------------------------------------------------

function parseSystem(obj: Record<string, unknown>): BackendEventInput[] {
  const subtype = obj['subtype'];
  if (subtype !== 'init') return [];
  const sessionId = obj['session_id'];
  if (typeof sessionId !== 'string') return [];
  return [{ kind: 'system.init', session_id: sessionId }];
}

function parseAssistant(obj: Record<string, unknown>): BackendEventInput[] {
  const message = obj['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  if (!Array.isArray(content)) return [];

  const out: BackendEventInput[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    const t = block['type'];
    if (t === 'text') {
      const text = block['text'];
      if (typeof text === 'string') {
        out.push({ kind: 'assistant.delta', text });
      }
    } else if (t === 'tool_use') {
      const id = block['id'];
      const name = block['name'];
      const input = block['input'];
      if (typeof id === 'string' && typeof name === 'string') {
        out.push({ kind: 'tool.use', tool_use_id: id, name, input });
      }
    }
    // unknown content block type → ignore
  }
  return out;
}

function parseUser(obj: Record<string, unknown>): BackendEventInput[] {
  const message = obj['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  if (!Array.isArray(content)) return [];

  const out: BackendEventInput[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block['type'] !== 'tool_result') continue;
    const toolUseId = block['tool_use_id'];
    if (typeof toolUseId !== 'string') continue;
    const isError = block['is_error'] === true;
    const body = block['content'];
    if (isError) {
      out.push({ kind: 'tool.error', tool_use_id: toolUseId, message: stringifyContent(body) });
    } else {
      out.push({ kind: 'tool.result', tool_use_id: toolUseId, content: body });
    }
  }
  return out;
}

function parseResult(obj: Record<string, unknown>): BackendEventInput[] {
  const subtype = obj['subtype'];
  const isError = obj['is_error'] === true;
  if (subtype === 'success' && !isError) {
    const usage = extractUsage(obj['usage']);
    const ev: BackendEventInput = usage ? { kind: 'turn.result', usage } : { kind: 'turn.result' };
    return [ev];
  }
  // Any non-success subtype, or `is_error: true`, maps to a coarse cli_crashed
  // for PR #4. Fine-grained taxonomy (auth_failed / rate_limited / …) → PR #5.
  const detail = typeof obj['result'] === 'string' ? (obj['result'] as string) : undefined;
  return [
    {
      kind: 'turn.error',
      error: {
        kind: 'cli_crashed',
        retryable: true,
        ...(detail !== undefined ? { detail } : {}),
      },
    },
  ];
}

function extractUsage(raw: unknown): { input_tokens?: number; output_tokens?: number } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const out: { input_tokens?: number; output_tokens?: number } = {};
  if (typeof u['input_tokens'] === 'number') out.input_tokens = u['input_tokens'];
  if (typeof u['output_tokens'] === 'number') out.output_tokens = u['output_tokens'];
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringifyContent(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) {
    const parts: string[] = [];
    for (const raw of body) {
      if (raw && typeof raw === 'object') {
        const b = raw as Record<string, unknown>;
        if (typeof b['text'] === 'string') parts.push(b['text'] as string);
      }
    }
    if (parts.length > 0) return parts.join('');
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}
