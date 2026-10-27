import { describe, expect, test } from 'bun:test';

import { THINKING_EFFORT_VALUES, ThinkingEffortSchema } from '../src/turn.ts';

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
