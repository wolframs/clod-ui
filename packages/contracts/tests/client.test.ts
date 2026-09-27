import { describe, expect, test } from 'bun:test';

import {
  ClientError,
  createClient,
  type Subscription,
  type Transport,
} from '../src/client/index.ts';
import type { EventEnvelope } from '../src/event-envelope.ts';

/** In-memory transport recording every request and replaying scripted responses. */
class FakeTransport implements Transport {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  responder:
    | ((req: { method: string; path: string; body?: unknown }) => {
        ok: boolean;
        status: number;
        body: unknown;
      })
    | null = null;
  subscribed: Array<{
    onEnvelope: (env: EventEnvelope) => void;
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason: string }) => void;
    onError?: (err: Error) => void;
    reconnect?: false | { backoffMs?: number[]; maxAttempts?: number };
  }> = [];
  closeCount = 0;

  async request(opts: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const call: { method: string; path: string; body?: unknown } = {
      method: opts.method,
      path: opts.path,
    };
    if (opts.body !== undefined) call.body = opts.body;
    this.calls.push(call);
    if (!this.responder) throw new Error('FakeTransport: no responder set');
    return this.responder(opts);
  }

  subscribe(opts: {
    path: string;
    onEnvelope: (env: EventEnvelope) => void;
    onOpen?: () => void;
    onClose?: (ev: { code: number; reason: string }) => void;
    onError?: (err: Error) => void;
    reconnect?: false | { backoffMs?: number[]; maxAttempts?: number };
  }): Subscription {
    const handlers: {
      onEnvelope: (env: EventEnvelope) => void;
      onOpen?: () => void;
      onClose?: (ev: { code: number; reason: string }) => void;
      onError?: (err: Error) => void;
      reconnect?: false | { backoffMs?: number[]; maxAttempts?: number };
    } = { onEnvelope: opts.onEnvelope };
    if (opts.onOpen) handlers.onOpen = opts.onOpen;
    if (opts.onClose) handlers.onClose = opts.onClose;
    if (opts.onError) handlers.onError = opts.onError;
    if (opts.reconnect !== undefined) handlers.reconnect = opts.reconnect;
    this.subscribed.push(handlers);
    return {
      close: () => {
        this.closeCount++;
      },
    };
  }
}

describe('createClient — getHealth', () => {
  test('happy path returns parsed HealthResponse', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: true,
      status: 200,
      body: { cli: 'ok', version: '2.1.0', engine_version: '0.0.0', started_at: 100 },
    });
    const client = createClient({ transport });
    const res = await client.getHealth();
    expect(res.cli).toBe('ok');
    expect(res.engine_version).toBe('0.0.0');
    expect(transport.calls[0]).toEqual({ method: 'GET', path: '/health' });
  });

  test('schema failure throws ClientError { kind: schema, issues }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({ ok: true, status: 200, body: { cli: 'exploded' } });
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.getHealth();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClientError);
    const err = caught as ClientError;
    expect(err.kind).toBe('schema');
    expect(err.issues).toBeDefined();
    expect(err.issues!.length).toBeGreaterThan(0);
    expect(err.path).toBe('/health');
  });

  test('http 500 throws ClientError { kind: http, status }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({ ok: false, status: 500, body: undefined });
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.getHealth();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClientError);
    const err = caught as ClientError;
    expect(err.kind).toBe('http');
    expect(err.status).toBe(500);
  });

  test('transport error propagates as ClientError { kind: transport }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => {
      throw new ClientError({
        kind: 'transport',
        message: 'fetch failed',
        cause: new Error('ECONNREFUSED'),
      });
    };
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.getHealth();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).kind).toBe('transport');
  });
});

