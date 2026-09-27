/**
 * `useTurnStream` — hook integration tests.
 *
 * Vitest+RTL+happy-dom tier (DOM lifecycle required: useEffect setup, prop-
 * change reset, ref-stable handler dispatch).
 *
 * Each test injects a FakeClient whose `subscribe()` records the handlers
 * passed by the underlying `useSubscribe` and exposes synchronous
 * `fireEnvelope()` so tests can drive the wire stream deterministically.
 *
 * Spec: plans/landed/2026-05-01-clod-ui-pr18b-use-turn-stream-v1.md §8.
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import type { Client, SubscribeHandlers, Subscription } from '@clod-ui/contracts/client';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useTurnStream } from '../../src/lib/use-turn-stream.ts';

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';

interface FakeController {
  subscribeCalls: number;
  closeCalls: number;
  handlers: SubscribeHandlers | null;
  fireOpen: () => void;
  fireEnvelope: (env: EventEnvelope) => void;
}

function makeFakeClient(): { client: Client; ctrl: FakeController } {
  const ctrl: FakeController = {
    subscribeCalls: 0,
    closeCalls: 0,
    handlers: null,
    fireOpen: () => undefined,
    fireEnvelope: () => undefined,
  };
  const subscribe = (handlers: SubscribeHandlers): Subscription => {
    ctrl.subscribeCalls += 1;
    ctrl.handlers = handlers;
    ctrl.fireOpen = () => handlers.onOpen?.();
    ctrl.fireEnvelope = (env) => {
      handlers.on?.[env.kind]?.(env);
      handlers.onEnvelope?.(env);
    };
    return {
      close: () => {
        ctrl.closeCalls += 1;
      },
    };
  };
  return { client: { subscribe } as unknown as Client, ctrl };
}

function makeWrapper(client: Client) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client}>{children}</EngineProvider>;
  };
}

let nextId = 1;
function env(kind: string, payload: unknown, conv_id: string = CONV_A): EventEnvelope {
  const counter = String(nextId++).padStart(12, '0');
  return {
    v: 1,
    id: `00000000-0000-4000-8000-${counter}`,
    ts: 1_700_000_000_000 + nextId,
    kind,
    conv_id,
    payload,
  };
}

describe('useTurnStream — initial state', () => {
  test('returns idle before any envelope arrives', () => {
    const { client } = makeFakeClient();
    const { result } = renderHook(() => useTurnStream({ conv_id: CONV_A }), {
      wrapper: makeWrapper(client),
    });
    expect(result.current).toEqual({ status: 'idle' });
  });

  test('enabled: false suppresses subscription and stays idle even when envelopes would match', () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useTurnStream({ conv_id: CONV_A, enabled: false }), {
      wrapper: makeWrapper(client),
    });
    expect(ctrl.subscribeCalls).toBe(0);
    expect(result.current).toEqual({ status: 'idle' });
  });
});

describe('useTurnStream — conv_id filter', () => {
  test('envelopes for other conv_ids are ignored', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useTurnStream({ conv_id: CONV_A }), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(ctrl.handlers).not.toBeNull());

    // Wrong conv_id — must NOT establish a turn.
    ctrl.fireEnvelope(env('system.init', { turn_id: TURN }, CONV_B));
    expect(result.current).toEqual({ status: 'idle' });

    // Right conv_id — DOES establish a turn.
    ctrl.fireEnvelope(env('system.init', { turn_id: TURN }, CONV_A));
    await waitFor(() => expect(result.current.status).toBe('streaming'));
  });
});

describe('useTurnStream — lifecycle integration', () => {
  test('streams assistant text deltas end-to-end', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useTurnStream({ conv_id: CONV_A }), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(ctrl.handlers).not.toBeNull());

    ctrl.fireEnvelope(env('system.init', { turn_id: TURN }));
    ctrl.fireEnvelope(env('assistant.delta', { turn_id: TURN, text: 'Hello, ' }));
    ctrl.fireEnvelope(env('assistant.delta', { turn_id: TURN, text: 'world!' }));

    await waitFor(() => {
      const s = result.current;
      if (s.status !== 'streaming') throw new Error('not streaming yet');
      expect(s.assistant_text).toBe('Hello, world!');
    });
  });

  test('terminator transitions status to completed with usage', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useTurnStream({ conv_id: CONV_A }), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(ctrl.handlers).not.toBeNull());

    ctrl.fireEnvelope(env('system.init', { turn_id: TURN }));
    ctrl.fireEnvelope(env('assistant.delta', { turn_id: TURN, text: 'done' }));
    ctrl.fireEnvelope(
      env('turn.result', { turn_id: TURN, usage: { input_tokens: 5, output_tokens: 8 } }),
    );

    await waitFor(() => {
      const s = result.current;
      if (s.status !== 'completed') throw new Error(`expected completed, got ${s.status}`);
      expect(s.assistant_text).toBe('done');
      expect(s.usage).toEqual({ input_tokens: 5, output_tokens: 8 });
    });
  });

  test('mid-stream cancel surfaces escalation', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useTurnStream({ conv_id: CONV_A }), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(ctrl.handlers).not.toBeNull());

    ctrl.fireEnvelope(env('system.init', { turn_id: TURN }));
    ctrl.fireEnvelope(env('assistant.delta', { turn_id: TURN, text: 'partial' }));
    ctrl.fireEnvelope(env('turn.cancelled', { turn_id: TURN, escalation: 'sigterm' }));

    await waitFor(() => {
      const s = result.current;
      if (s.status !== 'cancelled') throw new Error(`expected cancelled, got ${s.status}`);
      expect(s.assistant_text).toBe('partial');
      expect(s.escalation).toBe('sigterm');
    });
  });

  test('mid-stream error surfaces ClodError', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useTurnStream({ conv_id: CONV_A }), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(ctrl.handlers).not.toBeNull());

    ctrl.fireEnvelope(env('system.init', { turn_id: TURN }));
    const error = { kind: 'rate_limited' as const, retryable: true, retry_after_ms: 5000 };
    ctrl.fireEnvelope(env('turn.error', { turn_id: TURN, error }));

    await waitFor(() => {
      const s = result.current;
      if (s.status !== 'errored') throw new Error(`expected errored, got ${s.status}`);
      expect(s.error).toEqual(error);
    });
  });
});

describe('useTurnStream — conv_id change reset', () => {
  test('switching conv_id resets state to idle synchronously (no flash of stale data)', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result, rerender } = renderHook(({ conv_id }) => useTurnStream({ conv_id }), {
      initialProps: { conv_id: CONV_A },
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(ctrl.handlers).not.toBeNull());

    // Establish turn on CONV_A.
    ctrl.fireEnvelope(env('system.init', { turn_id: TURN }, CONV_A));
    ctrl.fireEnvelope(env('assistant.delta', { turn_id: TURN, text: 'A-text' }, CONV_A));
    await waitFor(() => {
      const s = result.current;
      if (s.status !== 'streaming') throw new Error('not streaming');
      expect(s.assistant_text).toBe('A-text');
    });

    // Switch to CONV_B — state must reset without observing CONV_A's text.
    rerender({ conv_id: CONV_B });
    expect(result.current).toEqual({ status: 'idle' });
  });
});
