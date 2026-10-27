/**
 * `useModels` — typed hook over `GET /models` (PR #42): the CLI's own model list.
 * I-2 discriminated template, the `useSkills` shape. Fetched once per mount;
 * the engine caches the CLI probe for ten minutes.
 */
import type { ModelInfo } from '@clod-ui/contracts';
import { ClientError } from '@clod-ui/contracts/client';
import * as React from 'react';

import { useEngine } from './engine-context.tsx';

export type ModelsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; models: ModelInfo[] }
  | { status: 'error'; error: ClientError }
  | { status: 'not_configured' };

export interface UseModelsOptions {
  enabled?: boolean;
}

export function useModels(opts: UseModelsOptions = {}): { state: ModelsState } {
  const { client } = useEngine();
  const { enabled = true } = opts;

  const [state, setState] = React.useState<ModelsState>(() =>
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
      .getModels({ signal: controller.signal })
      .then((res) => {
        if (!cancelled) setState({ status: 'ok', models: res.models });
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