describe('createClient — settings', () => {
  test('getSettings happy path', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: true,
      status: 200,
      body: { theme: 'dark', model: 'sonnet' },
    });
    const client = createClient({ transport });
    const res = await client.getSettings();
    expect(res.theme).toBe('dark');
    expect(res.model).toBe('sonnet');
  });

  test('getSettings 404 not configured → ClientError { kind: not_configured }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: false,
      status: 404,
      body: { error: 'settings not configured' },
    });
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.getSettings();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClientError);
    const err = caught as ClientError;
    expect(err.kind).toBe('not_configured');
    expect(err.status).toBe(404);
    expect(err.message).toBe('settings not configured');
  });

  test('getSettings 404 with non-not-configured body → ClientError { kind: http }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({ ok: false, status: 404, body: { error: 'something else' } });
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.getSettings();
    } catch (err) {
      caught = err;
    }
    expect((caught as ClientError).kind).toBe('http');
    expect((caught as ClientError).status).toBe(404);
  });

  test('putSettings sends body and returns parsed response', async () => {
    const transport = new FakeTransport();
    transport.responder = (req) => ({ ok: true, status: 200, body: req.body });
    const client = createClient({ transport });
    const res = await client.putSettings({ theme: 'light', model: 'haiku' });
    expect(res.theme).toBe('light');
    expect(res.model).toBe('haiku');
    expect(transport.calls[0]).toEqual({
      method: 'PUT',
      path: '/settings',
      body: { theme: 'light', model: 'haiku' },
    });
  });

  test('patchSettings sends partial body and returns full settings', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: true,
      status: 200,
      body: { theme: 'system', model: 'sonnet' },
    });
    const client = createClient({ transport });
    const res = await client.patchSettings({ theme: 'system' });
    expect(res.theme).toBe('system');
    expect(res.model).toBe('sonnet');
    expect(transport.calls[0]).toEqual({
      method: 'PATCH',
      path: '/settings',
      body: { theme: 'system' },
    });
  });

  test('putSettings 400 schema failure surfaces as ClientError { kind: http, status: 400 }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: false,
      status: 400,
      body: { error: { kind: 'settings_invalid', detail: 'bad' } },
    });
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.putSettings({ theme: 'dark' });
    } catch (err) {
      caught = err;
    }
    expect((caught as ClientError).kind).toBe('http');
    expect((caught as ClientError).status).toBe(400);
  });
});

describe('createClient — conversations', () => {
  test('getConversations happy path', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: true,
      status: 200,
      body: {
        conversations: [
          { conv_id: 'a', created_at: 1, updated_at: 2, title: 'Hello' },
          { conv_id: 'b', created_at: 3, updated_at: 3 },
        ],
      },
    });
    const client = createClient({ transport });
    const res = await client.getConversations();
    expect(res.conversations).toHaveLength(2);
    expect(res.conversations[0]!.title).toBe('Hello');
    expect(res.conversations[1]!.title).toBeUndefined();
  });

  test('getConversations 404 not configured → ClientError { kind: not_configured }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: false,
      status: 404,
      body: { error: 'conversations not configured' },
    });
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.getConversations();
    } catch (err) {
      caught = err;
    }
    expect((caught as ClientError).kind).toBe('not_configured');
  });

  test('getTranscript happy path returns parsed TranscriptResponse', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: true,
      status: 200,
      body: {
        lines: [
          {
            line_number: 0,
            byte_offset: 0,
            raw: { type: 'user', message: { role: 'user', content: 'hi' } },
          },
          {
            line_number: 1,
            byte_offset: 64,
            raw: null,
            parse_error: { message: 'Unexpected token', raw_text: '{not json' },
          },
        ],
      },
    });
    const client = createClient({ transport });
    const res = await client.getTranscript('CONV-1');
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0]!.line_number).toBe(0);
    expect(res.lines[1]!.parse_error?.message).toBe('Unexpected token');
    expect(transport.calls[0]).toEqual({
      method: 'GET',
      path: '/conversations/CONV-1/transcript',
    });
  });

  test('getTranscript URL-encodes conv_id', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({ ok: true, status: 200, body: { lines: [] } });
    const client = createClient({ transport });
    await client.getTranscript('CONV/with spaces');
    expect(transport.calls[0]!.path).toBe('/conversations/CONV%2Fwith%20spaces/transcript');
  });

  test('getTranscript 404 not configured → ClientError { kind: not_configured }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: false,
      status: 404,
      body: { error: 'transcripts not configured' },
    });
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.getTranscript('any');
    } catch (err) {
      caught = err;
    }
    expect((caught as ClientError).kind).toBe('not_configured');
  });

  test('getTranscript 404 unknown conversation → ClientError { kind: http, status: 404 }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({
      ok: false,
      status: 404,
      body: { error: 'unknown conversation' },
    });
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.getTranscript('does-not-exist');
    } catch (err) {
      caught = err;
    }
    const err = caught as ClientError;
    expect(err.kind).toBe('http');
    expect(err.status).toBe(404);
  });
});

