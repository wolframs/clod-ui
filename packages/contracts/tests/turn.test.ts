import { describe, expect, test } from 'bun:test';

import { ModelsResponseSchema } from '../src/models.ts';
import {
  THINKING_EFFORT_VALUES,
  ThinkingEffortSchema,
  normalizeThinkingEffort,
} from '../src/turn.ts';

describe('ThinkingEffortSchema', () => {
  test('accepts every documented effort value', () => {
    for (const value of THINKING_EFFORT_VALUES) {
      expect(ThinkingEffortSchema.safeParse(value).success).toBe(true);
    }
  });

  test('rejects unknown strings and non-strings', () => {
    for (const bad of ['banana', 'THINK', 'think hard', '', 42, null, {}]) {
      expect(ThinkingEffortSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('effort vocabulary (PR #42)', () => {
  test("is the CLI's own /effort list, in its order", () => {
    expect([...THINKING_EFFORT_VALUES]).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ]);
  });

  test('pre-#42 names map to the --effort they used to compose', () => {
    expect(normalizeThinkingEffort('off')).toBe('auto');
    expect(normalizeThinkingEffort('think')).toBe('low');
    expect(normalizeThinkingEffort('think_hard')).toBe('medium');
    expect(normalizeThinkingEffort('think_harder')).toBe('high');
    expect(normalizeThinkingEffort('ultrathink')).toBe('max');
    expect(normalizeThinkingEffort('xhigh')).toBe('xhigh');
    expect(normalizeThinkingEffort('banana')).toBeUndefined();
    expect(normalizeThinkingEffort(3)).toBeUndefined();
  });
});

describe('ModelsResponseSchema', () => {
  test('accepts a CLI-shaped list; effort levels are the shared vocabulary', () => {
    const ok = ModelsResponseSchema.safeParse({
      fetched_at: 1,
      models: [
        {
          value: 'default',
          resolved_model: 'claude-fable-5-1',
          display_name: 'Default (recommended)',
        },
        { value: 'claude-opus-4-6', display_name: 'Opus 4.6', effort_levels: ['low', 'max'] },
      ],
    });
    expect(ok.success).toBe(true);
    const bad = ModelsResponseSchema.safeParse({
      fetched_at: 1,
      models: [{ value: 'x', display_name: 'X', effort_levels: ['turbo'] }],
    });
    expect(bad.success).toBe(false);
  });
});
