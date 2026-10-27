/**
 * TranscriptLineSchema + TranscriptResponseSchema unit tests. Pins the wire
 * shape that backs `GET /conversations/:id/transcript`.
 *
 * Spec: plans/landed/2026-05-02-clod-ui-pr20a-transcript-route-v1.md §3.
 */
import { describe, expect, test } from 'bun:test';

import { TranscriptLineSchema, TranscriptResponseSchema } from '../src/transcript.ts';

describe('TranscriptLineSchema', () => {
  test('accepts a fully-parsed line with raw payload', () => {
    const result = TranscriptLineSchema.safeParse({
      line_number: 0,
      byte_offset: 0,
      raw: { type: 'user', content: 'hi' },
    });
    expect(result.success).toBe(true);
  });

  test('accepts a line with parse_error and no raw', () => {
    const result = TranscriptLineSchema.safeParse({
      line_number: 5,
      byte_offset: 200,
      parse_error: { message: 'Unexpected token', raw_text: 'not json' },
    });
    expect(result.success).toBe(true);
  });

  test('accepts a line with both raw and parse_error (forward-compat)', () => {
    const result = TranscriptLineSchema.safeParse({
      line_number: 3,
      byte_offset: 100,
      raw: { type: 'partial' },
      parse_error: { message: 'partial', raw_text: '{"type":"partial"' },
    });
    expect(result.success).toBe(true);
  });

  test('rejects negative line_number', () => {
    const result = TranscriptLineSchema.safeParse({
      line_number: -1,
      byte_offset: 0,
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer byte_offset', () => {
    const result = TranscriptLineSchema.safeParse({
      line_number: 0,
      byte_offset: 1.5,
    });
    expect(result.success).toBe(false);
  });

  test('rejects parse_error missing raw_text', () => {
    const result = TranscriptLineSchema.safeParse({
      line_number: 0,
      byte_offset: 0,
      parse_error: { message: 'oops' },
    });
    expect(result.success).toBe(false);
  });
});

describe('TranscriptResponseSchema', () => {
  test('accepts empty lines array', () => {
    const result = TranscriptResponseSchema.safeParse({ lines: [] });
    expect(result.success).toBe(true);
  });

  test('accepts a multi-line transcript', () => {
    const result = TranscriptResponseSchema.safeParse({
      lines: [
        { line_number: 0, byte_offset: 0, raw: { type: 'user', text: 'hi' } },
        { line_number: 1, byte_offset: 32, raw: { type: 'assistant', text: 'hello' } },
      ],
    });
    expect(result.success).toBe(true);
  });

  test('rejects when lines field is missing', () => {
    const result = TranscriptResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('rejects when lines is not an array', () => {
    const result = TranscriptResponseSchema.safeParse({ lines: 'not an array' });
    expect(result.success).toBe(false);
  });
});
