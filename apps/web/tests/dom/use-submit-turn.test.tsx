/**
 * `useSubmitTurn` — full async lifecycle tests against a fake `Client`.
 *
 * Covers the submission state machine end-to-end:
 *   idle → submitting (after submit() call)
 *        → idle (on resolve) | error (on reject)
 *   reset() → idle (from any state)
 *
 * Plus the input-validation short-circuits (no conv_id, empty text)
 * and the stale-resolve-no-clobber invariant (a previous submit's
 * resolve must not overwrite a newer submit's state).
 *
 * Spec: plans/landed/2026-05-02-clod-ui-pr19-composer-v1.md §5 + §7.
 */
import { ClientError, type Client } from '@clod-ui/contracts/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useSubmitTurn } from '../../src/lib/use-submit-turn.ts';

function makeFakeClient(overrides: Partial<Client>): Client {
  return overrides as Client;
}

function makeWrapper(client: Client) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client}>{children}</EngineProvider>;
  };
}

describe('useSubmitTurn — submission state machine', () => {
  test('starts idle; submit() transitions to submitting then back to idle on resolve', async () => {
    const submitTurn = vi.fn().mockResolvedValue(undefined);
    const client = makeFakeClient({ submitTurn });
    const { result } = renderHook(
      () => useSubmitTurn({ conv_id: 'conv-a', generateTurnId: () => 'turn-1' }),
      { wrapper: makeWrapper(client) },
    );

    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.lastTurnId).toBeUndefined();

    await act(async () => {
      await result.current.submit({ user_message: 'hello' });
    });

    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.lastTurnId).toBe('turn-1');
    expect(submitTurn).toHaveBeenCalledWith({
      conv_id: 'conv-a',
      turn_id: 'turn-1',
      user_message: 'hello',
    });
  });

  test('submit() transitions to error on reject; preserves attempted_text', async () => {
    const err = new ClientError({
      kind: 'http',
      message: '500 internal',
      path: '/conversations/conv-a/turns',
      status: 500,
    });
    const submitTurn = vi.fn().mockRejectedValue(err);
    const client = makeFakeClient({ submitTurn });
    const { result } = renderHook(
      () => useSubmitTurn({ conv_id: 'conv-a', generateTurnId: () => 'turn-2' }),
      { wrapper: makeWrapper(client) },
    );

    await act(async () => {
      await result.current.submit({ user_message: 'will fail' });
    });

    expect(result.current.state.status).toBe('error');
    if (result.current.state.status !== 'error') throw new Error('unreachable');
    expect(result.current.state.error).toBe(err);
    expect(result.current.state.attempted_text).toBe('will fail');
    expect(result.current.lastTurnId).toBe('turn-2');
  });

  test('reset() returns to idle from error', async () => {
    const submitTurn = vi.fn().mockRejectedValue(new Error('boom'));
    const client = makeFakeClient({ submitTurn });
    const { result } = renderHook(
      () => useSubmitTurn({ conv_id: 'conv-a', generateTurnId: () => 'turn-3' }),
      { wrapper: makeWrapper(client) },
    );

    await act(async () => {
      await result.current.submit({ user_message: 'fail' });
    });
    expect(result.current.state.status).toBe('error');

    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toEqual({ status: 'idle' });
  });
});

