/**
 * `useProfiles` — typed hook over `GET /profiles` (PR #45), I-2
 * discriminated, plus the next new conversation's profile, remembered in
 * `localStorage` (first time, or once the registry drops it: the default).
 * Fetched once per mount; the route is always on, so no `not_configured`.
 */
import type { ProfilesResponse } from '@clod-ui/contracts';
import type { ClientError } from '@clod-ui/contracts/client';
import * as React from 'react';

import { useEngine } from './engine-context.tsx';
import { NEXT_PROFILE_KEY, chooseNextProfile } from './profiles.ts';

export type ProfilesState =
  | { status: 'loading' }
  | { status: 'ok'; profiles: ProfilesResponse }
  | { status: 'error'; error: ClientError };

export interface UseProfilesReturn {
  state: ProfilesState;
  /** The next new conversation's profile; undefined until the list loads. */
  next: string | undefined;
  setNext: (id: string) => void;
}

function readStored(): string | null {
  try {
    return globalThis.localStorage?.getItem(NEXT_PROFILE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function useProfiles(): UseProfilesReturn {
  const { client } = useEngine();
  const [state, setState] = React.useState<ProfilesState>({ status: 'loading' });
  const [stored, setStored] = React.useState<string | null>(readStored);

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    client
      .listProfiles({ signal: controller.signal })
      .then((profiles) => {
        if (!cancelled) setState({ status: 'ok', profiles });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'))) {
          return;
        }
        setState({ status: 'error', error: err as ClientError });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client]);

  const setNext = React.useCallback((id: string) => {
    setStored(id);
    try {
      globalThis.localStorage?.setItem(NEXT_PROFILE_KEY, id);
    } catch {
      // Storage blocked: the choice holds for this page only.
    }
  }, []);

  const next = state.status === 'ok' ? chooseNextProfile(stored, state.profiles) : undefined;
  return { state, next, setNext };
}
