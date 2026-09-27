import { describe, expect, test } from 'bun:test';

import { parseStreamJsonLine, parseStreamJsonLines } from '../src/parse-stream-json.ts';

/**
 * Parser table tests. Fixtures are abbreviated forms of shapes observed in a
 * real `claude -p --output-format stream-json --verbose` probe.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr4-real-startturn-v1.md §2.
 */

describe('parseStreamJsonLine — ignored shapes', () => {
  test.each([
    ['blank line', ''],
    ['whitespace only', '   \t'],
    ['malformed JSON', '{not json}'],
    ['JSON primitive', 'null'],
    ['JSON array', '[1,2,3]'],
    ['missing type', '{"foo":"bar"}'],
    ['unknown type', '{"type":"mystery","session_id":"x"}'],
    ['rate_limit_event', '{"type":"rate_limit_event","rate_limit_info":{}}'],
    ['hook_started', '{"type":"system","subtype":"hook_started","hook_id":"x"}'],
    ['hook_response', '{"type":"system","subtype":"hook_response","hook_id":"x"}'],
    ['system init without session_id', '{"type":"system","subtype":"init"}'],
  ] as const)('%s → []', (_label, line) => {
    expect(parseStreamJsonLine(line)).toEqual([]);
  });
});

describe('parseStreamJsonLine — system.init', () => {
  test('emits system.init with the session_id', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: '9d089e9d-5e40-4909-a74b-42dc2b4cb6f9',
      cwd: '/tmp',
      tools: ['Read', 'Edit'],
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'system.init', session_id: '9d089e9d-5e40-4909-a74b-42dc2b4cb6f9' },
    ]);
  });
});

describe('parseStreamJsonLine — assistant messages', () => {
  test('single text block → one assistant.delta', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there, friend' }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'assistant.delta', text: 'Hi there, friend' },
    ]);
  });

  test('multiple text blocks → multiple assistant.delta in order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'assistant.delta', text: 'first' },
      { kind: 'assistant.delta', text: 'second' },
    ]);
  });

  test('tool_use block → tool.use with id/name/input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/x' } }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'tool.use', tool_use_id: 'tu-1', name: 'Read', input: { path: '/x' } },
    ]);
  });

  test('mixed text + tool_use in one assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'tu-2', name: 'Read', input: { path: '/y' } },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'assistant.delta', text: 'let me check' },
      { kind: 'tool.use', tool_use_id: 'tu-2', name: 'Read', input: { path: '/y' } },
    ]);
  });

  test('unknown content block type is ignored', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'a' },
          { type: 'thinking', thinking: 'internal' }, // not yet modeled
          { type: 'text', text: 'b' },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'assistant.delta', text: 'a' },
      { kind: 'assistant.delta', text: 'b' },
    ]);
  });

  test('missing content → empty', () => {
    const line = JSON.stringify({ type: 'assistant', message: {} });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });
});

describe('parseStreamJsonLine — user tool_results', () => {
  test('tool_result with string content → tool.result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents' }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'tool.result', tool_use_id: 'tu-1', content: 'file contents' },
    ]);
  });

  test('tool_result with is_error=true → tool.error with string message', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true, content: 'oops' }],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'tool.error', tool_use_id: 'tu-1', message: 'oops' },
    ]);
  });

  test('tool_result with array content collapses text parts', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-2',
            is_error: true,
            content: [
              { type: 'text', text: 'line1' },
              { type: 'text', text: 'line2' },
            ],
          },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'tool.error', tool_use_id: 'tu-2', message: 'line1line2' },
    ]);
  });
});

describe('parseStreamJsonLine — result', () => {
  test('subtype=success → turn.result with usage', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 's',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
    });
    expect(parseStreamJsonLine(line)).toEqual([
      { kind: 'turn.result', usage: { input_tokens: 10, output_tokens: 20 } },
    ]);
  });

  test('subtype=success with no usage fields → turn.result with no usage', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success' });
    expect(parseStreamJsonLine(line)).toEqual([{ kind: 'turn.result' }]);
  });

  test('subtype=error_during_execution → turn.error{cli_crashed} with detail', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'blew up',
    });
    expect(parseStreamJsonLine(line)).toEqual([
      {
        kind: 'turn.error',
        error: { kind: 'cli_crashed', retryable: true, detail: 'blew up' },
      },
    ]);
  });

  test('subtype=success but is_error=true → treated as error (defensive)', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'lie',
    });
    const events = parseStreamJsonLine(line);
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe('turn.error');
  });
});

describe('parseStreamJsonLines — multi-line', () => {
  test('splits on \\n, drops blanks + garbage, preserves order', () => {
    const text = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      '',
      '{malformed}',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({ type: 'rate_limit_event' }),
      JSON.stringify({ type: 'result', subtype: 'success' }),
      '',
    ].join('\n');
    expect(parseStreamJsonLines(text)).toEqual([
      { kind: 'system.init', session_id: 's1' },
      { kind: 'assistant.delta', text: 'hi' },
      { kind: 'turn.result' },
    ]);
  });
});
