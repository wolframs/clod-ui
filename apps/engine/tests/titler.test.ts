/**
 * Unit tests for `FallbackTitler` / `fallbackFirstWordsTitle`.
 *
 * Spec: plans/landed/2026-04-25-clod-ui-pr10-auto-titling-v1.md §FallbackTitler derivation rule
 */
import { describe, expect, test } from 'bun:test';

import { fallbackFirstWordsTitle, FallbackTitler } from '../src/titler.ts';

const FIXED_TS = 1_700_000_000_000; // 2023-11-14 22:13 UTC

describe('fallbackFirstWordsTitle — pure derivation', () => {
  test('takes first 8 words from a long input', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: 'one two three four five six seven eight nine ten eleven twelve thirteen',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('one two three four five six seven eight');
  });

  test('splits at the first sentence terminator (period)', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: 'Refactor the login form. Then add tests for it.',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('Refactor the login form');
  });

  test('splits at exclamation', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: 'Help me ship this! It is overdue.',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('Help me ship this');
  });

  test('splits at question mark', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: 'What is the runtime complexity? Explain it concisely.',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('What is the runtime complexity');
  });

  test('splits at the first of (period, !, ?, newline) — earliest wins', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: 'Quick question?\nThen a long explanation.',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('Quick question');
  });

  test('multi-line input — splits at first newline', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: 'Line one\nLine two\nLine three',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('Line one');
  });

  test('caps individual word length at 24 characters', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: 'pneumonoultramicroscopicsilicovolcanoconiosis is a long word',
      assistant_text: '',
      ts: FIXED_TS,
    });
    // Word capped to 24 chars, then the rest of the words follow up to MAX_WORDS.
    expect(out).toBe('pneumonoultramicroscopic is a long word');
  });

  test('caps total title length at 80 characters', () => {
    // Eight 24-char words separated by spaces = 8*24 + 7 = 199 chars before the
    // 80-char joined cap kicks in.
    const word = 'a'.repeat(24);
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: Array(8).fill(word).join(' '),
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out.length).toBeLessThanOrEqual(80);
  });

  test('trims leading and trailing whitespace before processing', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: '   \t hello world  \n',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('hello world');
  });

  test('empty input → date-stamped fallback', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: '',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('Conversation @ 2023-11-14 22:13');
  });

  test('whitespace-only input → date-stamped fallback', () => {
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: '   \n\t  ',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('Conversation @ 2023-11-14 22:13');
  });

  test('punctuation-only first sentence → date-stamped fallback', () => {
    // `?` alone before the sentence terminator means the first sentence is empty.
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: '? followed by stuff',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out).toBe('Conversation @ 2023-11-14 22:13');
  });

  test('determinism — same input twice yields identical output', () => {
    const a = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: 'Refactor the login form',
      assistant_text: 'ignored by the fallback',
      ts: FIXED_TS,
    });
    const b = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: 'Refactor the login form',
      assistant_text: 'still ignored',
      ts: FIXED_TS,
    });
    expect(a).toBe(b);
  });

  test('date-stamped fallback uses UTC, padding single-digit fields', () => {
    // 2024-01-05 03:09 UTC
    const ts = Date.UTC(2024, 0, 5, 3, 9, 0);
    const out = fallbackFirstWordsTitle({
      conv_id: 'c',
      user_message: '',
      assistant_text: '',
      ts,
    });
    expect(out).toBe('Conversation @ 2024-01-05 03:09');
  });
});

describe('FallbackTitler class', () => {
  test('suggestTitle resolves with the same value as the pure fn', async () => {
    const titler = new FallbackTitler();
    const input = {
      conv_id: 'c',
      user_message: 'Build the auto-titler',
      assistant_text: '',
      ts: FIXED_TS,
    };
    const out = await titler.suggestTitle(input);
    expect(out).toBe(fallbackFirstWordsTitle(input));
  });

  test('always returns a non-empty string (Titler contract)', async () => {
    const titler = new FallbackTitler();
    const out = await titler.suggestTitle({
      conv_id: 'c',
      user_message: '',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out.length).toBeGreaterThan(0);
  });
});
