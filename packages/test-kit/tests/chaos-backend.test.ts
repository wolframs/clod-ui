import { describe, expect, test } from 'bun:test';

import { ChaosBackend, ScriptedBackend, script } from '../src/index.ts';

const immediateSleep = (_ms: number) => Promise.resolve();

describe('ChaosBackend', () => {
  test('passes through events when no faults configured', async () => {
    const built = script().init('s').assistantText('hi').result().end();
    const be = new ChaosBackend(new ScriptedBackend(built), { sleep: immediateSleep });
    const kinds: string[] = [];
    for await (const ev of be.startTurn({
      turn_id: 't1',
      conv_id: 'c1',
      user_message: 'x',
      cwd: '/tmp',
    })) {
      kinds.push(ev.kind);
    }
    expect(kinds).toEqual(['system.init', 'assistant.delta', 'turn.result']);
  });

  test('crashAfterEvents throws mid-stream', async () => {
    const built = script()
      .init('s')
      .assistantText('a')
      .assistantText('b')
      .assistantText('c')
      .result()
      .end();
    const be = new ChaosBackend(new ScriptedBackend(built), {
      crashAfterEvents: 2,
      sleep: immediateSleep,
    });
    const kinds: string[] = [];
    let threw = false;
    try {
      for await (const ev of be.startTurn({
        turn_id: 't1',
        conv_id: 'c1',
        user_message: 'x',
        cwd: '/tmp',
      })) {
        kinds.push(ev.kind);
      }
    } catch (e) {
      threw = true;
      expect((e as Error).message).toMatch(/simulated crash/);
    }
    expect(threw).toBe(true);
    expect(kinds.length).toBe(2);
  });
});
