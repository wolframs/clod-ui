import { describe, expect, test } from 'bun:test';

import { controlsSummary, hasExtraControls } from '../src/components/mobile-controls.tsx';

const models = [
  { value: 'opus', display_name: 'Opus 5.5', description: '', supports_effort: true },
] as never;

describe('mobile controls line', () => {
  test('names the model and the effort', () => {
    expect(controlsSummary({}, undefined)).toBe('Default · Auto');
    expect(controlsSummary({ model: 'opus', thinking_effort: 'high' }, models)).toBe(
      'Opus 5.5 · High',
    );
  });

  test('an id the list does not know stands as itself', () => {
    expect(controlsSummary({ model: 'claude-x' }, models)).toBe('claude-x · Auto');
  });

  test('flags anything beyond model and effort', () => {
    expect(hasExtraControls({ model: 'opus', thinking_effort: 'high' })).toBe(false);
    expect(hasExtraControls({ allowed_tools: ['Read'] })).toBe(true);
    expect(hasExtraControls({ system_prompt: { mode: 'append', text: 'x' } })).toBe(true);
  });
});
