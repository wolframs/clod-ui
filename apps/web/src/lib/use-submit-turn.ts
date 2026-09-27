/**
 * `useSubmitTurn` — typed React hook over `client.submitTurn`.
 *
 * Owns the submission state machine: idle → submitting → idle (on
 * resolve) | error (on reject). Generates a fresh `turn_id` UUID per
 * `submit()` call and exposes the most-recently-submitted `turn_id`
 * so callers (typically the Composer) can wire Cancel before
 * `useTurnStream` has observed `system.init`.
 *
 * Spec: plans/landed/2026-05-02-clod-ui-pr19-composer-v1.md §4-5.
 */

import type { ClientError } from '@clod-ui/contracts/client';
import type { SubmitTurnInput } from '@clod-ui/contracts/client';
import * as React from 'react';

import { useEngine } from './engine-context.tsx';

export type SubmitTurnState =
  | { status: 'idle' }
  | { status: 'submitting'; turn_id: string }
  | { status: 'error'; error: ClientError | Error; attempted_text: string };

export interface UseSubmitTurnOptions {
  conv_id: string | undefined;
  /**
   * Optional override for `turn_id` generation. Tests inject a deterministic
   * generator; production uses `crypto.randomUUID()`.
   */
  generateTurnId?: () => string;
}

export interface SubmitArgs {
  user_message: string;
  /**
   * Optional fields forwarded verbatim to `client.submitTurn`. Anything
   * not provided defers to the backend default.
   */
  model?: string;
  cwd?: string;
  resume_session_id?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  system_prompt?: SubmitTurnInput['system_prompt'];
}

export interface UseSubmitTurnReturn {
  state: SubmitTurnState;
  /** Most recently submitted `turn_id`, or `undefined` if no submit yet. */
  lastTurnId: string | undefined;
  /**
   * Submit a turn. Returns the generated `turn_id` so callers can correlate
   * with subsequent envelopes if needed. If `conv_id` is undefined or the
   * trimmed `user_message` is empty, returns `undefined` and does NOT
   * call the network.
   */
  submit(args: SubmitArgs): Promise<string | undefined>;
  /** Reset state to `idle` (e.g. after the user dismisses an error). */
  reset(): void;
}

const defaultGenerateTurnId = (): string => {
  // crypto.randomUUID is available in all evergreen browsers + Bun + Node 19+.
  // Fallback for older environments uses a Math.random-based stub; tests
  // override via opts.generateTurnId so this branch is rarely exercised.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback (low entropy; do not rely on for security)
  return '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padStart(12, '0');
};

export function useSubmitTurn(opts: UseSubmitTurnOptions): UseSubmitTurnReturn {
  const { client } = useEngine();
  const { conv_id } = opts;
  const generateTurnId = opts.generateTurnId ?? defaultGenerateTurnId;

  const [state, setState] = React.useState<SubmitTurnState>({ status: 'idle' });
  const [lastTurnId, setLastTurnId] = React.useState<string | undefined>(undefined);

  // Track the latest in-flight turn_id so a stale resolve from a previous
  // submit cannot overwrite the state of a newer one. The closed-over
  // `turn_id` in `submit` is the source of truth for ordering.
  const inflightRef = React.useRef<string | undefined>(undefined);

  // Adjust state on prop change (matches the pattern used by useTurnStream):
  // when conv_id flips, reset the submission state machine *during render*
  // so the consumer never observes a frame of the previous conversation's
  // state under the new conv_id (phantom Cancel button, inherited error,
  // stuck-disabled Send). Clearing inflightRef silently drops any in-flight
  // resolve from the previous conv (the `inflightRef === turn_id` guard in
  // submit already handles this — clearing the ref makes both branches no-op).
  const trackedConvIdRef = React.useRef<string | undefined>(conv_id);
  if (trackedConvIdRef.current !== conv_id) {
    trackedConvIdRef.current = conv_id;
    inflightRef.current = undefined;
    if (state.status !== 'idle') setState({ status: 'idle' });
    if (lastTurnId !== undefined) setLastTurnId(undefined);
  }

  const submit = React.useCallback(
    async (args: SubmitArgs): Promise<string | undefined> => {
      if (!conv_id) return undefined;
      const trimmed = args.user_message.trim();
      if (trimmed.length === 0) return undefined;

      const turn_id = generateTurnId();
      inflightRef.current = turn_id;
      setLastTurnId(turn_id);
      setState({ status: 'submitting', turn_id });

      const input: SubmitTurnInput = {
        conv_id,
        turn_id,
        user_message: args.user_message,
        ...(args.model !== undefined && { model: args.model }),
        ...(args.cwd !== undefined && { cwd: args.cwd }),
        ...(args.resume_session_id !== undefined && {
          resume_session_id: args.resume_session_id,
        }),
        ...(args.allowed_tools !== undefined && { allowed_tools: args.allowed_tools }),
        ...(args.disallowed_tools !== undefined && {
          disallowed_tools: args.disallowed_tools,
        }),
        ...(args.system_prompt !== undefined && { system_prompt: args.system_prompt }),
      };

      try {
        await client.submitTurn(input);
        // Only flip back to idle if this submit is still the most recent;
        // a newer submit may have already moved state forward.
        if (inflightRef.current === turn_id) {
          setState({ status: 'idle' });
        }
        return turn_id;
      } catch (err) {
        if (inflightRef.current === turn_id) {
          setState({
            status: 'error',
            error: err as ClientError | Error,
            attempted_text: args.user_message,
          });
        }
        return turn_id;
      }
    },
    [client, conv_id, generateTurnId],
  );

  const reset = React.useCallback(() => {
    setState({ status: 'idle' });
  }, []);

  return { state, lastTurnId, submit, reset };
}
