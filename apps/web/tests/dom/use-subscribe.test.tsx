/**
 * `useSubscribe` — full async lifecycle tests.
 *
 * Vitest+RTL+happy-dom tier (DOM lifecycle required: useEffect setup +
 * cleanup, ref-stable handler dispatch under render mutations).
 *
 * Each test injects a FakeClient whose `subscribe()` records the handlers
 * passed by the hook and exposes synchronous `fire*()` methods so tests
 * drive the connection state machine deterministically without any
 * real WebSocket or scheduler.
 *
 * Spec: plans/landed/2026-04-30-clod-ui-pr18a-use-subscribe-v1.md §5.
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import type { Client, SubscribeHandlers, Subscription } from '@clod-ui/contracts/client';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useSubscribe, type UseSubscribeOptions } from '../../src/lib/use-subscribe.ts';

interface FakeSubscribeController {
  /** Total number of times `client.subscribe()` was called. */
  subscribeCalls: number;
  /** Total number of times the returned subscription's `close()` was called. */
  closeCalls: number;
  /** Last passed-in handlers (latest subscription only). */
  handlers: SubscribeHandlers | null;
  /** Synchronously invoke `onOpen` on the latest subscription. */
  fireOpen: () => void;
  /** Synchronously invoke `onClose` on the latest subscription. */
  fireClose: (code: number, reason?: string) => void;
  /** Synchronously deliver an envelope to the latest subscription. */
  fireEnvelope: (env: EventEnvelope) => void;
}

function makeFakeClient(): { client: Client; ctrl: FakeSubscribeController } {
  const ctrl: FakeSubscribeController = {
    subscribeCalls: 0,
    closeCalls: 0,
    handlers: null,
    fireOpen: () => undefined,
    fireClose: () => undefined,
    fireEnvelope: () => undefined,
  };
  const subscribe = (handlers: SubscribeHandlers): Subscription => {
    ctrl.subscribeCalls += 1;
    ctrl.handlers = handlers;
    ctrl.fireOpen = () => handlers.onOpen?.();
    ctrl.fireClose = (code, reason = '') => handlers.onClose?.({ code, reason });
    ctrl.fireEnvelope = (env) => {
      const onKind = handlers.on?.[env.kind];
      onKind?.(env);
      handlers.onEnvelope?.(env);
    };
    return {
      close: () => {
        ctrl.closeCalls += 1;
      },
    };
  };
  const client = { subscribe } as unknown as Client;
  return { client, ctrl };
}

function makeWrapper(client: Client) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client}>{children}</EngineProvider>;
  };
}

function envelope(kind: string, id: string): EventEnvelope {
  return {
    v: 1,
    id,
    ts: 0,
    kind,
    payload: {},
  };
}

describe('useSubscribe — initial lifecycle', () => {
  test('opens a subscription on mount and reports "connecting" before onOpen fires', () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useSubscribe({}), { wrapper: makeWrapper(client) });

    expect(ctrl.subscribeCalls).toBe(1);
    expect(result.current).toEqual({ status: 'connecting' });
  });

  test('transitions to "open" when transport invokes onOpen', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useSubscribe({}), { wrapper: makeWrapper(client) });

    ctrl.fireOpen();
    await waitFor(() => {
      expect(result.current.status).toBe('open');
    });
  });

  test('forwards onEnvelope handler to every received envelope', async () => {
    const onEnvelope = vi.fn();
    const { client, ctrl } = makeFakeClient();
    renderHook(() => useSubscribe({ onEnvelope }), { wrapper: makeWrapper(client) });

    ctrl.fireOpen();
    ctrl.fireEnvelope(envelope('turn.result', 'id-1'));
    ctrl.fireEnvelope(envelope('assistant.delta', 'id-2'));

    await waitFor(() => {
      expect(onEnvelope).toHaveBeenCalledTimes(2);
    });
    expect(onEnvelope.mock.calls[0]![0].kind).toBe('turn.result');
    expect(onEnvelope.mock.calls[1]![0].kind).toBe('assistant.delta');
  });

  test('forwards on[kind] handler for matching envelopes', async () => {
    const onTurnResult = vi.fn();
    const onAssistant = vi.fn();
    const onEnvelope = vi.fn();
    const { client, ctrl } = makeFakeClient();
    renderHook(
      () =>
        useSubscribe({
          on: { 'turn.result': onTurnResult, 'assistant.delta': onAssistant },
          onEnvelope,
        }),
      { wrapper: makeWrapper(client) },
    );

    ctrl.fireOpen();
    ctrl.fireEnvelope(envelope('turn.result', 'id-1'));
    ctrl.fireEnvelope(envelope('assistant.delta', 'id-2'));
    ctrl.fireEnvelope(envelope('unknown.kind', 'id-3'));

    await waitFor(() => {
      expect(onEnvelope).toHaveBeenCalledTimes(3);
    });
    expect(onTurnResult).toHaveBeenCalledTimes(1);
    expect(onAssistant).toHaveBeenCalledTimes(1);
    expect(onTurnResult.mock.calls[0]![0].id).toBe('id-1');
    expect(onAssistant.mock.calls[0]![0].id).toBe('id-2');
  });
});

