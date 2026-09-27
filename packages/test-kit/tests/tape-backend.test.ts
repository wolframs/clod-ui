import { resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { FakeClock, TapeArgvMismatchError, TapeBackend } from '../src/index.ts';

const FIXTURE = resolve(import.meta.dir, 'fixtures/hello.tape.json');

describe('TapeBackend', () => {
  test('loads and replays events with expected mapping', async () => {
    const clock = new FakeClock();
    const be = await TapeBackend.load(FIXTURE, { clock });
    const kinds: string[] = [];
    for await (const ev of be.startTurn({
      turn_id: 't1',
      conv_id: 'c1',
      user_message: 'hi',
      cwd: '/tmp',
    })) {
      kinds.push(ev.kind);
    }
    expect(kinds).toEqual(['system.init', 'assistant.delta', 'assistant.delta', 'turn.result']);
    // Clock should have advanced at least to the last ts_ms.
    expect(clock.now()).toBeGreaterThanOrEqual(20);
  });

  test('validateArgv accepts identical argv', async () => {
    const be = await TapeBackend.load(FIXTURE);
    expect(
      be.validateArgv(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json']),
    ).toBe(true);
  });

  test('validateArgv rejects diverging argv without allowance', async () => {
    const be = await TapeBackend.load(FIXTURE);
    expect(() =>
      be.validateArgv([
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--model',
        'haiku',
      ]),
    ).toThrow(TapeArgvMismatchError);
  });

  test('validateArgv accepts diverging argv with allowance', async () => {
    const be = await TapeBackend.load(FIXTURE, { allowArgvDeltas: ['--model'] });
    expect(
      be.validateArgv([
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--model',
        'haiku',
      ]),
    ).toBe(true);
  });
});
