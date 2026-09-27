/**
 * `useTranscript` — full async lifecycle tests.
 *
 * Mirrors `use-conversations.test.tsx`; adds the conv_id reset semantics that
 * PR #19.1 promoted to load-bearing across all conv_id-keyed hooks
 * (docs/INVARIANTS.md I-2). Also covers the `refetch()` "no flash to loading"
 * contract and the `enabled: false` opt-out.
 *
 * Spec: plans/2026-05-06-clod-ui-pr20b-transcript-history-v1.md §3.
 */
import type { TranscriptResponse } from '@clod-ui/contracts';
import { ClientError, type Client } from '@clod-ui/contracts/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useTranscript } from '../../src/lib/use-transcript.ts';

function makeFakeClient(overrides: Partial<Client>): Client {
  return overrides as Client;
}

function makeWrapper(client: Client) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client}>{children}</EngineProvider>;
  };
}

const userMessageLine = (text: string, ts = '2026-05-06T00:00:00Z') => ({
  line_number: 0,
  byte_offset: 0,
  raw: {
    type: 'user',
    uuid: 'u-' + text,
    timestamp: ts,
    sessionId: 'sess-A',
    message: { role: 'user', content: [{ type: 'text', text }] },
  },
});

describe('useTranscript — async lifecycle', () => {
  test('starts at idle when conv_id is undefined', () => {
    const getTranscript = vi.fn();
    const client = makeFakeClient({ getTranscript });
    const { result } = renderHook(() => useTranscript({ conv_id: undefined }), {
      wrapper: makeWrapper(client),
    });
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(getTranscript).not.toHaveBeenCalled();
  });

  test('starts at loading when conv_id is set, then resolves to ok with normalized messages', async () => {
    const response: TranscriptResponse = { lines: [userMessageLine('hello')] };
    const client = makeFakeClient({
      getTranscript: vi.fn().mockResolvedValue(response),
    });
    const { result } = renderHook(() => useTranscript({ conv_id: 'A' }), {
      wrapper: makeWrapper(client),
    });

    expect(result.current.state).toEqual({ status: 'loading' });

    await waitFor(() => {
      expect(result.current.state.status).toBe('ok');
    });
    if (result.current.state.status !== 'ok') throw new Error('unreachable');
    expect(result.current.state.messages).toHaveLength(1);
    expect(result.current.state.messages[0].role).toBe('user');
    expect(result.current.state.meta.line_count).toBe(1);
  });

  test('resolves to not_configured when ClientError.kind === "not_configured"', async () => {
    const err = new ClientError({
      kind: 'not_configured',
      message: 'transcripts not configured',
      status: 404,
      path: '/conversations/A/transcript',
    });
    const client = makeFakeClient({
      getTranscript: vi.fn().mockRejectedValue(err),
    });
    const { result } = renderHook(() => useTranscript({ conv_id: 'A' }), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => {
      expect(result.current.state.status).toBe('not_configured');
    });
    expect(result.current.state).toEqual({ status: 'not_configured' });
  });

  test('resolves to error on a generic ClientError', async () => {
    const err = new ClientError({
      kind: 'http',
      message: 'boom',
      status: 500,
      path: '/conversations/A/transcript',
    });
    const client = makeFakeClient({
      getTranscript: vi.fn().mockRejectedValue(err),
    });
    const { result } = renderHook(() => useTranscript({ conv_id: 'A' }), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
    });
    if (result.current.state.status !== 'error') throw new Error('unreachable');
    expect(result.current.state.error).toBe(err);
  });

  test('refetch() does NOT flash status to loading; updates atomically on resolve', async () => {
    let resolver: (value: TranscriptResponse) => void = () => undefined;
    const getTranscript = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve({ lines: [userMessageLine('first')] }))
      .mockImplementationOnce(
        () =>
          new Promise<TranscriptResponse>((res) => {
            resolver = res;
          }),
      );
    const client = makeFakeClient({ getTranscript });
    const { result } = renderHook(() => useTranscript({ conv_id: 'A' }), {
      wrapper: makeWrapper(client),
    });

    // First fetch resolves → status: 'ok'
    await waitFor(() => {
      expect(result.current.state.status).toBe('ok');
    });
    if (result.current.state.status !== 'ok') throw new Error('unreachable');
    const firstSnapshot = result.current.state;

    // Trigger refetch; second fetch is in-flight (resolver not called yet).
    act(() => {
      result.current.refetch();
    });

    // Critical contract: status stays 'ok' (no flash to 'loading').
    expect(result.current.state.status).toBe('ok');
    // Same identity for the snapshot until resolve.
    expect(result.current.state).toBe(firstSnapshot);

    // Resolve the second fetch with new content.
    act(() => {
      resolver({ lines: [userMessageLine('first'), userMessageLine('second')] });
    });
    await waitFor(() => {
      if (result.current.state.status !== 'ok') throw new Error('unreachable');
      expect(result.current.state.messages).toHaveLength(2);
    });
  });

  test('conv_id change synchronously resets state to loading (no stale flash)', async () => {
    const responseA: TranscriptResponse = { lines: [userMessageLine('A-msg')] };
    const responseB: TranscriptResponse = { lines: [userMessageLine('B-msg')] };
    const getTranscript = vi
      .fn()
      .mockImplementation((id: string) => Promise.resolve(id === 'A' ? responseA : responseB));
    const client = makeFakeClient({ getTranscript });

    const { result, rerender } = renderHook(({ id }) => useTranscript({ conv_id: id }), {
      wrapper: makeWrapper(client),
      initialProps: { id: 'A' },
    });

    await waitFor(() => {
      if (result.current.state.status !== 'ok') throw new Error('unreachable');
      expect(result.current.state.messages[0].content).toMatchObject([{ text: 'A-msg' }]);
    });

    // Switch conv_id; the synchronous reset must surface 'loading'
    // immediately, without the previous conv's messages flashing through.
    rerender({ id: 'B' });
    expect(result.current.state.status).toBe('loading');

    await waitFor(() => {
      if (result.current.state.status !== 'ok') throw new Error('unreachable');
      expect(result.current.state.messages[0].content).toMatchObject([{ text: 'B-msg' }]);
    });
  });

  test('conv_id transitions defined → undefined → idle', async () => {
    const client = makeFakeClient({
      getTranscript: vi.fn().mockResolvedValue({ lines: [userMessageLine('hi')] }),
    });
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useTranscript({ conv_id: id }),
      {
        wrapper: makeWrapper(client),
        initialProps: { id: 'A' as string | undefined },
      },
    );
    await waitFor(() => {
      expect(result.current.state.status).toBe('ok');
    });
    rerender({ id: undefined });
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  test('enabled: false short-circuits to idle and never opens a request', () => {
    const getTranscript = vi.fn();
    const client = makeFakeClient({ getTranscript });
    const { result } = renderHook(() => useTranscript({ conv_id: 'A', enabled: false }), {
      wrapper: makeWrapper(client),
    });
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(getTranscript).not.toHaveBeenCalled();
  });

  test('aborts the in-flight request on unmount', async () => {
    let capturedSignal: AbortSignal | undefined;
    const blocked = new Promise<never>(() => undefined);
    const getTranscript = vi
      .fn()
      .mockImplementation((_id: string, opts?: { signal?: AbortSignal }) => {
        capturedSignal = opts?.signal;
        return blocked;
      });
    const client = makeFakeClient({ getTranscript });

    const { unmount } = renderHook(() => useTranscript({ conv_id: 'A' }), {
      wrapper: makeWrapper(client),
    });

    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});
