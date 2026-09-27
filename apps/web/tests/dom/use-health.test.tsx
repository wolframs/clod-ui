/**
 * `useHealth` — full async lifecycle tests under happy-dom + RTL.
 *
 * Lifts the `// TODO(vitest-rtl)` placed by PR #14 in
 * `apps/web/src/lib/use-health.ts`. The previous Bun-test reach
 * (`renderToString`) only verified the loading variant because
 * `useEffect` doesn't run server-side. Here we exercise the full
 * effect lifecycle: mount → fetch → state transition → unmount cleanup.
 *
 * Spec: plans/landed/2026-04-29-clod-ui-pr15-vitest-rtl-v1.md §Surface.
 */
import { ClientError, type Client } from '@clod-ui/contracts/client';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useHealth } from '../../src/lib/use-health.ts';

/**
 * Build a minimal `Client` with only the methods the tests need.
 * Casting through `unknown` keeps the type narrow at the call site;
 * a test that touches an unset method will throw a clear "is not a
 * function" error rather than silently no-op.
 */
function makeFakeClient(overrides: Partial<Client>): Client {
  return overrides as Client;
}

function makeWrapper(client: Client) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client}>{children}</EngineProvider>;
  };
}

describe('useHealth — async lifecycle', () => {
  test('resolves to { status: "ok", health } when getHealth succeeds', async () => {
    const health = {
      cli: 'ok' as const,
      version: '2.1.0',
      engine_version: '0.0.0',
      started_at: 1234,
    };
    const client = makeFakeClient({
      getHealth: vi.fn().mockResolvedValue(health),
    });
    const { result } = renderHook(() => useHealth(), {
      wrapper: makeWrapper(client),
    });

    // Initial state is loading (synchronously, before the effect runs).
    expect(result.current).toEqual({ status: 'loading' });

    await waitFor(() => {
      expect(result.current.status).toBe('ok');
    });
    expect(result.current).toEqual({ status: 'ok', health });
  });

  test('resolves to { status: "error", error } when getHealth rejects with a ClientError', async () => {
    const err = new ClientError({
      kind: 'transport',
      message: 'fetch failed: ECONNREFUSED',
      path: '/health',
    });
    const client = makeFakeClient({
      getHealth: vi.fn().mockRejectedValue(err),
    });
    const { result } = renderHook(() => useHealth(), {
      wrapper: makeWrapper(client),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    if (result.current.status !== 'error') throw new Error('unreachable');
    expect(result.current.error).toBe(err);
    expect(result.current.error.message).toBe('fetch failed: ECONNREFUSED');
  });

  test('aborts the in-flight request when the consumer unmounts', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveHealth: (() => void) | undefined;
    const blockedPromise = new Promise<never>((_resolve) => {
      // Capture nothing on resolve; the test never resolves the promise.
      // We only care about the abort path.
      resolveHealth = () => undefined;
    });
    void resolveHealth; // silence "unused" without disabling the rule

    const getHealth = vi.fn().mockImplementation((opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      return blockedPromise;
    });
    const client = makeFakeClient({ getHealth });

    const { unmount } = renderHook(() => useHealth(), {
      wrapper: makeWrapper(client),
    });

    // Effect runs, fetch is in flight, signal is captured but not yet aborted.
    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    // The cleanup function on the effect aborts the controller.
    expect(capturedSignal?.aborted).toBe(true);
  });

  test('does not update state after unmount even if the request resolves late', async () => {
    let resolveHealth: ((value: unknown) => void) | undefined;
    const lateResolved = new Promise<unknown>((resolve) => {
      resolveHealth = resolve;
    });
    const client = makeFakeClient({
      getHealth: vi.fn().mockReturnValue(lateResolved),
    });

    const { result, unmount } = renderHook(() => useHealth(), {
      wrapper: makeWrapper(client),
    });

    expect(result.current).toEqual({ status: 'loading' });

    unmount();

    // Resolve after unmount; the hook's `cancelled` guard must prevent
    // a state update on an unmounted consumer (which would also log a
    // React warning, but we assert on the data: state did not transition).
    resolveHealth?.({ cli: 'ok', engine_version: '0.0.0', started_at: 0 });

    // Give the microtask queue a tick to run.
    await Promise.resolve();
    await Promise.resolve();

    // Result is still `loading` because the hook unmounted before the
    // promise resolved; no state mutation happened post-unmount.
    expect(result.current).toEqual({ status: 'loading' });
  });
});
