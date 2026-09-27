import { ChatMessageSchema, type ChatMessage } from '@clod-ui/contracts';
import { describe, expect, test } from 'bun:test';

import {
  extractBlocks,
  messageId,
  normalizeOne,
  normalizeTranscriptLines,
} from '../src/normalize.ts';
import type { TranscriptLine } from '../src/types.ts';

/**
 * Unit tests for the pure JSONL → ChatMessage transformer.
 *
 * Spec: plans/landed/2026-04-24-clod-ui-pr9-chatmessage-normalization-v1.md.
 */

// ---- helpers -------------------------------------------------------------

let nextLineNumber = 0;
let nextByteOffset = 0;
function reset(): void {
  nextLineNumber = 0;
  nextByteOffset = 0;
}
/** Build a TranscriptLine carrying the given decoded JSON object. */
function line(raw: unknown): TranscriptLine {
  const ln: TranscriptLine = {
    line_number: nextLineNumber,
    byte_offset: nextByteOffset,
    raw,
  };
  nextLineNumber += 1;
  // The exact byte offset is irrelevant to the transform; we just keep it
  // monotonic so source provenance is plausible.
  nextByteOffset += 64;
  return ln;
}
/** Build a TranscriptLine that itself failed to parse upstream. */
function badLine(raw_text = '<garbage>'): TranscriptLine {
  const ln: TranscriptLine = {
    line_number: nextLineNumber,
    byte_offset: nextByteOffset,
    raw: null,
    parse_error: { message: 'unexpected token', raw_text },
  };
  nextLineNumber += 1;
  nextByteOffset += 64;
  return ln;
}

// ---- mapping table ------------------------------------------------------

describe('normalizeOne — mapping table', () => {
  test('user text → ChatMessage{role:user, [text]}', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      }),
    );
    expect(out.kind).toBe('message');
    if (out.kind !== 'message') throw new Error('unreachable');
    expect(out.message).toEqual({
      id: 'msg-0',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { line_number: 0, byte_offset: 0 },
    });
  });

  test('user tool_result (success) → ChatMessage{role:user, [tool_result is_error:false]}', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: 'output',
            },
          ],
        },
      }),
    );
    expect(out.kind).toBe('message');
    if (out.kind !== 'message') throw new Error('unreachable');
    expect(out.message.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu-1', content: 'output', is_error: false },
    ]);
  });

  test('user tool_result with is_error:true → is_error preserved', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-2',
              content: [{ type: 'text', text: 'oops' }],
              is_error: true,
            },
          ],
        },
      }),
    );
    if (out.kind !== 'message') throw new Error('unreachable');
    const block = out.message.content[0];
    expect(block?.type).toBe('tool_result');
    if (block?.type !== 'tool_result') throw new Error('unreachable');
    expect(block.is_error).toBe(true);
    // tool_result.content is preserved verbatim — UI decides how to render.
    expect(block.content).toEqual([{ type: 'text', text: 'oops' }]);
  });

  test('assistant text → ChatMessage{role:assistant, [text]}', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
    );
    if (out.kind !== 'message') throw new Error('unreachable');
    expect(out.message.role).toBe('assistant');
    expect(out.message.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  test('assistant tool_use → tool_use_id derived from id, input passthrough', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-99', name: 'Read', input: { path: '/x' } }],
        },
      }),
    );
    if (out.kind !== 'message') throw new Error('unreachable');
    expect(out.message.content).toEqual([
      { type: 'tool_use', tool_use_id: 'tu-99', name: 'Read', input: { path: '/x' } },
    ]);
  });

  test('assistant thinking with `thinking` key → text + signature when present', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'thinking', thinking: 'pondering...', signature: 'sig123' }],
        },
      }),
    );
    if (out.kind !== 'message') throw new Error('unreachable');
    expect(out.message.content).toEqual([
      { type: 'thinking', text: 'pondering...', signature: 'sig123' },
    ]);
  });

  test('assistant thinking with `text` key (legacy) → text without signature', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'assistant',
        message: { content: [{ type: 'thinking', text: 'pondering...' }] },
      }),
    );
    if (out.kind !== 'message') throw new Error('unreachable');
    const block = out.message.content[0];
    expect(block).toEqual({ type: 'thinking', text: 'pondering...' });
    // exactOptionalPropertyTypes: signature key is omitted, not undefined.
    expect('signature' in (block as object)).toBe(false);
  });

  test('multi-block content preserves source order [text, tool_use, text]', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'tool_use', id: 'tu-x', name: 'Bash', input: { cmd: 'ls' } },
            { type: 'text', text: 'second' },
          ],
        },
      }),
    );
    if (out.kind !== 'message') throw new Error('unreachable');
    expect(out.message.content.map((b) => b.type)).toEqual(['text', 'tool_use', 'text']);
    expect((out.message.content[0] as { text: string }).text).toBe('first');
    expect((out.message.content[2] as { text: string }).text).toBe('second');
  });
});

