import type { ClodError, EventEnvelope } from '@clod-ui/contracts';

/**
 * Streaming-turn projection: the typed view of "what's happening on this
 * conversation's currently-active or most-recently-completed turn".
 *
 * Spec: plans/landed/2026-05-01-clod-ui-pr18b-use-turn-stream-v1.md §3-§4.
 *
 * Discriminated on `status`. `idle` is the pre-stream state; the four other
 * statuses share the same fields so the renderer can read `assistant_text`
 * etc. without status-narrowing first.
 */
export type ToolCall = {
  tool_use_id: string;
  name: string;
  input: unknown;
  status: 'pending' | 'success' | 'error';
  /** Present iff status === 'success'. */
  result?: unknown;
  /** Present iff status === 'error'. */
  error_message?: string;
};

export type ActiveTurn = {
  status: 'streaming' | 'completed' | 'cancelled' | 'errored';
  turn_id: string;
  session_id?: string;
  assistant_text: string;
  assistant_complete: boolean;
  thinking_text: string;
  thinking_complete: boolean;
  tools: ToolCall[];
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Present iff status === 'cancelled'. */
  escalation?: 'sigint' | 'sigterm' | 'sigkill';
  /** Present iff status === 'errored'. */
  error?: ClodError;
};

export type TurnState = { status: 'idle' } | ActiveTurn;

export const INITIAL_TURN_STATE: TurnState = { status: 'idle' };

/**
 * Construct a fresh active turn from a `system.init` envelope.
 *
 * Exported for tests; consumers reach for `turnReducer` instead.
 */
function newActiveTurn(turn_id: string, session_id?: string): ActiveTurn {
  return {
    status: 'streaming',
    turn_id,
    ...(session_id !== undefined ? { session_id } : {}),
    assistant_text: '',
    assistant_complete: false,
    thinking_text: '',
    thinking_complete: false,
    tools: [],
  };
}

/**
 * Pure reducer mapping `(prev: TurnState, env: EventEnvelope) => TurnState`.
 *
 * No closures, no I/O, no shared mutable state. Deterministic; folding
 * across the same envelope sequence always yields the same result.
 *
 * Idempotency under double-application is an engine-side invariant
 * (PR #17 replay-buffer dedups by `?since=<lastEventId>`); the reducer
 * assumes envelopes arrive at most once.
 *
 * Conv-id filtering happens *outside* the reducer (in `useTurnStream`); the
 * reducer applies every envelope it sees. This keeps it usable by non-React
 * consumers (CLI inspector, replay debugger) without forcing a conv-id
 * argument through.
 */
export function turnReducer(prev: TurnState, env: EventEnvelope): TurnState {
  // `replay.start` is a per-connection control envelope; not part of turn state.
  if (env.kind === 'replay.start') return prev;

  switch (env.kind) {
    case 'system.init': {
      const p = env.payload as { turn_id?: unknown; session_id?: unknown };
      if (typeof p?.turn_id !== 'string') return prev;
      return newActiveTurn(p.turn_id, typeof p.session_id === 'string' ? p.session_id : undefined);
    }

    case 'assistant.delta': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as { turn_id?: unknown; text?: unknown };
      if (typeof p?.text !== 'string') return prev;
      if (typeof p.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      return { ...prev, assistant_text: prev.assistant_text + p.text };
    }

    case 'assistant.complete': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as { turn_id?: unknown };
      if (typeof p?.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      return { ...prev, assistant_complete: true };
    }

    case 'thinking.delta': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as { turn_id?: unknown; text?: unknown };
      if (typeof p?.text !== 'string') return prev;
      if (typeof p.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      return { ...prev, thinking_text: prev.thinking_text + p.text };
    }

    case 'thinking.complete': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as { turn_id?: unknown };
      if (typeof p?.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      return { ...prev, thinking_complete: true };
    }

    case 'tool.use': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as {
        turn_id?: unknown;
        tool_use_id?: unknown;
        name?: unknown;
        input?: unknown;
      };
      if (typeof p?.tool_use_id !== 'string' || typeof p?.name !== 'string') return prev;
      if (typeof p.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      // De-dup by tool_use_id: if already present, leave untouched.
      if (prev.tools.some((t) => t.tool_use_id === p.tool_use_id)) return prev;
      const tool: ToolCall = {
        tool_use_id: p.tool_use_id,
        name: p.name,
        input: p.input,
        status: 'pending',
      };
      return { ...prev, tools: [...prev.tools, tool] };
    }

    case 'tool.result': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as { turn_id?: unknown; tool_use_id?: unknown; content?: unknown };
      if (typeof p?.tool_use_id !== 'string') return prev;
      if (typeof p.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      const tools = prev.tools.map((t) =>
        t.tool_use_id === p.tool_use_id
          ? { ...t, status: 'success' as const, result: p.content }
          : t,
      );
      // If the tool_use_id was never seen, the update is a no-op (event arrived
      // out of order or for a tool we don't know about). Don't fabricate.
      return { ...prev, tools };
    }

    case 'tool.error': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as { turn_id?: unknown; tool_use_id?: unknown; message?: unknown };
      if (typeof p?.tool_use_id !== 'string') return prev;
      if (typeof p.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      const tools = prev.tools.map((t) =>
        t.tool_use_id === p.tool_use_id
          ? {
              ...t,
              status: 'error' as const,
              error_message: typeof p.message === 'string' ? p.message : '',
            }
          : t,
      );
      return { ...prev, tools };
    }

    case 'turn.result': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as {
        turn_id?: unknown;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (typeof p?.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      return {
        ...prev,
        status: 'completed',
        ...(p?.usage !== undefined ? { usage: p.usage } : {}),
      };
    }

    case 'turn.cancelled': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as { turn_id?: unknown; escalation?: unknown };
      if (typeof p?.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      const escalation =
        p?.escalation === 'sigint' || p?.escalation === 'sigterm' || p?.escalation === 'sigkill'
          ? p.escalation
          : undefined;
      return {
        ...prev,
        status: 'cancelled',
        ...(escalation !== undefined ? { escalation } : {}),
      };
    }

    case 'turn.error': {
      if (prev.status === 'idle') return prev;
      const p = env.payload as { turn_id?: unknown; error?: ClodError };
      if (typeof p?.turn_id === 'string' && p.turn_id !== prev.turn_id) return prev;
      return {
        ...prev,
        status: 'errored',
        ...(p?.error !== undefined ? { error: p.error } : {}),
      };
    }

    // Unknown kind: pass through unchanged. Future engine versions may emit
    // kinds the reducer doesn't know about; the renderer must not crash.
    default:
      return prev;
  }
}
