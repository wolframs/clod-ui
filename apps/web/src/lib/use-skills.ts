/**
 * `useSkills` — typed hook over `GET /skills` (Phase 5.6 step 1).
 * I-2 discriminated template; fetch-on-open via `enabled`, same shape
 * as `useSettings` minus the write side (discovery is read-only).
 */
import type { SkillSummary } from '@clod-ui/contracts';
import { ClientError } from '@clod-ui/contracts/client';
import * as React from 'react';

import { useEngine } from './engine-context.tsx';

export type SkillsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; skills: SkillSummary[] }
  | { status: 'error'; error: ClientError }
  | { status: 'not_configured' };

export interface UseSkillsOptions {
  enabled?: boolean;
}

export function useSkills(opts: UseSkillsOptions = {}): { state: SkillsState } {
  const { client } = useEngine();
  const { enabled = true } = opts;

  const [state, setState] = React.useState<SkillsState>(() =>
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
      .getSkills({ signal: controller.signal })
      .then((res) => {
        if (!cancelled) setState({ status: 'ok', skills: res.skills });
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
