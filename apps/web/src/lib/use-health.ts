/**
 * `useHealth` — first concrete consumer of `useEngine()`.
 *
 * Calls `client.getHealth()` once on mount, exposes a discriminated state
 * union, cancels via `AbortController` on unmount. The returned shape lets
 * the badge render exhaustively without nullable optionals at the leaf.
 *
 * Spec: plans/landed/2026-04-29-clod-ui-pr14-engine-provider-v1.md §4.
 * Lifecycle tests: apps/web/tests/dom/use-health.test.tsx (PR #15).
 */
import type { HealthResponse } from '@clod-ui/contracts';
import type { ClientError } from '@clod-ui/contracts/client';
import { useEffect, useState } from 'react';

import { useEngine } from './engine-context.tsx';

export type HealthState =
  | { status: 'loading' }
  | { status: 'ok'; health: HealthResponse }
  | { status: 'error'; error: ClientError };

export function useHealth(): HealthState {
  const { client } = useEngine();
  const [state, setState] = useState<HealthState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    client
      .getHealth({ signal: controller.signal })
      .then((health) => {
        if (cancelled) return;
        setState({ status: 'ok', health });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // ClientError is the documented rejection type; anything else is a
        // bug in the transport, but we still surface it without crashing.
        setState({ status: 'error', error: err as ClientError });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client]);

  return state;
}
