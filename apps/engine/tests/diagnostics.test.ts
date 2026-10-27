import type { BackendEvent, TurnRequest } from '@clod-ui/backend';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { describe, expect, test } from 'bun:test';

import { DiagnosticsRing, redactArgv } from '../src/diagnostics.ts';
import { createApp } from '../src/index.ts';

describe('redactArgv', () => {
  test('redacts the value after both system-prompt flags, keeps everything else', () => {
    const argv = [
      'claude',
      '--append-system-prompt',
      'secret instructions',
      '--model',
      'opus',
      '--system-prompt',
      'xx',
    ];
    expect(redactArgv(argv)).toEqual([
      'claude',
      '--append-system-prompt',
      '[redacted 19 chars]',
      '--model',
      'opus',
      '--system-prompt',
      '[redacted 2 chars]',
    ]);
    // input untouched
    expect(argv[2]).toBe('secret instructions');
  });

  test('flag in last position (no value) is left alone', () => {
    expect(redactArgv(['claude', '--system-prompt'])).toEqual(['claude', '--system-prompt']);
  });
});

function startEntry(ring: DiagnosticsRing, turnId: string, argv: string[] = ['claude']): void {
  ring.start({
    turn_id: turnId,
    conv_id: 'conv-1',
    argv,
    env: { PATH: '/usr/bin', API_KEY: 'hunter2' },
    stdin_bytes: 42,
    cwd: '/tmp/c',
  });
}

describe('DiagnosticsRing', () => {
  test('records env key names only, never values', () => {
    const ring = new DiagnosticsRing();
    startEntry(ring, 't-1');
    const [entry] = ring.list();
    expect(entry?.env_keys.sort()).toEqual(['API_KEY', 'PATH']);
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });

  test('events accumulate with turn_id stripped; first terminator wins', () => {
    const ring = new DiagnosticsRing({ now: () => 7 });
    startEntry(ring, 't-1');
    ring.addEvent('t-1', { kind: 'system.init', turn_id: 't-1', session_id: 's' });
    ring.addEvent('t-1', { kind: 'assistant.delta', turn_id: 't-1', text: 'hi' });
    ring.finish('t-1', { kind: 'result' });
    ring.finish('t-1', { kind: 'error', detail: 'late' });
    const [entry] = ring.list();
    expect(entry?.events.map((e) => e.kind)).toEqual(['system.init', 'assistant.delta']);
    expect(entry?.events[0]?.event).toEqual({ kind: 'system.init', session_id: 's' });
    expect(entry?.outcome).toEqual({ kind: 'result' });
  });

  test('bounded: oldest evicted, list() is most recent first', () => {
    const ring = new DiagnosticsRing({ capacity: 2 });
    startEntry(ring, 't-1');
    startEntry(ring, 't-2');
    startEntry(ring, 't-3');
    expect(ring.list().map((e) => e.turn_id)).toEqual(['t-3', 't-2']);
  });

  test('repro round-trip: recorded events replay through ScriptedBackend', async () => {
    const ring = new DiagnosticsRing();
    startEntry(ring, 't-1');
    ring.addEvent('t-1', { kind: 'system.init', turn_id: 't-1', session_id: 's-x' });
    ring.addEvent('t-1', { kind: 'assistant.delta', turn_id: 't-1', text: 'hello' });
    ring.addEvent('t-1', { kind: 'turn.result', turn_id: 't-1' });

    // The panel's "Copy repro" JSON shape (PR #32 D5).
    const [entry] = ring.list();
    const reproJson = JSON.stringify({
      request: { turn_id: entry?.turn_id, conv_id: entry?.conv_id },
      events: entry?.events.map((e) => e.event),
    });

    const repro = JSON.parse(reproJson) as { events: Array<Omit<BackendEvent, 'turn_id'>> };
    const backend = new ScriptedBackend({ events: repro.events });
    const replayed: BackendEvent[] = [];
    const req: TurnRequest = {
      turn_id: 't-replay',
      conv_id: 'conv-replay',
      user_message: 'x',
      cwd: '/tmp',
    };
    for await (const ev of backend.startTurn(req)) replayed.push(ev);
    expect(replayed).toEqual([
      { kind: 'system.init', turn_id: 't-replay', session_id: 's-x' },
      { kind: 'assistant.delta', turn_id: 't-replay', text: 'hello' },
      { kind: 'turn.result', turn_id: 't-replay' },
    ] as BackendEvent[]);
  });
});

describe('diagnostics records the backend binary (PR #38)', () => {
  test('argv[0] is the wrapper the backend really spawns', async () => {
    const backend = Object.assign(
      new ScriptedBackend(script().init('s-bin').assistantText('x').result().end()),
      { claudeBinary: '/opt/seat/clod_seat.sh' },
    );
    const ctx = createApp({ backend, diagnostics: {} });
    const conv = '66666666-6666-4666-8666-666666666666';
    const res = await ctx.app.request(`/conversations/${conv}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn_id: 't-bin', user_message: 'hi' }),
    });
    expect(res.status).toBe(202);
    const diag = (await (await ctx.app.request('/diagnostics')).json()) as {
      turns: Array<{ argv: string[] }>;
    };
    expect(diag.turns[0]?.argv[0]).toBe('/opt/seat/clod_seat.sh');
  });
});
