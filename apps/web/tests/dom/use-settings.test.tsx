/**
 * `useSettings` — async lifecycle tests (PR #30). Same `Partial<Client>`
 * injection pattern as use-conversations.test.tsx.
 */
import type { ClaudeSettings } from '@clod-ui/contracts';
import { ClientError, type Client } from '@clod-ui/contracts/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useSettings } from '../../src/lib/use-settings.ts';

function makeWrapper(client: Partial<Client>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client as Client}>{children}</EngineProvider>;
  };
}

const DOC: ClaudeSettings = { theme: 'dark', unknown: { x: 1 } };

describe('useSettings — lifecycle', () => {
  test('loads to ok with the fetched document', async () => {
    const client = { getSettings: vi.fn().mockResolvedValue(DOC) };
    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper(client) });
    expect(result.current.state).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current.state.status).toBe('ok'));
    expect(result.current.state).toEqual({ status: 'ok', settings: DOC, saving: false });
  });

  test('enabled: false stays idle and never fetches; flipping on fetches', async () => {
    const client = { getSettings: vi.fn().mockResolvedValue(DOC) };
    const { result, rerender } = renderHook(({ enabled }) => useSettings({ enabled }), {
      wrapper: makeWrapper(client),
      initialProps: { enabled: false },
    });
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(client.getSettings).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.state.status).toBe('ok'));
  });

  test('not_configured ClientError discriminates to its own status', async () => {
    const err = new ClientError({
      kind: 'not_configured',
      message: 'settings not configured',
      path: '/settings',
    });
    const client = { getSettings: vi.fn().mockRejectedValue(err) };
    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.state.status).toBe('not_configured'));
  });

  test('generic failure → error', async () => {
    const err = new ClientError({ kind: 'transport', message: 'down', path: '/settings' });
    const client = { getSettings: vi.fn().mockRejectedValue(err) };
    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.state.status).toBe('error'));
  });

  test('save PUTs the document and updates state to the response', async () => {
    const written: ClaudeSettings = { theme: 'light', unknown: { x: 1 } };
    const client = {
      getSettings: vi.fn().mockResolvedValue(DOC),
      putSettings: vi.fn().mockResolvedValue(written),
    };
    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.state.status).toBe('ok'));

    let okPromise: Promise<boolean>;
    act(() => {
      okPromise = result.current.save(written);
    });
    await act(async () => {
      expect(await okPromise).toBe(true);
    });
    expect(client.putSettings).toHaveBeenCalledWith(written);
    expect(result.current.state).toEqual({ status: 'ok', settings: written, saving: false });
  });

  test('failed save flips to error and resolves false', async () => {
    const err = new ClientError({ kind: 'http', message: '500', path: '/settings' });
    const client = {
      getSettings: vi.fn().mockResolvedValue(DOC),
      putSettings: vi.fn().mockRejectedValue(err),
    };
    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.state.status).toBe('ok'));
    await act(async () => {
      expect(await result.current.save({ theme: 'light' })).toBe(false);
    });
    expect(result.current.state.status).toBe('error');
  });
});
