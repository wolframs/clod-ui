/**
 * Unit tests for `LocalHttpTransport.subscribe` reconnect-and-resume.
 *
 * Coverage: lastEventId tracking ignoring sentinel, reconnect on non-clean
 * close, ?since= appended to reconnect URL, exponential backoff via
 * injected scheduler, clean close suppresses reconnect, consumer close
 * cancels pending reconnect, reconnect: false opt-out, maxAttempts cap.
 *
 * Implementation strategy: inject a fake WebSocket constructor that lets
 * the test drive the open / message / close lifecycle synchronously.
 *
 * Spec: plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §9.
 */
import { describe, expect, test } from 'bun:test';

import { LocalHttpTransport } from '../src/client/local-http.ts';

interface FakeSocketLog {
  url: string;
  socket: FakeSocket;
}

class FakeSocket {
  readonly listeners: Record<string, Array<(ev: unknown) => void>> = {};
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  constructor(public readonly url: string) {}
  addEventListener(event: string, handler: (ev: unknown) => void): void {
    (this.listeners[event] ??= []).push(handler);
  }
  removeEventListener(): void {
    /* not needed for these tests */
  }
  fire(event: string, payload: unknown): void {
    for (const h of this.listeners[event] ?? []) h(payload);
  }
  close(code?: number, reason?: string): void {
    const call: { code?: number; reason?: string } = {};
    if (code !== undefined) call.code = code;
    if (reason !== undefined) call.reason = reason;
    this.closeCalls.push(call);
  }
}

interface FakeScheduler {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  scheduled: Array<{ cb: () => void; ms: number; cancelled: boolean }>;
  flush(): void;
}

