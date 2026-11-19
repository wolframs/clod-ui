/**
 * `useProfiles` — lifecycle + the remembered next-conversation choice
 * (PR #45). Same `Partial<Client>` injection as use-skills.test.tsx.
 */
import { ClientError, type Client } from '@clod-ui/contracts/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { NEXT_PROFILE_KEY } from '../../src/lib/profiles.ts';
import { useProfiles } from '../../src/lib/use-profiles.ts';

function makeWrapper(client: Partial<Client>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client as Client}>{children}</EngineProvider>;
  };
}

/** happy-dom's localStorage here has no Storage API (see use-theme.test.tsx). */
function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  return map;
}

const RES = {
  default: 'seat',
  profiles: [
    { id: 'seat', label: 'Seat' },
    { id: 'lab', label: 'lab' },
  ],
};

let storage: Map<string, string>;
beforeEach(() => {
  storage = installLocalStorage();
});

describe('useProfiles', () => {
  test('loads; first time the next profile is the registry default', async () => {
    const client = { listProfiles: vi.fn().mockResolvedValue(RES) };
    const { result } = renderHook(() => useProfiles(), { wrapper: makeWrapper(client) });
    expect(result.current.state).toEqual({ status: 'loading' });
    expect(result.current.next).toBeUndefined();
    await waitFor(() => expect(result.current.state.status).toBe('ok'));
    expect(result.current.next).toBe('seat');
  });

  test('setNext is remembered; a stored id the registry dropped falls back', async () => {
    const client = { listProfiles: vi.fn().mockResolvedValue(RES) };
    const first = renderHook(() => useProfiles(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(first.result.current.state.status).toBe('ok'));
    act(() => first.result.current.setNext('lab'));
    expect(first.result.current.next).toBe('lab');
    expect(storage.get(NEXT_PROFILE_KEY)).toBe('lab');

    const again = renderHook(() => useProfiles(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(again.result.current.next).toBe('lab'));

    storage.set(NEXT_PROFILE_KEY, 'gone');
    const stale = renderHook(() => useProfiles(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(stale.result.current.next).toBe('seat'));
  });

  test('an error discriminates', async () => {
    const boom = new ClientError({ kind: 'transport', message: 'down', path: '/profiles' });
    const client = { listProfiles: vi.fn().mockRejectedValue(boom) };
    const { result } = renderHook(() => useProfiles(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(result.current.next).toBeUndefined();
  });
});