describe('useSubmitTurn — short-circuits', () => {
  test('returns undefined and does NOT call submitTurn when conv_id is undefined', async () => {
    const submitTurn = vi.fn();
    const client = makeFakeClient({ submitTurn });
    const { result } = renderHook(
      () => useSubmitTurn({ conv_id: undefined, generateTurnId: () => 'never' }),
      { wrapper: makeWrapper(client) },
    );

    let returned: string | undefined = 'sentinel';
    await act(async () => {
      returned = await result.current.submit({ user_message: 'hello' });
    });
    expect(returned).toBeUndefined();
    expect(submitTurn).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  test('returns undefined and does NOT call submitTurn when text is empty after trim', async () => {
    const submitTurn = vi.fn();
    const client = makeFakeClient({ submitTurn });
    const { result } = renderHook(
      () => useSubmitTurn({ conv_id: 'conv-a', generateTurnId: () => 'never' }),
      { wrapper: makeWrapper(client) },
    );

    let returned: string | undefined = 'sentinel';
    await act(async () => {
      returned = await result.current.submit({ user_message: '   \n  \t  ' });
    });
    expect(returned).toBeUndefined();
    expect(submitTurn).not.toHaveBeenCalled();
  });
});

describe('useSubmitTurn — stale-resolve invariant', () => {
  test('older submit resolving after a newer one does NOT clobber the newer state', async () => {
    // Resolvers we control manually so we can interleave the two submits.
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const submitTurn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((res) => (resolveFirst = res)))
      .mockImplementationOnce(() => new Promise<void>((res) => (resolveSecond = res)));

    const client = makeFakeClient({ submitTurn });

    let counter = 0;
    const { result } = renderHook(
      () =>
        useSubmitTurn({
          conv_id: 'conv-a',
          generateTurnId: () => `turn-${++counter}`,
        }),
      { wrapper: makeWrapper(client) },
    );

    // Fire both submits; do NOT await them yet.
    let firstPromise!: Promise<string | undefined>;
    let secondPromise!: Promise<string | undefined>;
    act(() => {
      firstPromise = result.current.submit({ user_message: 'first' });
      secondPromise = result.current.submit({ user_message: 'second' });
    });

    // After both submits fire, state should reflect the SECOND turn_id.
    await waitFor(() => {
      expect(result.current.lastTurnId).toBe('turn-2');
    });
    expect(result.current.state).toEqual({ status: 'submitting', turn_id: 'turn-2' });

    // Resolve the FIRST submit. Stale; must not clobber state back to idle.
    await act(async () => {
      resolveFirst();
      await firstPromise;
    });
    expect(result.current.state).toEqual({ status: 'submitting', turn_id: 'turn-2' });

    // Now resolve the second; state flips to idle.
    await act(async () => {
      resolveSecond();
      await secondPromise;
    });
    expect(result.current.state).toEqual({ status: 'idle' });
  });
});

describe('useSubmitTurn — adjust state on conv_id change', () => {
  test('conv_id change resets state + lastTurnId; in-flight resolve from previous conv does not clobber', async () => {
    let resolveFirst!: () => void;
    const submitTurn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((res) => (resolveFirst = res)))
      .mockResolvedValue(undefined);

    const client = makeFakeClient({ submitTurn });

    let counter = 0;
    const generateTurnId = () => `turn-${++counter}`;

    const { result, rerender } = renderHook(
      ({ conv_id }: { conv_id: string }) => useSubmitTurn({ conv_id, generateTurnId }),
      { wrapper: makeWrapper(client), initialProps: { conv_id: 'convA' } },
    );

    // Submit on convA; state goes to submitting.
    act(() => {
      void result.current.submit({ user_message: 'first' });
    });
    expect(result.current.state).toEqual({ status: 'submitting', turn_id: 'turn-1' });
    expect(result.current.lastTurnId).toBe('turn-1');

    // Switch to convB *while convA's submit is still in flight*.
    rerender({ conv_id: 'convB' });

    // State must be reset synchronously — no frame of the previous
    // conversation's state visible under the new conv_id.
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.lastTurnId).toBeUndefined();

    // Resolve convA's submit. The stale resolve must NOT clobber convB's
    // (already-reset) state.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
    });
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.lastTurnId).toBeUndefined();

    // Submit on convB works correctly with a fresh turn_id.
    await act(async () => {
      await result.current.submit({ user_message: 'second' });
    });
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.lastTurnId).toBe('turn-2');
    expect(submitTurn).toHaveBeenLastCalledWith({
      conv_id: 'convB',
      turn_id: 'turn-2',
      user_message: 'second',
    });
  });

  test('conv_id change clears prior error state', async () => {
    const submitTurn = vi.fn().mockRejectedValueOnce(new Error('convA failed'));
    const client = makeFakeClient({ submitTurn });

    const { result, rerender } = renderHook(
      ({ conv_id }: { conv_id: string }) =>
        useSubmitTurn({ conv_id, generateTurnId: () => 'turn-x' }),
      { wrapper: makeWrapper(client), initialProps: { conv_id: 'convA' } },
    );

    await act(async () => {
      await result.current.submit({ user_message: 'fail' });
    });
    expect(result.current.state.status).toBe('error');

    // Switching conv_id must clear the error so convB doesn't render
    // convA's failure in its Composer.
    rerender({ conv_id: 'convB' });
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.lastTurnId).toBeUndefined();
  });
});
