import { describe, expect, test } from 'bun:test';

import { parseTranscriptLine } from '../src/index.ts';

describe('parseTranscriptLine', () => {
  test('valid JSON object → parsed payload as raw, no parse_error', () => {
    const result = parseTranscriptLine(0, 0, '{"type":"user","content":"hi"}');
    expect(result.line_number).toBe(0);
    expect(result.byte_offset).toBe(0);
    expect(result.parse_error).toBeUndefined();
    expect(result.raw).toEqual({ type: 'user', content: 'hi' });
  });

  test('valid JSON primitive (number) → raw is number, no parse_error', () => {
    // The schema treats raw as `unknown` and does not constrain to objects;
    // the watcher and the historical reader behave consistently here. Only
    // syntactically malformed JSON triggers parse_error.
    const result = parseTranscriptLine(1, 10, '42');
    expect(result.parse_error).toBeUndefined();
    expect(result.raw).toBe(42);
  });

  test('valid JSON array → raw is array, no parse_error', () => {
    const result = parseTranscriptLine(2, 20, '[1,2,3]');
    expect(result.parse_error).toBeUndefined();
    expect(result.raw).toEqual([1, 2, 3]);
  });

  test('valid JSON null → raw is null, no parse_error', () => {
    const result = parseTranscriptLine(3, 30, 'null');
    expect(result.parse_error).toBeUndefined();
    expect(result.raw).toBeNull();
  });

  test('invalid JSON → parse_error set with raw_text preserved, raw is null', () => {
    const result = parseTranscriptLine(5, 200, '{not json');
    expect(result.line_number).toBe(5);
    expect(result.byte_offset).toBe(200);
    expect(result.raw).toBeNull();
    expect(result.parse_error).toBeDefined();
    expect(result.parse_error?.raw_text).toBe('{not json');
    expect(result.parse_error?.message).toContain('JSON');
  });

  test('empty string → parse_error', () => {
    const result = parseTranscriptLine(0, 0, '');
    expect(result.parse_error).toBeDefined();
    expect(result.raw).toBeNull();
  });

  test('whitespace-only → parse_error', () => {
    const result = parseTranscriptLine(0, 0, '   ');
    expect(result.parse_error).toBeDefined();
    expect(result.raw).toBeNull();
  });

  test('preserves unicode in parsed raw', () => {
    const result = parseTranscriptLine(7, 700, '{"text":"héllo 🌀 — emoji"}');
    expect(result.raw).toEqual({ text: 'héllo 🌀 — emoji' });
  });

  test('byte_offset and line_number flow through verbatim', () => {
    const result = parseTranscriptLine(42, 9999, '{}');
    expect(result.line_number).toBe(42);
    expect(result.byte_offset).toBe(9999);
  });
});