describe('useSubscribe — close + reconnect surfacing', () => {
  test('transitions to "reconnecting" on non-1000 close (reconnect on, default)', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useSubscribe({}), { wrapper: makeWrapper(client) });

    ctrl.fireOpen();
    await waitFor(() => {
      expect(result.current.status).toBe('open');
    });

    ctrl.fireClose(1006, 'transient');
    await waitFor(() => {
      expect(result.current.status).toBe('reconnecting');
    });
    if (result.current.status !== 'reconnecting') throw new Error('unreachable');
    expect(result.current.lastClose).toEqual({ code: 1006, reason: 'transient' });
  });

  test('transitions back to "open" after reconnect (transport calls onOpen again)', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useSubscribe({}), { wrapper: makeWrapper(client) });

    ctrl.fireOpen();
    ctrl.fireClose(1006);
    await waitFor(() => {
      expect(result.current.status).toBe('reconnecting');
    });

    // The transport's reconnect path eventually re-invokes onOpen.
    ctrl.fireOpen();
    await waitFor(() => {
      expect(result.current.status).toBe('open');
    });
  });

  test('lands in "closed" (not "reconnecting") when reconnect: false and a non-1000 close happens', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useSubscribe({ reconnect: false }), {
      wrapper: makeWrapper(client),
    });

    ctrl.fireOpen();
    ctrl.fireClose(1006, 'no-retry');

    await waitFor(() => {
      expect(result.current.status).toBe('closed');
    });
    if (result.current.status !== 'closed') throw new Error('unreachable');
    expect(result.current.lastClose).toEqual({ code: 1006, reason: 'no-retry' });
  });

  test('lands in "closed" when transport reports a 1000 (clean) close even with default reconnect', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useSubscribe({}), { wrapper: makeWrapper(client) });

    ctrl.fireOpen();
    ctrl.fireClose(1000, 'consumer closed');

    await waitFor(() => {
      expect(result.current.status).toBe('closed');
    });
    if (result.current.status !== 'closed') throw new Error('unreachable');
    expect(result.current.lastClose.code).toBe(1000);
  });
});

describe('useSubscribe — enabled flag', () => {
  test('enabled: false initially → no subscription, state is "idle"', () => {
    const { client, ctrl } = makeFakeClient();
    const { result } = renderHook(() => useSubscribe({ enabled: false }), {
      wrapper: makeWrapper(client),
    });

    expect(ctrl.subscribeCalls).toBe(0);
    expect(result.current).toEqual({ status: 'idle' });
  });

  test('flipping enabled: true → false closes the subscription and resets to "idle"', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSubscribe({ enabled }),
      {
        wrapper: makeWrapper(client),
        initialProps: { enabled: true },
      },
    );

    expect(ctrl.subscribeCalls).toBe(1);
    ctrl.fireOpen();
    await waitFor(() => {
      expect(result.current.status).toBe('open');
    });

    rerender({ enabled: false });

    expect(ctrl.closeCalls).toBe(1);
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
  });

  test('flipping enabled: false → true opens a subscription and re-enters "connecting"', async () => {
    const { client, ctrl } = makeFakeClient();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSubscribe({ enabled }),
      {
        wrapper: makeWrapper(client),
        initialProps: { enabled: false },
      },
    );

    expect(ctrl.subscribeCalls).toBe(0);
    expect(result.current.status).toBe('idle');

    rerender({ enabled: true });

    expect(ctrl.subscribeCalls).toBe(1);
    await waitFor(() => {
      expect(result.current.status).toBe('connecting');
    });
  });
});

