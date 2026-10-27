/**
 * Same-origin guard (PR #38): the pure rule as a table, then the real
 * `startEngineServer` refusing a cross-site POST and WS handshake while
 * same-origin and Origin-less (curl) requests pass.
 */
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, describe, expect, test } from 'bun:test';

import { createApp, startEngineServer } from '../src/index.ts';
import { isOriginAllowed, parseAllowedOrigins } from '../src/origin-guard.ts';

const HOST = 'box.tail1234.ts.net:8791';

describe('isOriginAllowed', () => {
  const cases: Array<[string, Parameters<typeof isOriginAllowed>[0], boolean]> = [
    [
      'GET is always fine',
      { method: 'GET', origin: 'https://evil.example', host: HOST, isWsUpgrade: false },
      true,
    ],
    [
      'POST without Origin (curl)',
      { method: 'POST', origin: null, host: HOST, isWsUpgrade: false },
      true,
    ],
    [
      'POST same origin',
      { method: 'POST', origin: `https://${HOST}`, host: HOST, isWsUpgrade: false },
      true,
    ],
    [
      'POST same origin, case differs',
      {
        method: 'POST',
        origin: `https://BOX.tail1234.ts.net:8791`,
        host: HOST,
        isWsUpgrade: false,
      },
      true,
    ],
    [
      'POST cross site',
      { method: 'POST', origin: 'https://evil.example', host: HOST, isWsUpgrade: false },
      false,
    ],
    [
      'POST same host, other port',
      { method: 'POST', origin: 'https://box.tail1234.ts.net', host: HOST, isWsUpgrade: false },
      false,
    ],
    [
      'POST opaque origin',
      { method: 'POST', origin: 'null', host: HOST, isWsUpgrade: false },
      false,
    ],
    [
      'POST no Host header',
      { method: 'POST', origin: `https://${HOST}`, host: null, isWsUpgrade: false },
      false,
    ],
    [
      'PATCH cross site',
      { method: 'PATCH', origin: 'https://evil.example', host: HOST, isWsUpgrade: false },
      false,
    ],
    [
      'WS cross site',
      { method: 'GET', origin: 'https://evil.example', host: HOST, isWsUpgrade: true },
      false,
    ],
    [
      'WS same origin',
      { method: 'GET', origin: `https://${HOST}`, host: HOST, isWsUpgrade: true },
      true,
    ],
    [
      'allow-listed origin',
      {
        method: 'POST',
        origin: 'http://localhost:5173',
        host: HOST,
        isWsUpgrade: false,
        allowedOrigins: ['http://localhost:5173'],
      },
      true,
    ],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(isOriginAllowed(input)).toBe(expected);
    });
  }

  test('parseAllowedOrigins splits and trims', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(' http://a:1 , ,http://b ')).toEqual(['http://a:1', 'http://b']);
  });
});

describe('startEngineServer applies the guard', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  function boot(): string {
    const backend = new ScriptedBackend(
      script().init('s-guard').assistantText('hi').result().end(),
    );
    const ctx = createApp({ backend });
    const { server } = startEngineServer(ctx, { port: 0 });
    stop = () => server.stop(true);
    return `http://127.0.0.1:${server.port}`;
  }

  const CONV = '44444444-4444-4444-8444-444444444444';

  test('cross-site text/plain POST to turns is refused with 403', async () => {
    const base = boot();
    const res = await fetch(`${base}/conversations/${CONV}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: JSON.stringify({ user_message: 'hi' }),
    });
    expect(res.status).toBe(403);
  });

  test('Origin-less POST still reaches the route', async () => {
    const base = boot();
    const res = await fetch(`${base}/conversations/${CONV}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    // Reached the route: the route's own 400 for bad JSON, not the guard's 403.
    expect(res.status).toBe(400);
  });

  test('cross-site WS handshake is refused', async () => {
    const base = boot();
    const res = await fetch(`${base}/ws`, {
      headers: {
        origin: 'https://evil.example',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(res.status).toBe(403);
  });
});
