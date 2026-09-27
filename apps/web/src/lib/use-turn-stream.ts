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
import { useSubscribe } from './use-subscribe.ts';

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
}

/**
 * Returns the typed projection of the active turn for `conv_id`. Starts at
 * `{ status: 'idle' }` until a `system.init` envelope for this `conv_id`
 * arrives; then transitions through `streaming` → terminal status as
 * envelopes flow.
 *
 * When `conv_id` changes, the state resets synchronously to `idle` (via the
 * "adjust state on prop change" pattern from the React docs) so the
 * consumer never sees stale data from the previous conversation.
 */
export function useTurnStream(options: UseTurnStreamOptions): TurnState {
  const { conv_id, enabled = true } = options;

  // "Adjust state on prop change" pattern: when `conv_id` changes, both
  // `trackedConvId` and `state` reset *during* the render that observed the
  // change. React will discard the in-progress render and start a new one
  // with the fresh values, so the consumer never observes the stale state.
  const [trackedConvId, setTrackedConvId] = useState(conv_id);
  const [state, setState] = useState<TurnState>(INITIAL_TURN_STATE);
  if (trackedConvId !== conv_id) {
    setTrackedConvId(conv_id);
    setState(INITIAL_TURN_STATE);
  }

  useSubscribe({
    enabled,
    ...(options.since !== undefined ? { since: options.since } : {}),
    onEnvelope: (env: EventEnvelope) => {
      if (env.conv_id !== conv_id) return;
      setState((prev) => turnReducer(prev, env));
    },
  });

  return state;
}