describe('createClient — turns', () => {
  test('submitTurn posts to the right path with the right body', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({ ok: true, status: 202, body: undefined });
    const client = createClient({ transport });
    await client.submitTurn({
      conv_id: 'CONV-1',
      turn_id: 'T1',
      user_message: 'hi',
      model: 'haiku',
    });
    expect(transport.calls[0]).toEqual({
      method: 'POST',
      path: '/conversations/CONV-1/turns',
      body: { turn_id: 'T1', user_message: 'hi', model: 'haiku' },
    });
  });

  test('submitTurn URL-encodes conv_id', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({ ok: true, status: 202, body: undefined });
    const client = createClient({ transport });
    await client.submitTurn({ conv_id: 'a/b c', turn_id: 'T', user_message: 'x' });
    expect(transport.calls[0]!.path).toBe('/conversations/a%2Fb%20c/turns');
  });

  test('cancelTurn posts conv_id + turn_id', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({ ok: true, status: 200, body: undefined });
    const client = createClient({ transport });
    await client.cancelTurn({ conv_id: 'CONV-1', turn_id: 'T1' });
    expect(transport.calls[0]).toEqual({
      method: 'POST',
      path: '/conversations/CONV-1/cancel',
      body: { turn_id: 'T1' },
    });
  });

  test('submitTurn 4xx surfaces as ClientError { kind: http }', async () => {
    const transport = new FakeTransport();
    transport.responder = () => ({ ok: false, status: 400, body: undefined });
    const client = createClient({ transport });
    let caught: unknown;
    try {
      await client.submitTurn({ conv_id: 'C', turn_id: 'T', user_message: 'x' });
    } catch (err) {
      caught = err;
    }
    expect((caught as ClientError).kind).toBe('http');
    expect((caught as ClientError).status).toBe(400);
  });
});