// ---- skipped lines ------------------------------------------------------

describe('normalizeOne — skip rules', () => {
  test('parse_error → skip{reason:parse_error}', () => {
    reset();
    const out = normalizeOne(badLine());
    expect(out).toEqual({ kind: 'skip', skip: { line_number: 0, reason: 'parse_error' } });
  });

  test.each([
    ['system init', { type: 'system', subtype: 'init', session_id: 's' }],
    ['system hook', { type: 'system', subtype: 'hook_started' }],
    ['result success', { type: 'result', subtype: 'success' }],
    ['rate_limit_event', { type: 'rate_limit_event' }],
    ['unknown type', { type: 'mystery' }],
    ['top-level array', ['not', 'an', 'object']],
    ['top-level null', null],
  ] as const)('%s → skip{reason:system_event}', (_label, raw) => {
    reset();
    const out = normalizeOne(line(raw));
    expect(out.kind).toBe('skip');
    if (out.kind !== 'skip') throw new Error('unreachable');
    expect(out.skip.reason).toBe('system_event');
  });

  test('user line with role:assistant → skip{unknown_role}', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'user',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      }),
    );
    expect(out.kind).toBe('skip');
    if (out.kind !== 'skip') throw new Error('unreachable');
    expect(out.skip.reason).toBe('unknown_role');
  });

  test('user line with no message → skip{no_content}', () => {
    reset();
    const out = normalizeOne(line({ type: 'user' }));
    expect(out.kind).toBe('skip');
    if (out.kind !== 'skip') throw new Error('unreachable');
    expect(out.skip.reason).toBe('no_content');
  });

  test('assistant line with empty content array → skip{no_content}', () => {
    reset();
    const out = normalizeOne(line({ type: 'assistant', message: { content: [] } }));
    expect(out.kind).toBe('skip');
    if (out.kind !== 'skip') throw new Error('unreachable');
    expect(out.skip.reason).toBe('no_content');
  });

  test('assistant line whose blocks are all unrecognized → skip{no_content}', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'image_url', url: 'https://x' }, { type: 'something_new' }],
        },
      }),
    );
    expect(out.kind).toBe('skip');
    if (out.kind !== 'skip') throw new Error('unreachable');
    expect(out.skip.reason).toBe('no_content');
  });

  test('mixed blocks (one recognized + one unrecognized) → message keeps the recognized one', () => {
    reset();
    const out = normalizeOne(
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'image_url', url: 'https://x' },
            { type: 'text', text: 'kept' },
          ],
        },
      }),
    );
    if (out.kind !== 'message') throw new Error('unreachable');
    expect(out.message.content).toEqual([{ type: 'text', text: 'kept' }]);
  });
});

// ---- properties ---------------------------------------------------------

describe('normalizeTranscriptLines — properties', () => {
  test('idempotent: calling twice on the same input deep-equals', () => {
    reset();
    const lines = [
      line({ type: 'system', subtype: 'init', session_id: 's' }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } }),
    ];
    const a = normalizeTranscriptLines(lines);
    const b = normalizeTranscriptLines(lines);
    expect(a).toEqual(b);
  });

  test('incremental: normalize(prefix ++ suffix) ≡ messages(prefix) ++ messages(suffix)', () => {
    reset();
    const all: TranscriptLine[] = [
      line({ type: 'system', subtype: 'init', session_id: 's' }),
      line({ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } }),
      line({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }] },
      }),
      line({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
        },
      }),
    ];
    const split = 2;
    const prefix = all.slice(0, split);
    const suffix = all.slice(split);
    const fullMsgs = normalizeTranscriptLines(all).messages;
    const splitMsgs = [
      ...normalizeTranscriptLines(prefix).messages,
      ...normalizeTranscriptLines(suffix).messages,
    ];
    expect(splitMsgs).toEqual(fullMsgs);
  });

  test('every produced ChatMessage validates against ChatMessageSchema', () => {
    reset();
    const lines = [
      line({ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } }),
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'pondering' },
            { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { cmd: 'ls' } },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'README.md', is_error: false },
          ],
        },
      }),
    ];
    const { messages } = normalizeTranscriptLines(lines);
    expect(messages).toHaveLength(3);
    for (const m of messages) {
      const parsed = ChatMessageSchema.safeParse(m);
      expect(parsed.success).toBe(true);
    }
  });

  test('messages preserve their source line_number / byte_offset', () => {
    reset();
    const a = line({ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } });
    const b = line({ type: 'system', subtype: 'init', session_id: 's' });
    const c = line({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'a' }] },
    });
    const { messages, skipped } = normalizeTranscriptLines([a, b, c]);
    expect(messages.map((m) => m.source)).toEqual([
      { line_number: a.line_number, byte_offset: a.byte_offset },
      { line_number: c.line_number, byte_offset: c.byte_offset },
    ]);
    expect(skipped).toEqual([{ line_number: b.line_number, reason: 'system_event' }]);
  });
});

