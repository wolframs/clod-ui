import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { controlResponseFor, initializeRequestLine, parseModelList } from '../src/models.ts';

/**
 * PR #42: the CLI's model list. The fixture is the `models` array of a real
 * CLI 2.1.310 initialize reply (nothing else from the reply is kept).
 */
const CLI_MODELS = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/cli-models-2.1.310.json'), 'utf8'),
) as unknown[];

describe('parseModelList', () => {
  const models = parseModelList({ models: CLI_MODELS });

  test('keeps every entry, in the CLI order, default first', () => {
    expect(models).toHaveLength(13);
    expect(models.map((m) => m.value).slice(0, 5)).toEqual([
      'default',
      'opus',
      'fable',
      'sonnet',
      'haiku',
    ]);
    expect(models[0]).toEqual({
      value: 'default',
      display_name: 'Default (recommended)',
      resolved_model: 'claude-fable-5-1',
      description: 'Fable 5.1',
      effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supports_thinking_off: false,
    });
  });

  test('per-model effort levels survive: Opus 4.6 has no xhigh, Haiku 4.5 no effort', () => {
    expect(models.find((m) => m.value === 'claude-opus-4-6')?.effort_levels).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
    const haiku45 = models.find((m) => m.value === 'claude-haiku-4-5-20251001');
    expect(haiku45?.effort_levels).toBeUndefined();
    expect(haiku45?.supports_thinking_off).toBe(true);
  });

  test('drops malformed entries and unknown effort levels', () => {
    expect(
      parseModelList({
        models: [
          { value: 'x' },
          null,
          {
            value: 'y',
            displayName: 'Y',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'turbo'],
          },
        ],
      }),
    ).toEqual([{ value: 'y', display_name: 'Y', effort_levels: ['low'] }]);
    expect(parseModelList(undefined)).toEqual([]);
    expect(parseModelList({ models: 'nope' })).toEqual([]);
  });
});

describe('initialize control request', () => {
  test('request line shape', () => {
    expect(JSON.parse(initializeRequestLine('r1'))).toEqual({
      type: 'control_request',
      request_id: 'r1',
      request: { subtype: 'initialize' },
    });
  });

  test('controlResponseFor matches only its own request id', () => {
    const reply = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { models: [] } },
    });
    expect(controlResponseFor(reply, 'r1')).toEqual({ models: [] });
    expect(controlResponseFor(reply, 'r2')).toBeUndefined();
    expect(controlResponseFor('{"type":"system","subtype":"init"}', 'r1')).toBeUndefined();
    expect(controlResponseFor('not json', 'r1')).toBeUndefined();
  });

  test('an error reply throws', () => {
    const reply = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'r1', error: 'nope' },
    });
    expect(() => controlResponseFor(reply, 'r1')).toThrow('nope');
  });
});