describe('createClient — subscribe', () => {
  test('wires onEnvelope through to the transport handler', () => {
    const transport = new FakeTransport();
    const client = createClient({ transport });
    const received: EventEnvelope[] = [];
    const sub = client.subscribe({ onEnvelope: (env) => received.push(env) });
    expect(transport.subscribed).toHaveLength(1);
    transport.subscribed[0]!.onEnvelope({
      v: 1,
      id: '00000000-0000-4000-8000-000000000001',
      ts: 1,
      kind: 'turn.result',
      payload: {},
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.kind).toBe('turn.result');
    sub.close();
    expect(transport.closeCount).toBe(1);
  });

  test('forwards onOpen / onClose / onError when provided', () => {
    const transport = new FakeTransport();
    const client = createClient({ transport });
    const opens: number[] = [];
    const closes: Array<{ code: number; reason: string }> = [];
    const errors: Error[] = [];
    client.subscribe({
      onEnvelope: () => undefined,
      onOpen: () => opens.push(1),
      onClose: (ev) => closes.push(ev),
      onError: (err) => errors.push(err),
    });
    const handlers = transport.subscribed[0]!;
    handlers.onOpen?.();
    handlers.onClose?.({ code: 1000, reason: 'ok' });
    handlers.onError?.(new Error('boom'));
    expect(opens).toEqual([1]);
    expect(closes).toEqual([{ code: 1000, reason: 'ok' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('boom');
  });

  test('handlers without onEnvelope still produce a working subscription', () => {
    const transport = new FakeTransport();
    const client = createClient({ transport });
    const sub = client.subscribe({});
    expect(transport.subscribed).toHaveLength(1);
    // The default onEnvelope is a no-op, so this must not throw.
    transport.subscribed[0]!.onEnvelope({
      v: 1,
      id: '00000000-0000-4000-8000-000000000002',
      ts: 1,
      kind: 'noop',
      payload: null,
    });
    sub.close();
  });
});

describe('createClient — subscribe (typed dispatch)', () => {
  test('per-kind handler fires only for matching kind', () => {
    const transport = new FakeTransport();
    const client = createClient({ transport });
    const titled: EventEnvelope[] = [];
    const result: EventEnvelope[] = [];
    client.subscribe({
      on: {
        'conversation.titled': (env) => titled.push(env),
        'turn.result': (env) => result.push(env),
      },
    });
    const handlers = transport.subscribed[0]!;
    handlers.onEnvelope({
      v: 1,
      id: '00000000-0000-4000-8000-000000000010',
      ts: 1,
      kind: 'conversation.titled',
      payload: { title: 'x' },
    });
    handlers.onEnvelope({
      v: 1,
      id: '00000000-0000-4000-8000-000000000011',
      ts: 2,
      kind: 'turn.result',
      payload: {},
    });
    handlers.onEnvelope({
      v: 1,
      id: '00000000-0000-4000-8000-000000000012',
      ts: 3,
      kind: 'assistant.delta',
      payload: { text: 'x' },
    });
    expect(titled).toHaveLength(1);
    expect(titled[0]!.kind).toBe('conversation.titled');
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('turn.result');
  });

  test('catch-all onEnvelope fires alongside per-kind handlers', () => {
    const transport = new FakeTransport();
    const client = createClient({ transport });
    const all: string[] = [];
    const titled: string[] = [];
    client.subscribe({
      onEnvelope: (env) => all.push(env.kind),
      on: { 'conversation.titled': (env) => titled.push(env.kind) },
    });
    const handlers = transport.subscribed[0]!;
    handlers.onEnvelope({
      v: 1,
      id: '00000000-0000-4000-8000-000000000020',
      ts: 1,
      kind: 'conversation.titled',
      payload: {},
    });
    handlers.onEnvelope({
      v: 1,
      id: '00000000-0000-4000-8000-000000000021',
      ts: 2,
      kind: 'assistant.delta',
      payload: { text: 'x' },
    });
    expect(all).toEqual(['conversation.titled', 'assistant.delta']);
    expect(titled).toEqual(['conversation.titled']);
  });

  test('unknown kind without matching handler does not throw and still feeds onEnvelope', () => {
    const transport = new FakeTransport();
    const client = createClient({ transport });
    const all: string[] = [];
    client.subscribe({
      onEnvelope: (env) => all.push(env.kind),
      on: { 'conversation.titled': () => undefined },
    });
    const handlers = transport.subscribed[0]!;
    handlers.onEnvelope({
      v: 1,
      id: '00000000-0000-4000-8000-000000000030',
      ts: 1,
      kind: 'something.unmapped',
      payload: {},
    });
    expect(all).toEqual(['something.unmapped']);
  });
});

describe('createClient — subscribe (reconnect option forwarding)', () => {
  test('forwards reconnect: false to the transport', () => {
    const transport = new FakeTransport();
    const client = createClient({ transport });
    client.subscribe({ reconnect: false });
    expect(transport.subscribed[0]!.reconnect).toBe(false);
  });

  test('forwards reconnect config object verbatim', () => {
    const transport = new FakeTransport();
    const client = createClient({ transport });
    client.subscribe({ reconnect: { backoffMs: [10, 20], maxAttempts: 3 } });
    expect(transport.subscribed[0]!.reconnect).toEqual({
      backoffMs: [10, 20],
      maxAttempts: 3,
    });
  });

  test('omits reconnect when not specified (transport default applies)', () => {
    const transport = new FakeTransport();
    const client = createClient({ transport });
    client.subscribe({});
    expect(transport.subscribed[0]!.reconnect).toBeUndefined();
  });
});
