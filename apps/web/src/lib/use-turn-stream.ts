/**
 * `useTurnStream` — typed React hook projecting the active turn's state from
 * the wire's envelope stream.
 *
 * Composes `useSubscribe` underneath, then folds matching envelopes through
 * `turnReducer` into a discriminated `TurnState`. The renderer reads
 * `turn.assistant_text`, `turn.tools`, `turn.status` etc. directly without
 * touching `EventEnvelope` payloads.
 *
 * Conv-id filtering is client-side: the engine broadcasts all envelopes to
 * all subscribers, and this hook drops envelopes whose `conv_id` doesn't
 * match. Cheap (one string comparison per envelope) and keeps the engine
 * surface simple.
 *
 * Spec: plans/landed/2026-05-01-clod-ui-pr18b-use-turn-stream-v1.md.
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import { useState } from 'react';

import { INITIAL_TURN_STATE, type TurnState, turnReducer } from './turn-reducer.ts';
import { useSubscribe, type SubscribeState } from './use-subscribe.ts';

export interface UseTurnStreamOptions {
  /** Conversation id to project. Required. */
  conv_id: string;
  /**
   * When `false`, the underlying subscription stays closed and the projection
   * stays `idle`. Toggling to `true` opens the subscription. Default: `true`.
   */
  enabled?: boolean;
  /**
   * Initial replay cursor forwarded to the subscription. Useful when resuming
   * a turn observation from a known checkpoint.
   */
  since?: string;
  /**
   * Sees every envelope on the socket, before the conv_id filter. For
   * cross-conversation signals (`conversation.titled` refreshing the
   * sidebar) without opening a second socket. Ref-stable like `on`.
   */
  onAnyEnvelope?: (env: EventEnvelope) => void;
}

export interface UseTurnStreamResult {
  /** Typed projection of the active turn (folded via `turnReducer`). */
  turn: TurnState;
  /**
   * Connection state of the underlying subscription — the one feeding
   * `turn`, not a separate probe. Drives `<ConnectionBanner />` (PR #22).
   */
  connection: SubscribeState;
}

/**
 * Returns the typed projection of the active turn for `conv_id` plus the
 * underlying subscription's connection state. The turn starts at
 * `{ status: 'idle' }` until a `system.init` envelope for this `conv_id`
 * arrives; then transitions through `streaming` → terminal status as
 * envelopes flow.
 *
 * Every conversation's turn is projected, not just the selected one: the
 * socket is shared, so switching A → B → A while A streams must come back
 * to A's live turn, not to `idle` (the subscription does not replay on a
 * selection change). The consumer only ever sees the projection for
 * `conv_id`, so it never observes another conversation's data.
 */
export function useTurnStream(options: UseTurnStreamOptions): UseTurnStreamResult {
  const { conv_id, enabled = true } = options;

  const [byConv, setByConv] = useState<Record<string, TurnState>>({});
  const state = byConv[conv_id] ?? INITIAL_TURN_STATE;

  const connection = useSubscribe({
    enabled,
    ...(options.since !== undefined ? { since: options.since } : {}),
    onEnvelope: (env: EventEnvelope) => {
      options.onAnyEnvelope?.(env);
      const id = env.conv_id;
      if (typeof id !== 'string' || id === '') return;
      setByConv((prev) => {
        const before = prev[id] ?? INITIAL_TURN_STATE;
        const after = turnReducer(before, env);
        return after === before ? prev : { ...prev, [id]: after };
      });
    },
  });

  return { turn: state, connection };
}
