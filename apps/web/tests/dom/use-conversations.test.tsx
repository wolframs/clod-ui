/**
 * `useConversations` — full async lifecycle tests.
 *
 * Mirrors `use-health.test.tsx`: same `Partial<Client>` injection
 * pattern, same `renderHook` + `waitFor` cadence. Adds the `not_configured`
 * variant which `useHealth` doesn't have.
 *
 * Spec: plans/landed/2026-04-29-clod-ui-pr16-sidebar-v1.md §Surface.
 */
import { ClientError, type Client } from '@clod-ui/contracts/client';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useConversations } from '../../src/lib/use-conversations.ts';

function makeFakeClient(overrides: Partial<Client>): Client {
  return overrides as Client;
}

function makeWrapper(client: Client) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client}>{children}</EngineProvider>;
  };
}

describe('useConversations — async lifecycle', () => {
  test('resolves to { status: "ok", conversations } with a non-empty list', async () => {
    const conversations = [
      { conv_id: 'a', created_at: 1, updated_at: 2, title: 'first' },
      { conv_id: 'b', created_at: 3, updated_at: 4 },
    ];
    const client = makeFakeClient({
      getConversations: vi.fn().mockResolvedValue({ conversations }),
    });
    const { result } = renderHook(() => useConversations(), { wrapper: makeWrapper(client) });

    expect(result.current).toEqual({ status: 'loading' });

    await waitFor(() => {
      expect(result.current.status).toBe('ok');
    });
    if (result.current.status !== 'ok') throw new Error('unreachable');
    expect(result.current.conversations).toEqual(conversations);
  });

  test('resolves to { status: "ok", conversations: [] } with an empty list', async () => {
    const client = makeFakeClient({
      getConversations: vi.fn().mockResolvedValue({ conversations: [] }),
    });
    const { result } = renderHook(() => useConversations(), { wrapper: makeWrapper(client) });

    await waitFor(() => {
      expect(result.current.status).toBe('ok');
    });
    if (result.current.status !== 'ok') throw new Error('unreachable');
    expect(result.current.conversations).toEqual([]);
  });

  test('resolves to { status: "error" } on a generic ClientError', async () => {
    const err = new ClientError({
      kind: 'transport',
      message: 'fetch failed',
      path: '/conversations',
    });
    const client = makeFakeClient({
      getConversations: vi.fn().mockRejectedValue(err),
    });
    const { result } = renderHook(() => useConversations(), { wrapper: makeWrapper(client) });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    if (result.current.status !== 'error') throw new Error('unreachable');
    expect(result.current.error).toBe(err);
  });

  test('resolves to { status: "not_configured" } when ClientError.kind is "not_configured"', async () => {
    const err = new ClientError({
      kind: 'not_configured',
      message: 'conversations not configured',
      status: 404,
      path: '/conversations',
    });
    const client = makeFakeClient({
      getConversations: vi.fn().mockRejectedValue(err),
    });
    const { result } = renderHook(() => useConversations(), { wrapper: makeWrapper(client) });

    await waitFor(() => {
      expect(result.current.status).toBe('not_configured');
    });
    expect(result.current).toEqual({ status: 'not_configured' });
  });

  test('aborts the in-flight request on unmount', async () => {
    let capturedSignal: AbortSignal | undefined;
    const blocked = new Promise<never>(() => undefined);
    const getConversations = vi.fn().mockImplementation((opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      return blocked;
    });
    const client = makeFakeClient({ getConversations });

    const { unmount } = renderHook(() => useConversations(), { wrapper: makeWrapper(client) });

    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
