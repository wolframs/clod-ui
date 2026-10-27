/**
 * Pure-helper tests for `lib/turn-controls.ts` (PR #25):
 * `effectiveSystemPrompt` draft semantics — the wire never sees an
 * empty/whitespace-only prompt.
 */
import { describe, expect, test } from 'bun:test';

import {
  effectiveExtraArgv,
  effectiveSystemPrompt,
  formatToolEntry,
  parseExtraArgv,
  parseToolEntry,
  toggleToolEntry,
} from '../src/lib/turn-controls.ts';

describe('effectiveSystemPrompt', () => {
  test('absent draft → undefined', () => {
    expect(effectiveSystemPrompt({})).toBeUndefined();
  });

  test('empty and whitespace-only drafts → undefined', () => {
    expect(effectiveSystemPrompt({ system_prompt: { mode: 'append', text: '' } })).toBeUndefined();
    expect(
      effectiveSystemPrompt({ system_prompt: { mode: 'override', text: ' \n\t ' } }),
    ).toBeUndefined();
  });

  test('non-empty draft passes through untouched (both modes)', () => {
    const append = { mode: 'append', text: 'be terse' } as const;
    expect(effectiveSystemPrompt({ system_prompt: append })).toEqual(append);
    const override = { mode: 'override', text: 'you are a pirate' } as const;
    expect(effectiveSystemPrompt({ system_prompt: override })).toEqual(override);
  });
});

describe('parseExtraArgv', () => {
  test('one trimmed token per line, empties dropped', () => {
    expect(parseExtraArgv('--fork-session\n  --model  \n\nopus\n')).toEqual([
      '--fork-session',
      '--model',
      'opus',
    ]);
  });

  test('spaces within a line stay verbatim (no shell splitting)', () => {
    expect(parseExtraArgv('--append-system-prompt\nbe terse, always')).toEqual([
      '--append-system-prompt',
      'be terse, always',
    ]);
  });

  test('empty and whitespace-only text yield no tokens', () => {
    expect(parseExtraArgv('')).toEqual([]);
    expect(parseExtraArgv(' \n \n')).toEqual([]);
  });
});

describe('effectiveExtraArgv', () => {
  test('absent and empty drafts → undefined', () => {
    expect(effectiveExtraArgv({})).toBeUndefined();
    expect(effectiveExtraArgv({ extra_argv_text: ' \n ' })).toBeUndefined();
  });

  test('tokens pass through', () => {
    expect(effectiveExtraArgv({ extra_argv_text: '-d\n--verbose' })).toEqual(['-d', '--verbose']);
  });
});

describe('parseToolEntry / formatToolEntry', () => {
  test('accepts bare names and Name(pattern), trimmed', () => {
    expect(parseToolEntry('Read')).toEqual({ name: 'Read' });
    expect(parseToolEntry('  Bash(npm run *)  ')).toEqual({ name: 'Bash', pattern: 'npm run *' });
    expect(parseToolEntry('Bash(git commit:*)')).toEqual({
      name: 'Bash',
      pattern: 'git commit:*',
    });
  });

  test('rejects malformed entries', () => {
    expect(parseToolEntry('')).toBeNull();
    expect(parseToolEntry('   ')).toBeNull();
    expect(parseToolEntry('(npm)')).toBeNull(); // empty name
    expect(parseToolEntry('Bash(')).toBeNull(); // unbalanced
    expect(parseToolEntry('Bash()')).toBeNull(); // empty pattern
    expect(parseToolEntry('Bash(a))')).toBeNull(); // extra paren in pattern
    expect(parseToolEntry('Bash(a) x')).toBeNull(); // trailing text
    expect(parseToolEntry('two words')).toBeNull(); // not a name
  });

  test('format is the inverse of parse', () => {
    for (const raw of ['Read', 'Bash(npm run *)']) {
      const entry = parseToolEntry(raw);
      expect(entry).not.toBeNull();
      if (entry) expect(formatToolEntry(entry)).toBe(raw);
    }
  });
});

describe('toggleToolEntry', () => {
  test('adds deduped and removes; empty result drops to undefined', () => {
    expect(toggleToolEntry(undefined, 'Read', true)).toEqual(['Read']);
    expect(toggleToolEntry(['Read'], 'Read', true)).toEqual(['Read']);
    expect(toggleToolEntry(['Read', 'Bash(x)'], 'Read', false)).toEqual(['Bash(x)']);
    expect(toggleToolEntry(['Read'], 'Read', false)).toBeUndefined();
  });
});
