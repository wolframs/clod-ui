import type { EventEnvelope } from '@clod-ui/contracts';
import { describe, expect, test } from 'bun:test';

import {
  type ActiveTurn,
  INITIAL_TURN_STATE,
  type TurnState,
  turnReducer,
} from '../src/lib/turn-reducer';

/**
 * Unit tests for the pure `turnReducer`.
 *
 * Spec: plans/landed/2026-05-01-clod-ui-pr18b-use-turn-stream-v1.md §4 + §8.
 *
 * Hermetic. No I/O, no fakes. Each test constructs envelopes by hand and
 * asserts the (prev, env) → next transition.
 */

const CONV = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';

let nextId = 1;
function env(kind: string, payload: unknown, conv_id: string = CONV): EventEnvelope {
  const id = String(nextId++).padStart(36, '0');
  return {
    v: 1,
    id: `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`,
    ts: 1_700_000_000_000 + nextId,
    kind,
    conv_id,
    payload,
  };
}

function active(state: TurnState): ActiveTurn {
  if (state.status === 'idle') throw new Error('expected active turn, got idle');
  return state;
}

describe('turnReducer — initial state', () => {
  test('INITIAL_TURN_STATE is idle', () => {
    expect(INITIAL_TURN_STATE).toEqual({ status: 'idle' });
  });

  test('non-init events on idle state return idle', () => {
    expect(
      turnReducer(INITIAL_TURN_STATE, env('assistant.delta', { turn_id: TURN, text: 'hi' })),
    ).toEqual({ status: 'idle' });
    expect(turnReducer(INITIAL_TURN_STATE, env('turn.result', { turn_id: TURN }))).toEqual({
      status: 'idle',
    });
    expect(
      turnReducer(
        INITIAL_TURN_STATE,
        env('tool.use', { turn_id: TURN, tool_use_id: 'a', name: 'b', input: {} }),
      ),
    ).toEqual({ status: 'idle' });
  });
});

describe('turnReducer — system.init', () => {
  test('opens a fresh streaming turn with session_id', () => {
    const next = turnReducer(
      INITIAL_TURN_STATE,
      env('system.init', { turn_id: TURN, session_id: SESSION }),
    );
    expect(active(next)).toEqual({
      status: 'streaming',
      turn_id: TURN,
      session_id: SESSION,
      assistant_text: '',
      assistant_complete: false,
      thinking_text: '',
      thinking_complete: false,
      tools: [],
    });
  });

  test('opens a fresh streaming turn without session_id when omitted', () => {
    const next = turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
    const a = active(next);
    expect(a.session_id).toBeUndefined();
    expect(a.turn_id).toBe(TURN);
  });

  test('a second system.init with a new turn_id resets the accumulator', () => {
    let s: TurnState = turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
    s = turnReducer(s, env('assistant.delta', { turn_id: TURN, text: 'hello' }));
    s = turnReducer(
      s,
      env('tool.use', { turn_id: TURN, tool_use_id: 't1', name: 'Bash', input: { cmd: 'ls' } }),
    );
    expect(active(s).assistant_text).toBe('hello');
    expect(active(s).tools.length).toBe(1);

    const TURN2 = '44444444-4444-4444-8444-444444444444';
    s = turnReducer(s, env('system.init', { turn_id: TURN2 }));
    expect(active(s)).toEqual({
      status: 'streaming',
      turn_id: TURN2,
      assistant_text: '',
      assistant_complete: false,
      thinking_text: '',
      thinking_complete: false,
      tools: [],
    });
  });

  test('drops malformed system.init (no turn_id)', () => {
    const next = turnReducer(INITIAL_TURN_STATE, env('system.init', { session_id: SESSION }));
    expect(next).toEqual({ status: 'idle' });
  });
});

