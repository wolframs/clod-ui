/**
 * `useSkills` — async lifecycle tests (PR #31). Same `Partial<Client>`
 * injection pattern as use-settings.test.tsx.
 */
import { ClientError, type Client } from '@clod-ui/contracts/client';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useSkills } from '../../src/lib/use-skills.ts';

function makeWrapper(client: Partial<Client>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client as Client}>{children}</EngineProvider>;
  };
}

const SKILLS = [{ name: 'research', scope: 'user' as const, path: '/u/research' }];

describe('useSkills — lifecycle', () => {
  test('loads to ok with the discovered skills', async () => {
    const client = { getSkills: vi.fn().mockResolvedValue({ skills: SKILLS }) };
    const { result } = renderHook(() => useSkills(), { wrapper: makeWrapper(client) });
    expect(result.current.state).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current.state.status).toBe('ok'));
    expect(result.current.state).toEqual({ status: 'ok', skills: SKILLS });
  });

  test('enabled: false stays idle; flipping on fetches once', async () => {
    const client = { getSkills: vi.fn().mockResolvedValue({ skills: [] }) };
    const { result, rerender } = renderHook(({ enabled }) => useSkills({ enabled }), {
      wrapper: makeWrapper(client),
      initialProps: { enabled: false },
    });
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(client.getSkills).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.state.status).toBe('ok'));
    expect(client.getSkills).toHaveBeenCalledTimes(1);
  });

  test('not_configured and generic errors discriminate', async () => {
    const nc = new ClientError({
      kind: 'not_configured',
      message: 'skills not configured',
      path: '/skills',
    });
    const c1 = { getSkills: vi.fn().mockRejectedValue(nc) };
    const r1 = renderHook(() => useSkills(), { wrapper: makeWrapper(c1) });
    await waitFor(() => expect(r1.result.current.state.status).toBe('not_configured'));

    const boom = new ClientError({ kind: 'transport', message: 'down', path: '/skills' });
    const c2 = { getSkills: vi.fn().mockRejectedValue(boom) };
    const r2 = renderHook(() => useSkills(), { wrapper: makeWrapper(c2) });
    await waitFor(() => expect(r2.result.current.state.status).toBe('error'));
  });
});
