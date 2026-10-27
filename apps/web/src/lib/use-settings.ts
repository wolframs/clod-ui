/**
 * `useSettings` — typed hook over `GET/PUT /settings` (Phase 5.4).
 *
 * I-2 discriminated template (`loading | ok | error | not_configured`),
 * mirroring `useTranscript`'s lifecycle: enabled gate, cancellation ref,
 * abort on unmount, `refetch`. `save()` PUTs a full document (the diff
 * preview in `<SettingsPanel />` is the deliberateness gate before any
 * write to CC's real settings file); while in flight the `ok` variant
 * carries `saving: true`.
 *
 * Spec: plans/2026-06-12-clod-ui-pr30-preferences-ui-v1.md §D1.
 */
import type { ClaudeSettings } from '@clod-ui/contracts';
import { ClientError } from '@clod-ui/contracts/client';
import * as React from 'react';

import { useEngine } from './engine-context.tsx';

export type SettingsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; settings: ClaudeSettings; saving: boolean }
  | { status: 'error'; error: ClientError }
  | { status: 'not_configured' };

export interface UseSettingsReturn {
  state: SettingsState;
  refetch: () => void;
  /**
   * PUT a full settings document. Resolves to true on success (state
   * updates to the engine's response); false on failure (state flips to
   * 'error'). No-op unless state is 'ok' and no save is in flight.
   */
  save: (next: ClaudeSettings) => Promise<boolean>;
}

export interface UseSettingsOptions {
  /** When false, stay 'idle' and never fetch (hook-tree stability). */
  enabled?: boolean;
}

export function useSettings(opts: UseSettingsOptions = {}): UseSettingsReturn {
  const { client } = useEngine();
  const { enabled = true } = opts;

  const [state, setState] = React.useState<SettingsState>(() =>
    enabled ? { status: 'loading' } : { status: 'idle' },
  );

  // Adjust state on prop change: re-arm the fetch when `enabled` flips
  // (panel reopened), drop to idle when disabled.
  const trackedEnabledRef = React.useRef(enabled);
  if (trackedEnabledRef.current !== enabled) {
    trackedEnabledRef.current = enabled;
    setState(enabled ? { status: 'loading' } : { status: 'idle' });
  }

  const [fetchKey, setFetchKey] = React.useState(0);

  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;

    client
      .getSettings({ signal: controller.signal })
      .then((settings) => {
        if (cancelled) return;
        setState({ status: 'ok', settings, saving: false });
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
  }, [client, enabled, fetchKey]);

  const refetch = React.useCallback(() => {
    if (!enabled) return;
    setFetchKey((k) => k + 1);
  }, [enabled]);

  const stateRef = React.useRef(state);
  stateRef.current = state;

  const save = React.useCallback(
    async (next: ClaudeSettings): Promise<boolean> => {
      const current = stateRef.current;
      if (current.status !== 'ok' || current.saving) return false;
      setState({ ...current, saving: true });
      try {
        const written = await client.putSettings(next);
        setState({ status: 'ok', settings: written, saving: false });
        return true;
      } catch (err) {
        setState({ status: 'error', error: err as ClientError });
        return false;
      }
    },
    [client],
  );

  return { state, refetch, save };
}
