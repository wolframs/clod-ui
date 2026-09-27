/**
 * `useConversations` — typed hook over `client.getConversations()`.
 *
 * Mirrors `useHealth`'s lifecycle (mount → fetch → state transition →
 * unmount cleanup) but adds a `not_configured` variant to the
 * discriminated state so the sidebar can render a distinct affordance
 * when the engine is running without `--persist`.
 *
 * Spec: plans/landed/2026-04-29-clod-ui-pr16-sidebar-v1.md §Surface.
 * Lifecycle tests: apps/web/tests/dom/use-conversations.test.tsx.
 */
import type { ConversationSummary } from '@clod-ui/contracts';
import { ClientError } from '@clod-ui/contracts/client';
import { useEffect, useState } from 'react';

import { useEngine } from './engine-context.tsx';

export type ConversationsState =
  | { status: 'loading' }
  | { status: 'ok'; conversations: ConversationSummary[] }
  | { status: 'error'; error: ClientError }
  | { status: 'not_configured' };

export function useConversations(): ConversationsState {
  const { client } = useEngine();
  const [state, setState] = useState<ConversationsState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    client
      .getConversations({ signal: controller.signal })
      .then((res) => {
        if (cancelled) return;
        setState({ status: 'ok', conversations: res.conversations });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ClientError && err.kind === 'not_configured') {
          setState({ status: 'not_configured' });
          return;
        }
        // ClientError is the documented rejection type; anything else is
        // a transport bug, but we still surface it without crashing.
        setState({ status: 'error', error: err as ClientError });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client]);

  return state;
}
