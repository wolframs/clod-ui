/**
 * `useDiagnostics` — typed hook over `GET /diagnostics` (Phase 5.7).
 * I-2 discriminated template; fetch-on-open, read-only (the ring is
 * engine-side and wire-only by I-8).
 */
import type { TurnDiagnostics } from '@clod-ui/contracts';
import { ClientError } from '@clod-ui/contracts/client';
import * as React from 'react';

import { useEngine } from './engine-context.tsx';

export type DiagnosticsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; turns: TurnDiagnostics[] }
  | { status: 'error'; error: ClientError }
  | { status: 'not_configured' };

export function useDiagnostics(opts: { enabled?: boolean } = {}): { state: DiagnosticsState } {
  const { client } = useEngine();
  const { enabled = true } = opts;

  const [state, setState] = React.useState<DiagnosticsState>(() =>
    enabled ? { status: 'loading' } : { status: 'idle' },
  );

  const trackedEnabledRef = React.useRef(enabled);
  if (trackedEnabledRef.current !== enabled) {
    trackedEnabledRef.current = enabled;
    setState(enabled ? { status: 'loading' } : { status: 'idle' });
  }

  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;

    client
      .getDiagnostics({ signal: controller.signal })
      .then((res) => {
        if (!cancelled) setState({ status: 'ok', turns: res.turns });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ClientError && err.kind === 'not_configured') {
          setState({ status: 'not_configured' });
          return;
        }
        if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'))) {
          return;
        }
        setState({ status: 'error', error: err as ClientError });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, enabled]);

  return { state };
}
