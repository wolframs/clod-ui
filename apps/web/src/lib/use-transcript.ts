/**
 * `useTranscript` — typed hook over `client.getTranscript(conv_id)`.
 *
 * Renders the conversation's history (all messages persisted to the JSONL
 * transcript file, projected through `normalizeTranscriptLines`). Composes
 * with `useTurnStream` in App.tsx: history above the active turn.
 *
 * Spec: plans/2026-05-06-clod-ui-pr20b-transcript-history-v1.md §3.
 *
 * Lifecycle:
 *   - conv_id undefined → 'idle' (no fetch).
 *   - conv_id set → 'loading' → 'ok' | 'error' | 'not_configured'.
 *   - `refetch()` re-issues the request *without* resetting status to
 *     'loading' — calling it on terminator must not blank history mid-render.
 *   - conv_id change → synchronous reset during render (the
 *     "adjust state on prop change" pattern that PR #19.1 promoted to
 *     load-bearing across all conv_id-keyed hooks; see
 *     docs/INVARIANTS.md I-2).
 *   - Unmount → AbortController on the in-flight request; cancelled flag
 *     prevents late-resolve setState on an unmounted consumer.
 *
 * Lifecycle tests: apps/web/tests/dom/use-transcript.test.tsx.
 */
import type { ChatMessage } from '@clod-ui/contracts';
import type { TranscriptLine as ContractsTranscriptLine } from '@clod-ui/contracts';
import { ClientError } from '@clod-ui/contracts/client';
import { normalizeTranscriptLines, type SkippedLine } from '@clod-ui/transcripts';
import type { TranscriptLine as TranscriptsTranscriptLine } from '@clod-ui/transcripts';
import * as React from 'react';

import { useEngine } from './engine-context.tsx';

export interface TranscriptMeta {
  /** Number of raw JSONL lines received from the route. */
  line_count: number;
  /** Lines the normalizer dropped (parse errors, system events, no-content). */
  skipped: SkippedLine[];
}

export type TranscriptState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; messages: ChatMessage[]; meta: TranscriptMeta }
  | { status: 'error'; error: ClientError }
  | { status: 'not_configured' };

export interface UseTranscriptReturn {
  state: TranscriptState;
  /**
   * Re-issue the request without flipping status to 'loading'. Safe to call
   * from a useEffect on turn-terminator transitions: history stays visible
   * while the new request is in flight, then atomically updates on resolve.
   */
  refetch: () => void;
}

export interface UseTranscriptOptions {
  conv_id: string | undefined;
  /**
   * When `false`, the hook stays at status='idle' and never opens a request.
   * Mirrors `useSubscribe`/`useTurnStream`'s opt-in pattern so consumers can
   * mount the hook unconditionally (preserving hook-tree stability) while
   * deferring network activity until selection lands. Defaults to `true`.
   */
  enabled?: boolean;
}

export function useTranscript(opts: UseTranscriptOptions): UseTranscriptReturn {
  const { client } = useEngine();
  const { conv_id, enabled = true } = opts;
  const effectiveConvId = enabled ? conv_id : undefined;

  const [state, setState] = React.useState<TranscriptState>(() =>
    effectiveConvId ? { status: 'loading' } : { status: 'idle' },
  );

  // Tracker for the synchronous reset on conv_id change (the "adjust state on
  // prop change" pattern, INVARIANTS I-2). Reset both `state` (back to
  // 'loading' or 'idle' depending on the new conv_id) and the cancellation
  // ref so any in-flight request from the previous conv is dropped on resolve.
  const trackedConvIdRef = React.useRef<string | undefined>(effectiveConvId);
  const cancelledRef = React.useRef<boolean>(false);
  if (trackedConvIdRef.current !== effectiveConvId) {
    trackedConvIdRef.current = effectiveConvId;
    cancelledRef.current = true;
    cancelledRef.current = false;
    setState(effectiveConvId ? { status: 'loading' } : { status: 'idle' });
  }

  // Bumping `fetchKey` forces the fetching effect to re-run. Used by refetch().
  const [fetchKey, setFetchKey] = React.useState(0);

  React.useEffect(() => {
    if (!effectiveConvId) return;
    const controller = new AbortController();
    let localCancelled = false;
    cancelledRef.current = false;

    client
      .getTranscript(effectiveConvId, { signal: controller.signal })
      .then((res) => {
        if (localCancelled || cancelledRef.current) return;
        // The contracts `TranscriptLine` and the transcripts source-of-truth
        // `TranscriptLine` are wire-identical (PR #20a + PR #20b breadcrumbs
        // in both files). Cast bridges the nominal-type gap until a future
        // slice exports both from the same module.
        const lines =
          res.lines as readonly ContractsTranscriptLine[] as readonly TranscriptsTranscriptLine[];
        const { messages, skipped } = normalizeTranscriptLines(lines);
        setState({
          status: 'ok',
          messages,
          meta: { line_count: res.lines.length, skipped },
        });
      })
      .catch((err: unknown) => {
        if (localCancelled || cancelledRef.current) return;
        if (err instanceof ClientError && err.kind === 'not_configured') {
          setState({ status: 'not_configured' });
          return;
        }
        // Don't blank a successful 'ok' state on an aborted refetch — those
        // are not errors the user should see.
        if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'))) {
          return;
        }
        setState({ status: 'error', error: err as ClientError });
      });

    return () => {
      localCancelled = true;
      controller.abort();
    };
    // `fetchKey` bumps via refetch(); `client` change re-issues; `conv_id`
    // change is handled by the synchronous reset above which then lets this
    // effect re-run with the new value.
  }, [client, effectiveConvId, fetchKey]);

  const refetch = React.useCallback(() => {
    if (!effectiveConvId) return;
    setFetchKey((k) => k + 1);
  }, [effectiveConvId]);

  return { state, refetch };
}
