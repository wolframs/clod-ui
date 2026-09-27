import type { BackendEvent } from '@clod-ui/backend';
import { describe, expect, test } from 'bun:test';

import { ScriptedBackend, script } from '../src/index.ts';

describe('ScriptedBackend', () => {
  test('emits built events in order with turn_id stamped', async () => {
    const built = script().init('sess-1').assistantText('Hello').result({}).end();
    const be = new ScriptedBackend(built);
    const out: BackendEvent[] = [];
    for await (const ev of be.startTurn({
      turn_id: 't1',
      conv_id: 'c1',
      user_message: 'hi',
      cwd: '/tmp',
    })) {
      out.push(ev);
    }
    expect(out.map((e) => e.kind)).toEqual(['system.init', 'assistant.delta', 'turn.result']);
    expect(out.every((e) => e.turn_id === 't1')).toBe(true);
  });

  test('cancel short-circuits subsequent events', async () => {
    const built = script().init('s').assistantText('a').assistantText('b').assistantText('c').end();
    const be = new ScriptedBackend(built);
    const iter = be
      .startTurn({
        turn_id: 't1',
        conv_id: 'c1',
        user_message: 'hi',
        cwd: '/tmp',
      })
      [Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value?.kind).toBe('system.init');
    await be.cancel('t1');
    // Drain; should end quickly.
    const collected: unknown[] = [];
    for (;;) {
      const { value, done } = await iter.next();
      if (done) break;
      collected.push(value);
    }
    // Up to one more event may have been in-flight; definitely fewer than all.
    expect(collected.length).toBeLessThan(3);
  });

  test('toolResult finds the last toolUse id', async () => {
    const built = script()
      .init('s')
      .toolUse('Read', { path: '/x' })
      .toolResult('ok')
      .result()
      .end();
    const be = new ScriptedBackend(built);
    const out: BackendEvent[] = [];
    for await (const ev of be.startTurn({
      turn_id: 't1',
      conv_id: 'c1',
      user_message: 'hi',
      cwd: '/tmp',
    })) {
      out.push(ev);
    }
    const toolUse = out.find((e) => e.kind === 'tool.use');
    const toolResult = out.find((e) => e.kind === 'tool.result');
    expect(toolUse && 'tool_use_id' in toolUse ? toolUse.tool_use_id : undefined).toBe(
      toolResult && 'tool_use_id' in toolResult ? toolResult.tool_use_id : undefined,
    );
    expect(toolUse).toBeDefined();
    expect(toolResult).toBeDefined();
  });

  test('health + version reflect configured overrides', async () => {
    const built = script().end();
    const be = new ScriptedBackend(built, {
      version: 'custom-1',
      health: { cli: 'missing' },
    });
    expect(await be.version()).toBe('custom-1');
    expect((await be.health()).cli).toBe('missing');
  });
});