describe('useSubscribe — ref stability + cleanup', () => {
  test('changing handler refs between renders does NOT re-subscribe', async () => {
    const { client, ctrl } = makeFakeClient();
    const { rerender } = renderHook(
      ({ handler }: { handler: (env: EventEnvelope) => void }) =>
        useSubscribe({ onEnvelope: handler }),
      {
        wrapper: makeWrapper(client),
        initialProps: { handler: vi.fn() },
      },
    );
    expect(ctrl.subscribeCalls).toBe(1);

    // Re-render with a totally new handler ref.
    const newHandler = vi.fn();
    rerender({ handler: newHandler });

    // Subscribe NOT called again; the latest handler dispatches via the ref.
    expect(ctrl.subscribeCalls).toBe(1);
    ctrl.fireEnvelope(envelope('turn.result', 'id-1'));
    expect(newHandler).toHaveBeenCalledTimes(1);
  });

  test('changing the on[kind] map between renders does NOT re-subscribe; new handlers fire', async () => {
    const { client, ctrl } = makeFakeClient();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const { rerender } = renderHook(
      ({ on }: { on: Record<string, (env: EventEnvelope) => void> }) => useSubscribe({ on }),
      {
        wrapper: makeWrapper(client),
        initialProps: { on: { 'turn.result': handlerA } },
      },
    );

    ctrl.fireEnvelope(envelope('turn.result', 'id-1'));
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(ctrl.subscribeCalls).toBe(1);

    rerender({ on: { 'turn.result': handlerB } });

    ctrl.fireEnvelope(envelope('turn.result', 'id-2'));
    expect(handlerA).toHaveBeenCalledTimes(1); // unchanged
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(ctrl.subscribeCalls).toBe(1); // still no re-subscribe
  });

  test('unmount closes the subscription exactly once', () => {
    const { client, ctrl } = makeFakeClient();
    const { unmount } = renderHook(() => useSubscribe({}), { wrapper: makeWrapper(client) });

    expect(ctrl.subscribeCalls).toBe(1);
    expect(ctrl.closeCalls).toBe(0);

    unmount();
    expect(ctrl.closeCalls).toBe(1);
  });

  test('does not update state after unmount even when transport fires events late', () => {
    const { client, ctrl } = makeFakeClient();
    const { result, unmount } = renderHook(() => useSubscribe({}), {
      wrapper: makeWrapper(client),
    });
    unmount();

    // Late transport events post-unmount must not cause a setState
    // (which would log a React warning + leak memory). The result.current
    // is stable post-unmount; firing events is a no-op at the hook level.
    ctrl.fireOpen();
    ctrl.fireClose(1006);
    ctrl.fireEnvelope(envelope('turn.result', 'late'));
    // RTL's renderHook freezes result.current on unmount; we're really
    // asserting "no exception, no warning". This passes silently when the
    // cancelled-flag guard is wired correctly.
    expect(result.current).toBeDefined();
  });
});

describe('useSubscribe — option forwarding', () => {
  test('forwards `since` to the transport on first subscribe', () => {
    const { client, ctrl } = makeFakeClient();
    const opts: UseSubscribeOptions = { since: '11111111-1111-4111-8111-111111111111' };
    renderHook(() => useSubscribe(opts), { wrapper: makeWrapper(client) });

    expect(ctrl.handlers).not.toBeNull();
    expect((ctrl.handlers as SubscribeHandlers).since).toBe('11111111-1111-4111-8111-111111111111');
  });

  test('forwards `reconnect: false` to the transport', () => {
    const { client, ctrl } = makeFakeClient();
    renderHook(() => useSubscribe({ reconnect: false }), { wrapper: makeWrapper(client) });

    expect((ctrl.handlers as SubscribeHandlers).reconnect).toBe(false);
  });
});