// ---- realistic transcript fixture ---------------------------------------

describe('normalizeTranscriptLines — golden transcript', () => {
  test('representative 8-line transcript folds to the expected ChatMessage[]', () => {
    reset();
    const lines: TranscriptLine[] = [
      line({
        type: 'system',
        subtype: 'init',
        session_id: '9d089e9d-5e40-4909-a74b-42dc2b4cb6f9',
        cwd: '/tmp',
      }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'list this dir' }] },
      }),
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll list it." },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      line({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'README.md\nsrc/' }],
        },
      }),
      line({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'they want a summary' },
            { type: 'text', text: 'two entries: README.md and src/' },
          ],
        },
      }),
      badLine('partial-line-from-crash'),
      line({ type: 'system', subtype: 'hook_response', hook_id: 'h1' }),
      line({ type: 'result', subtype: 'success', usage: { input_tokens: 10 } }),
    ];

    const { messages, skipped } = normalizeTranscriptLines(lines);

    // Exactly four real messages, in chronological order.
    expect(messages.map((m) => ({ role: m.role, types: m.content.map((b) => b.type) }))).toEqual([
      { role: 'user', types: ['text'] },
      { role: 'assistant', types: ['text', 'tool_use'] },
      { role: 'user', types: ['tool_result'] },
      { role: 'assistant', types: ['thinking', 'text'] },
    ]);

    // Skipped lines: one parse_error, three system events.
    const reasons = skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(['parse_error', 'system_event', 'system_event', 'system_event']);
    // Every skipped line knows its source.
    expect(skipped.every((s) => Number.isInteger(s.line_number) && s.line_number >= 0)).toBe(true);

    // Stable ids derived from the source line_number.
    expect(messages.map((m) => m.id)).toEqual([
      messageId(1),
      messageId(2),
      messageId(3),
      messageId(4),
    ]);
  });
});

// ---- extractBlocks (table-test friendly low-level helper) ---------------

describe('extractBlocks', () => {
  test('drops null/non-object/non-string-id blocks', () => {
    const out = extractBlocks([
      null,
      'not an object',
      { type: 'text' /* missing text */ },
      { type: 'tool_use', name: 'Read' /* missing id */ },
      { type: 'tool_result' /* missing tool_use_id */ },
      { type: 'text', text: 'kept' },
    ]);
    expect(out).toEqual([{ type: 'text', text: 'kept' }]);
  });

  test('tool_use accepts either `id` or `tool_use_id` field name', () => {
    const out = extractBlocks([{ type: 'tool_use', tool_use_id: 'tu-x', name: 'Bash', input: {} }]);
    const block = out[0];
    expect(block?.type).toBe('tool_use');
    if (block?.type !== 'tool_use') throw new Error('unreachable');
    expect(block.tool_use_id).toBe('tu-x');
  });
});

// ---- exhaustiveness sanity ----------------------------------------------

describe('messageId', () => {
  test('returns a deterministic, line-derived id', () => {
    expect(messageId(0)).toBe('msg-0');
    expect(messageId(42)).toBe('msg-42');
  });
});

// Deep-equal check for ChatMessage (compile-time guard against accidental
// drift between the schema and the test's expectation type).
const _typeGuard: ChatMessage = {
  id: 'msg-0',
  role: 'user',
  content: [{ type: 'text', text: 'x' }],
  source: { line_number: 0, byte_offset: 0 },
};
void _typeGuard;
