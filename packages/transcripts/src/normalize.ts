import type {
  ChatMessage,
  ContentBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
  TextBlock,
} from '@clod-ui/contracts';

import type { TranscriptLine } from './types.ts';

/**
 * Pure transformation `TranscriptLine[] → ChatMessage[]`.
 *
 * Spec: plans/landed/2026-04-24-clod-ui-pr9-chatmessage-normalization-v1.md.
 *
 * Properties (test-pinned):
 *   - **Pure**: no IO, no `Date.now()`, same input → same output.
 *   - **Idempotent**: calling twice on the same input is deep-equal.
 *   - **Incremental**: `normalize(prefix ++ suffix)` deep-equals
 *     `normalize(prefix).messages ++ normalize(suffix).messages` provided the
 *     suffix's `line_number`s continue from the prefix.
 *   - **Lossy by design**: `system`/`result`/hook lines are dropped (with a
 *     reason recorded in `skipped[]`); a line with no recognized content
 *     yields a `skipped{reason:'no_content'}` rather than an empty message.
 */

export interface SkippedLine {
  line_number: number;
  reason: 'parse_error' | 'system_event' | 'unknown_role' | 'no_content';
}

export interface NormalizationResult {
  messages: ChatMessage[];
  skipped: SkippedLine[];
}

/** Apply the per-line normalizer over a batch and split messages from skips. */
export function normalizeTranscriptLines(lines: readonly TranscriptLine[]): NormalizationResult {
  const messages: ChatMessage[] = [];
  const skipped: SkippedLine[] = [];
  for (const line of lines) {
    const out = normalizeOne(line);
    if (out.kind === 'message') messages.push(out.message);
    else skipped.push(out.skip);
  }
  return { messages, skipped };
}

/** Deterministic stable identifier from a line's number. */
export function messageId(line_number: number): string {
  return `msg-${line_number}`;
}

// ---- per-line ----------------------------------------------------------

type OneResult = { kind: 'message'; message: ChatMessage } | { kind: 'skip'; skip: SkippedLine };

/** Normalize a single transcript line. Exported for table-test ergonomics. */
export function normalizeOne(line: TranscriptLine): OneResult {
  if (line.parse_error !== undefined) {
    return skip(line, 'parse_error');
  }
  const raw = line.raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return skip(line, 'system_event');
  }
  const obj = raw as Record<string, unknown>;
  const type = obj['type'];
  if (type !== 'user' && type !== 'assistant') {
    // system / result / rate_limit_event / unknown — not chat messages.
    return skip(line, 'system_event');
  }

  const message = obj['message'];
  if (message === null || typeof message !== 'object') {
    return skip(line, 'no_content');
  }
  const msgObj = message as Record<string, unknown>;

  // Role discipline: a `type:'user'` line with `role:'assistant'` (or vice
  // versa) is treated as a hard mismatch rather than silently coerced.
  // CC has been seen to omit `role` entirely; in that case we trust `type`.
  const declaredRole = msgObj['role'];
  if (declaredRole !== undefined && declaredRole !== type) {
    return skip(line, 'unknown_role');
  }

  const rawContent = msgObj['content'];
  if (!Array.isArray(rawContent)) {
    return skip(line, 'no_content');
  }
  const content = extractBlocks(rawContent);
  if (content.length === 0) {
    return skip(line, 'no_content');
  }

  const message_out: ChatMessage = {
    id: messageId(line.line_number),
    role: type,
    content,
    source: { line_number: line.line_number, byte_offset: line.byte_offset },
  };
  return { kind: 'message', message: message_out };
}

function skip(line: TranscriptLine, reason: SkippedLine['reason']): OneResult {
  return { kind: 'skip', skip: { line_number: line.line_number, reason } };
}

/** Walk the source content array; emit one ContentBlock per recognized entry. */
export function extractBlocks(rawContent: readonly unknown[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const raw of rawContent) {
    const block = toBlock(raw);
    if (block) out.push(block);
  }
  return out;
}

function toBlock(raw: unknown): ContentBlock | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  switch (b['type']) {
    case 'text':
      return toTextBlock(b);
    case 'thinking':
      return toThinkingBlock(b);
    case 'tool_use':
      return toToolUseBlock(b);
    case 'tool_result':
      return toToolResultBlock(b);
    default:
      return null;
  }
}

function toTextBlock(b: Record<string, unknown>): TextBlock | null {
  const text = b['text'];
  if (typeof text !== 'string') return null;
  return { type: 'text', text };
}

function toThinkingBlock(b: Record<string, unknown>): ThinkingBlock | null {
  // CC names this field `thinking` in the JSONL; we surface it as `text` for
  // shape-uniformity with TextBlock (consumers can render both via the same
  // markdown pipeline). Some lines also carry the legacy `text` key.
  const rawText = b['thinking'] ?? b['text'];
  if (typeof rawText !== 'string') return null;
  const sig = b['signature'];
  return {
    type: 'thinking',
    text: rawText,
    ...(typeof sig === 'string' ? { signature: sig } : {}),
  };
}

function toToolUseBlock(b: Record<string, unknown>): ToolUseBlock | null {
  const id = b['id'] ?? b['tool_use_id'];
  const name = b['name'];
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  return {
    type: 'tool_use',
    tool_use_id: id,
    name,
    input: b['input'],
  };
}

function toToolResultBlock(b: Record<string, unknown>): ToolResultBlock | null {
  const id = b['tool_use_id'];
  if (typeof id !== 'string') return null;
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: b['content'],
    is_error: b['is_error'] === true,
  };
}
