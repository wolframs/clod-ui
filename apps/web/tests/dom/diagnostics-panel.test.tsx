/**
 * Interaction tests for `<DiagnosticsPanel />` + `useDiagnostics`
 * (PR #32) — lifecycle + the Copy-repro export shape.
 */
import type { TurnDiagnostics } from '@clod-ui/contracts';
import { ClientError, type Client } from '@clod-ui/contracts/client';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DiagnosticsPanel } from '../../src/components/diagnostics-panel.tsx';
import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useDiagnostics } from '../../src/lib/use-diagnostics.ts';

function makeWrapper(client: Partial<Client>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client as Client}>{children}</EngineProvider>;
  };
}

const TURN: TurnDiagnostics = {
  turn_id: 't-1',
  conv_id: 'c-1',
  started_at: 100,
  argv: ['claude', '-p'],
  env_keys: [],
  stdin_bytes: 10,
  cwd: '/tmp',
  events: [{ ts: 110, kind: 'turn.result', event: { kind: 'turn.result' } }],
  outcome: { kind: 'result' },
};

describe('useDiagnostics — lifecycle', () => {
  it('loads to ok; not_configured discriminates', async () => {
    const ok = { getDiagnostics: vi.fn().mockResolvedValue({ turns: [TURN] }) };
    const r1 = renderHook(() => useDiagnostics(), { wrapper: makeWrapper(ok) });
    await waitFor(() => expect(r1.result.current.state.status).toBe('ok'));

    const nc = new ClientError({
      kind: 'not_configured',
      message: 'diagnostics not configured',
      path: '/diagnostics',
    });
    const bad = { getDiagnostics: vi.fn().mockRejectedValue(nc) };
    const r2 = renderHook(() => useDiagnostics(), { wrapper: makeWrapper(bad) });
    await waitFor(() => expect(r2.result.current.state.status).toBe('not_configured'));
  });
});

describe('DiagnosticsPanel — Copy repro', () => {
  it('writes ScriptedBackend-consumable JSON to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<DiagnosticsPanel open state={{ status: 'ok', turns: [TURN] }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Copy repro'));
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(writeText.mock.calls[0]?.[0] as string) as {
      request: { turn_id: string };
      events: Array<{ kind: string }>;
    };
    // `events` is exactly ScriptedBackend's `{ events }` input shape.
    expect(payload.events).toEqual([{ kind: 'turn.result' }]);
    expect(payload.request.turn_id).toBe('t-1');
  });
});
