/**
 * `useSubscribe` — typed React hook over `client.subscribe(...)`.
 *
 * Lands the seam every streaming UI consumer (transcript renderer, composer,
 * activity pill) reaches through. Handles:
 *
 *   - Subscription lifecycle bound to the component lifecycle (mount → open
 *     → unmount cleanup).
 *   - Discriminated connection state (`connecting | open | reconnecting |
 *     closed | idle`) so the UI can render an offline / reconnecting badge.
 *   - Per-kind envelope dispatch with ref-stable handlers (changing handler
 *     refs between renders does NOT re-subscribe).
 *   - `enabled: false` to suppress the subscription (feature flags, route-
 *     conditional reads).
 *
 * The transport's reconnect-and-resume policy continues to apply: on a non-
 * clean close (code !== 1000), the transport schedules a reconnect with
 * `?since=<lastEventId>` so missed envelopes replay. The hook surfaces the
 * `reconnecting` state in between but takes no action on it.
 *
 * Spec: plans/landed/2026-04-30-clod-ui-pr18a-use-subscribe-v1.md.
 * Lifecycle tests: apps/web/tests/dom/use-subscribe.test.tsx.
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import type { Subscription } from '@clod-ui/contracts/client';
import { useEffect, useRef, useState } from 'react';

import { useEngine } from './engine-context.tsx';

export interface UseSubscribeOptions {
  /**
   * Per-kind handler dispatch. The hook stashes the latest snapshot in a
   * ref every render, so changing handlers does NOT re-subscribe — a
   * critical property for components that derive handlers from props or
   * other hooks.
   */
  on?: Record<string, (env: EventEnvelope) => void>;
  /** Catch-all envelope handler. Same ref-stability semantics as `on`. */
  onEnvelope?: (env: EventEnvelope) => void;
  /**
   * Initial replay cursor. Only consulted on the first subscription;
   * subsequent reconnects use the transport's internal lastEventId.
   */
  since?: string;
  /**
   * Reconnect policy. Defaults to enabled with the transport's standard
   * exponential backoff. `false` disables reconnects entirely.
   *
   * Pass a stable reference (constant or `useMemo`-wrapped) — the hook
   * re-subscribes when this value changes by reference.
   */
  reconnect?: false | { backoffMs?: number[]; maxAttempts?: number };
  /**
   * When `false`, no subscription opens and state stays `idle`. Useful for
   * feature flags, route-conditional subscriptions, or SSR. Toggling to
   * `true` opens a subscription; toggling back to `false` closes it.
   * Default: `true`.
   */
  enabled?: boolean;
}

export type SubscribeState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'open' }
  | { status: 'reconnecting'; lastClose: { code: number; reason: string } }
  | { status: 'closed'; lastClose: { code: number; reason: string } };

export function useSubscribe(options: UseSubscribeOptions): SubscribeState {
  const { client } = useEngine();
  const enabled = options.enabled ?? true;

  // Ref-stable handler snapshots. Updated every render; the effect's
  // dispatch reads `handlersRef.current` per envelope so changing handler
  // refs between renders never re-subscribes.
  const handlersRef = useRef<{
    on: Record<string, (env: EventEnvelope) => void> | undefined;
    onEnvelope: ((env: EventEnvelope) => void) | undefined;
  }>({ on: options.on, onEnvelope: options.onEnvelope });
  handlersRef.current.on = options.on;
  handlersRef.current.onEnvelope = options.onEnvelope;

  const [state, setState] = useState<SubscribeState>({ status: 'idle' });

  // Reconnect-derived flag: when `reconnect: false`, a non-clean close
  // lands in `closed` (transport will not retry). Otherwise `reconnecting`
  // (transport will retry per its backoff schedule).
  const reconnectActive = options.reconnect !== false;

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setState({ status: 'connecting' });

    const subscription: Subscription = client.subscribe({
      onOpen: () => {
        if (cancelled) return;
        setState({ status: 'open' });
      },
      onClose: (ev) => {
        if (cancelled) return;
        // 1000 = clean close (consumer-initiated or graceful server). The
        // transport will not reconnect; we stay informed via 'closed'.
        if (ev.code === 1000 || !reconnectActive) {
          setState({ status: 'closed', lastClose: ev });
          return;
        }
        setState({ status: 'reconnecting', lastClose: ev });
      },
      onEnvelope: (env) => {
        if (cancelled) return;
        const h = handlersRef.current;
        h.on?.[env.kind]?.(env);
        h.onEnvelope?.(env);
      },
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
    });

    return () => {
      cancelled = true;
      subscription.close();
    };
    // `options.since` is initial-only on the transport, but a change should
    // still re-subscribe at this layer (caller wants a fresh resume cursor).
    // Handlers are deliberately NOT deps — they flow through the ref.
  }, [client, enabled, options.since, options.reconnect, reconnectActive]);

  return state;
}