describe('turnReducer — assistant streaming', () => {
  function start(): TurnState {
    return turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
  }

  test('appends assistant.delta text in arrival order', () => {
    let s = start();
    s = turnReducer(s, env('assistant.delta', { turn_id: TURN, text: 'Hello, ' }));
    s = turnReducer(s, env('assistant.delta', { turn_id: TURN, text: 'world' }));
    s = turnReducer(s, env('assistant.delta', { turn_id: TURN, text: '!' }));
    expect(active(s).assistant_text).toBe('Hello, world!');
  });

  test('assistant.complete sets the flag without modifying text', () => {
    let s = start();
    s = turnReducer(s, env('assistant.delta', { turn_id: TURN, text: 'x' }));
    s = turnReducer(s, env('assistant.complete', { turn_id: TURN }));
    expect(active(s).assistant_text).toBe('x');
    expect(active(s).assistant_complete).toBe(true);
  });

  test('drops assistant.delta with a non-string text', () => {
    let s = start();
    s = turnReducer(s, env('assistant.delta', { turn_id: TURN, text: 42 }));
    expect(active(s).assistant_text).toBe('');
  });

  test('drops assistant.delta for a different turn_id', () => {
    let s = start();
    const OTHER = '99999999-9999-4999-8999-999999999999';
    s = turnReducer(s, env('assistant.delta', { turn_id: OTHER, text: 'wrong' }));
    expect(active(s).assistant_text).toBe('');
  });
});

describe('turnReducer — thinking streaming', () => {
  function start(): TurnState {
    return turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
  }

  test('appends thinking.delta and tracks thinking.complete independently of assistant', () => {
    let s = start();
    s = turnReducer(s, env('thinking.delta', { turn_id: TURN, text: 'reasoning... ' }));
    s = turnReducer(s, env('thinking.delta', { turn_id: TURN, text: 'and more' }));
    s = turnReducer(s, env('thinking.complete', { turn_id: TURN }));
    expect(active(s).thinking_text).toBe('reasoning... and more');
    expect(active(s).thinking_complete).toBe(true);
    expect(active(s).assistant_complete).toBe(false);
  });
});

describe('turnReducer — tool lifecycle', () => {
  function start(): TurnState {
    return turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
  }

  test('tool.use appends a pending tool', () => {
    let s = start();
    s = turnReducer(
      s,
      env('tool.use', { turn_id: TURN, tool_use_id: 't1', name: 'Bash', input: { cmd: 'ls' } }),
    );
    expect(active(s).tools).toEqual([
      { tool_use_id: 't1', name: 'Bash', input: { cmd: 'ls' }, status: 'pending' },
    ]);
  });

  test('tool.use de-duplicates by tool_use_id', () => {
    let s = start();
    s = turnReducer(
      s,
      env('tool.use', { turn_id: TURN, tool_use_id: 't1', name: 'Bash', input: { cmd: 'ls' } }),
    );
    s = turnReducer(
      s,
      env('tool.use', {
        turn_id: TURN,
        tool_use_id: 't1',
        name: 'Bash-DUPE',
        input: { cmd: 'whoami' },
      }),
    );
    expect(active(s).tools.length).toBe(1);
    expect(active(s).tools[0]?.name).toBe('Bash');
  });

  test('tool.result transitions matching tool to success with content', () => {
    let s = start();
    s = turnReducer(
      s,
      env('tool.use', { turn_id: TURN, tool_use_id: 't1', name: 'Bash', input: {} }),
    );
    s = turnReducer(s, env('tool.result', { turn_id: TURN, tool_use_id: 't1', content: 'output' }));
    expect(active(s).tools[0]).toEqual({
      tool_use_id: 't1',
      name: 'Bash',
      input: {},
      status: 'success',
      result: 'output',
    });
  });

  test('tool.error transitions matching tool to error with message', () => {
    let s = start();
    s = turnReducer(
      s,
      env('tool.use', { turn_id: TURN, tool_use_id: 't1', name: 'Bash', input: {} }),
    );
    s = turnReducer(
      s,
      env('tool.error', { turn_id: TURN, tool_use_id: 't1', message: 'permission denied' }),
    );
    expect(active(s).tools[0]).toEqual({
      tool_use_id: 't1',
      name: 'Bash',
      input: {},
      status: 'error',
      error_message: 'permission denied',
    });
  });

  test('tool.result for unknown tool_use_id is a no-op (does not fabricate)', () => {
    let s = start();
    s = turnReducer(
      s,
      env('tool.use', { turn_id: TURN, tool_use_id: 't1', name: 'Bash', input: {} }),
    );
    s = turnReducer(s, env('tool.result', { turn_id: TURN, tool_use_id: 'phantom', content: 'x' }));
    expect(active(s).tools.length).toBe(1);
    expect(active(s).tools[0]?.status).toBe('pending');
  });

  test('multiple tools preserve insertion order', () => {
    let s = start();
    s = turnReducer(s, env('tool.use', { turn_id: TURN, tool_use_id: 't1', name: 'A', input: {} }));
    s = turnReducer(s, env('tool.use', { turn_id: TURN, tool_use_id: 't2', name: 'B', input: {} }));
    s = turnReducer(s, env('tool.use', { turn_id: TURN, tool_use_id: 't3', name: 'C', input: {} }));
    expect(active(s).tools.map((t) => t.tool_use_id)).toEqual(['t1', 't2', 't3']);
  });
});