function fakeScheduler(): FakeScheduler {
  const scheduled: FakeScheduler['scheduled'] = [];
  return {
    setTimeout: (cb, ms) => {
      const handle = { cb, ms, cancelled: false };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout: (h) => {
      const handle = h as { cancelled: boolean };
      handle.cancelled = true;
    },
    scheduled,
    flush() {
      const pending = scheduled.filter((s) => !s.cancelled);
      scheduled.length = 0;
      for (const s of pending) s.cb();
    },
  };
}

function setup(): {
  transport: LocalHttpTransport;
  log: FakeSocketLog[];
  scheduler: FakeScheduler;
} {
  const log: FakeSocketLog[] = [];
  const FakeWebSocket = function (this: unknown, url: string): FakeSocket {
    const sock = new FakeSocket(url);
    log.push({ url, socket: sock });
    return sock;
  } as unknown as typeof WebSocket;
  const transport = new LocalHttpTransport({
    baseUrl: 'http://x.test',
    fetch: (() => {
      throw new Error('not used');
    }) as unknown as typeof fetch,
    WebSocket: FakeWebSocket,
  });
  const scheduler = fakeScheduler();
  return { transport, log, scheduler };
}

const ENV_REPLAY_START = '00000000-0000-4000-8000-000000000000';
const ENV_1 = '00000000-0000-4000-8000-000000000001';
const ENV_2 = '00000000-0000-4000-8000-000000000002';
const ENV_3 = '00000000-0000-4000-8000-000000000003';

function envMsg(id: string, kind = 'assistant.delta'): { data: string } {
  return {
    data: JSON.stringify({ v: 1, id, ts: 1, kind, payload: { kind, text: 'x' } }),
  };
}

describe('LocalHttpTransport.subscribe — reconnect-and-resume', () => {
  test('initial connection has no ?since=', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      scheduler,
    });
    expect(log[0]!.url).toBe('ws://x.test/ws');
  });

  test('non-clean close schedules reconnect with ?since=<lastEventId>', () => {
    const { transport, log, scheduler } = setup();
    const opens: number[] = [];
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      onOpen: () => opens.push(1),
      scheduler,
    });
    const sock1 = log[0]!.socket;
    sock1.fire('open', undefined);
    sock1.fire('message', envMsg(ENV_1));
    sock1.fire('message', envMsg(ENV_2));
    // Non-clean close.
    sock1.fire('close', { code: 1006, reason: 'connection lost' });
    expect(scheduler.scheduled).toHaveLength(1);
    expect(scheduler.scheduled[0]!.ms).toBe(250); // first backoff
    scheduler.flush();
    // Second connection URL must carry ?since=<ENV_2>.
    expect(log).toHaveLength(2);
    expect(log[1]!.url).toContain('since=');
    expect(log[1]!.url).toContain(encodeURIComponent(ENV_2));
    log[1]!.socket.fire('open', undefined);
    expect(opens).toEqual([1, 1]); // onOpen fires on every successful connection
  });

  test('replay.start sentinel id does not advance lastEventId', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      scheduler,
    });
    const sock1 = log[0]!.socket;
    sock1.fire('open', undefined);
    sock1.fire('message', envMsg(ENV_REPLAY_START, 'replay.start'));
    // Disconnect immediately. lastEventId should still be null, so no
    // ?since= on reconnect.
    sock1.fire('close', { code: 1006, reason: 'lost' });
    scheduler.flush();
    expect(log[1]!.url).toBe('ws://x.test/ws');
  });

  test('clean close (1000) does NOT trigger reconnect', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      scheduler,
    });
    const sock1 = log[0]!.socket;
    sock1.fire('open', undefined);
    sock1.fire('close', { code: 1000, reason: 'ok' });
    expect(scheduler.scheduled).toHaveLength(0);
    expect(log).toHaveLength(1);
  });

  test('reconnect: false suppresses reconnect on non-clean close', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      reconnect: false,
      scheduler,
    });
    const sock1 = log[0]!.socket;
    sock1.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled).toHaveLength(0);
    expect(log).toHaveLength(1);
  });

  test('exponential backoff: 250 → 500 → 1000 → 2000 → 5000 → 5000 ...', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      scheduler,
    });
    const expected = [250, 500, 1000, 2000, 5000, 5000];
    for (let i = 0; i < expected.length; i++) {
      const sock = log[i]!.socket;
      sock.fire('close', { code: 1006, reason: 'lost' });
      expect(scheduler.scheduled).toHaveLength(1);
      expect(scheduler.scheduled[0]!.ms).toBe(expected[i]!);
      scheduler.flush();
    }
  });

  test('successful open resets backoff to 250', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      scheduler,
    });
    log[0]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled[0]!.ms).toBe(250);
    scheduler.flush();
    log[1]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled[0]!.ms).toBe(500);
    scheduler.flush();
    // Now a successful open should reset the counter.
    log[2]!.socket.fire('open', undefined);
    log[2]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled[0]!.ms).toBe(250);
  });

  test('subscription.close() cancels pending reconnect timer', () => {
    const { transport, log, scheduler } = setup();
    const sub = transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      scheduler,
    });
    log[0]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled).toHaveLength(1);
    expect(scheduler.scheduled[0]!.cancelled).toBe(false);
    sub.close();
    expect(scheduler.scheduled[0]!.cancelled).toBe(true);
    // Even if the timer fires, no new socket should appear.
    scheduler.flush();
    expect(log).toHaveLength(1);
  });

  test('subscription.close() on live socket does NOT trigger reconnect', () => {
    const { transport, log, scheduler } = setup();
    const sub = transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      scheduler,
    });
    log[0]!.socket.fire('open', undefined);
    sub.close();
    // close(1000, ...) was called by the transport.
    expect(log[0]!.socket.closeCalls).toEqual([{ code: 1000, reason: 'consumer closed' }]);
    // Simulate the close event echoing back from the server.
    log[0]!.socket.fire('close', { code: 1000, reason: 'consumer closed' });
    expect(scheduler.scheduled).toHaveLength(0);
    expect(log).toHaveLength(1);
  });

  test('maxAttempts caps the reconnect loop', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      reconnect: { maxAttempts: 2 },
      scheduler,
    });
    log[0]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled).toHaveLength(1);
    scheduler.flush();
    log[1]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled).toHaveLength(1);
    scheduler.flush();
    // Third close hits the cap → no new reconnect.
    log[2]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled).toHaveLength(0);
    expect(log).toHaveLength(3);
  });

  test('custom backoffMs schedule honored', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      reconnect: { backoffMs: [10, 20, 30] },
      scheduler,
    });
    log[0]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled[0]!.ms).toBe(10);
    scheduler.flush();
    log[1]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled[0]!.ms).toBe(20);
    scheduler.flush();
    log[2]!.socket.fire('close', { code: 1006, reason: 'lost' });
    expect(scheduler.scheduled[0]!.ms).toBe(30);
  });

  test('?since= URL works against paths that already carry a query string', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws?ext=1',
      onEnvelope: () => undefined,
      scheduler,
    });
    log[0]!.socket.fire('open', undefined);
    log[0]!.socket.fire('message', envMsg(ENV_3));
    log[0]!.socket.fire('close', { code: 1006, reason: 'lost' });
    scheduler.flush();
    expect(log[1]!.url).toBe('ws://x.test/ws?ext=1&since=' + encodeURIComponent(ENV_3));
  });

  test('envelope id only updates lastEventId when strictly greater', () => {
    const { transport, log, scheduler } = setup();
    transport.subscribe({
      path: '/ws',
      onEnvelope: () => undefined,
      scheduler,
    });
    const sock1 = log[0]!.socket;
    sock1.fire('open', undefined);
    sock1.fire('message', envMsg(ENV_2));
    // Now an out-of-order id arrives (smaller). lastEventId must not
    // regress.
    sock1.fire('message', envMsg(ENV_1));
    sock1.fire('close', { code: 1006, reason: 'lost' });
    scheduler.flush();
    expect(log[1]!.url).toContain(encodeURIComponent(ENV_2));
    expect(log[1]!.url).not.toContain(encodeURIComponent(ENV_1));
  });
});