describe('turnReducer — terminators', () => {
  function start(): TurnState {
    return turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
  }

  test('turn.result transitions to completed with usage', () => {
    let s = start();
    s = turnReducer(s, env('assistant.delta', { turn_id: TURN, text: 'done' }));
    s = turnReducer(
      s,
      env('turn.result', { turn_id: TURN, usage: { input_tokens: 10, output_tokens: 20 } }),
    );
    const a = active(s);
    expect(a.status).toBe('completed');
    expect(a.assistant_text).toBe('done');
    expect(a.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  test('turn.cancelled records escalation', () => {
    let s = start();
    s = turnReducer(s, env('turn.cancelled', { turn_id: TURN, escalation: 'sigterm' }));
    const a = active(s);
    expect(a.status).toBe('cancelled');
    expect(a.escalation).toBe('sigterm');
  });

  test('turn.cancelled with unknown escalation drops the field', () => {
    let s = start();
    s = turnReducer(s, env('turn.cancelled', { turn_id: TURN, escalation: 'made-up' }));
    const a = active(s);
    expect(a.status).toBe('cancelled');
    expect(a.escalation).toBeUndefined();
  });

  test('turn.error records ClodError', () => {
    let s = start();
    const error = { kind: 'rate_limited' as const, retryable: true, retry_after_ms: 5000 };
    s = turnReducer(s, env('turn.error', { turn_id: TURN, error }));
    const a = active(s);
    expect(a.status).toBe('errored');
    expect(a.error).toEqual(error);
  });
});

describe('turnReducer — control envelopes & unknown kinds', () => {
  test('replay.start is ignored (returns prev unchanged)', () => {
    const s = turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
    const after = turnReducer(
      s,
      env('replay.start', { kind: 'replay.start', since: null, replayed_count: 0, gap: false }),
    );
    expect(after).toBe(s); // identity, not just deep equality
  });

  test('unknown kind returns prev unchanged', () => {
    const s = turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
    const after = turnReducer(s, env('some.future.kind', { foo: 'bar' }));
    expect(after).toBe(s);
  });
});

describe('turnReducer — model, terminal completion, pre-init failures', () => {
  test('system.init carries the resolved model id', () => {
    const s = active(
      turnReducer(
        INITIAL_TURN_STATE,
        env('system.init', { turn_id: TURN, session_id: SESSION, model: 'claude-x-1' }),
      ),
    );
    expect(s.model).toBe('claude-x-1');
  });

  test('a terminator closes the text and thinking streams (no stuck cursor)', () => {
    let s: TurnState = turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
    s = turnReducer(s, env('assistant.delta', { turn_id: TURN, text: 'hi' }));
    for (const kind of ['turn.result', 'turn.cancelled', 'turn.error']) {
      const done = active(turnReducer(s, env(kind, { turn_id: TURN })));
      expect(done.assistant_complete).toBe(true);
      expect(done.thinking_complete).toBe(true);
    }
  });

  test('turn.error before any system.init is projected, not dropped', () => {
    const s = active(
      turnReducer(
        INITIAL_TURN_STATE,
        env('turn.error', { turn_id: TURN, error: { kind: 'cli_missing', retryable: false } }),
      ),
    );
    expect(s.status).toBe('errored');
    expect(s.turn_id).toBe(TURN);
  });

  test('turn.error for a new turn replaces the previous finished turn', () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    let s: TurnState = turnReducer(INITIAL_TURN_STATE, env('system.init', { turn_id: TURN }));
    s = turnReducer(s, env('turn.result', { turn_id: TURN }));
    const next = active(
      turnReducer(
        s,
        env('turn.error', { turn_id: OTHER, error: { kind: 'cli_crashed', retryable: true } }),
      ),
    );
    expect(next.turn_id).toBe(OTHER);
    expect(next.status).toBe('errored');
    expect(next.assistant_text).toBe('');
  });
});
