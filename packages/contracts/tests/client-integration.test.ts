/**
 * Integration test for `@clod-ui/contracts/client` against a real engine.
 *
 * Boots `createApp` + `Bun.serve` on port 0, constructs `LocalHttpTransport`
 * + `createClient`, and exercises HTTP + WS end-to-end. Companion to the
 * unit tests in `client.test.ts` (which run against a `FakeTransport`).
 *
 * Spec: plans/landed/2026-04-28-clod-ui-pr13-typed-client-v1.md §6.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import { SettingsStore } from '@clod-ui/settings';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb } from '../../../apps/engine/src/db/index.ts';
import { createApp } from '../../../apps/engine/src/index.ts';
import { FallbackTitler } from '../../../apps/engine/src/titler.ts';
import { ClientError, LocalHttpTransport, createClient, type Client } from '../src/client/index.ts';
import type { EventEnvelope } from '../src/event-envelope.ts';

interface RunningEngine {
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  db: ReturnType<typeof openDb>;
}

async function bootEngine(opts: {
  appDataDir: string;
  settingsPath?: string;
  sessionId?: string;
}): Promise<RunningEngine> {
  const built = script()
    .init(opts.sessionId ?? 'sess-client-int')
    .assistantText('hello from the engine')
    .result()
    .end();
  const backend = new ScriptedBackend(built);
  const store = new ManifestStore(opts.appDataDir);
  const db = openDb({ path: join(opts.appDataDir, 'engine.sqlite') });
  const settingsStore = opts.settingsPath
    ? new SettingsStore({ path: opts.settingsPath })
    : undefined;

  const context = createApp({
    backend,
    store,
    db,
    titler: new FallbackTitler(),
    ...(settingsStore ? { settings: { store: settingsStore } } : {}),
  });

  const sockets = new Set<WebSocket>();
  context.setBroadcast((envelope) => {
    const data = JSON.stringify(envelope);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req, srv) => {
      const u = new URL(req.url);
      if (u.pathname === '/ws') {
        const upgraded = srv.upgrade(req);
        if (upgraded) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      return context.app.fetch(req);
    },
    websocket: {
      open: (ws) => {
        sockets.add(ws as unknown as WebSocket);
      },
      close: (ws) => {
        sockets.delete(ws as unknown as WebSocket);
      },
      message: () => undefined,
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { server, baseUrl, db };
}

function makeClient(baseUrl: string): Client {
  const transport = new LocalHttpTransport({ baseUrl });
  return createClient({ transport });
}

describe('createClient — integration against real engine (HTTP)', () => {
  let appDataDir: string;
  let engine: RunningEngine | undefined;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'clod-ui-client-int-'));
    appDataDir = join(root, 'app-data');
    mkdirSync(appDataDir, { recursive: true });
    engine = undefined;
  });

  afterEach(() => {
    engine?.server.stop(true);
    engine?.db.close();
    rmSync(appDataDir, { recursive: true, force: true });
  });

  test('getHealth returns ok and validates HealthResponse', async () => {
    engine = await bootEngine({ appDataDir });
    const client = makeClient(engine.baseUrl);
    const health = await client.getHealth();
    expect(health.cli).toBe('ok'); // ScriptedBackend reports ok
    expect(health.engine_version).toBeDefined();
    expect(health.started_at).toBeGreaterThan(0);
  });

  test('getSettings throws ClientError { kind: not_configured } when settings option absent', async () => {
    engine = await bootEngine({ appDataDir });
    const client = makeClient(engine.baseUrl);
    let caught: unknown;
    try {
      await client.getSettings();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).kind).toBe('not_configured');
    expect((caught as ClientError).message).toBe('settings not configured');
  });

  test('settings round-trip: PUT then GET reflects on-disk state', async () => {
    const settingsPath = join(appDataDir, 'settings.json');
    engine = await bootEngine({ appDataDir, settingsPath });
    const client = makeClient(engine.baseUrl);

    const written = await client.putSettings({
      theme: 'dark',
      model: 'sonnet',
      unknown: { customKey: 'preserved' },
    });
    expect(written.theme).toBe('dark');
    expect(written.unknown).toEqual({ customKey: 'preserved' });

    const read = await client.getSettings();
    expect(read.theme).toBe('dark');
    expect(read.model).toBe('sonnet');
    expect(read.unknown).toEqual({ customKey: 'preserved' });
  });

  test('patchSettings preserves unknown keys', async () => {
    const settingsPath = join(appDataDir, 'settings.json');
    engine = await bootEngine({ appDataDir, settingsPath });
    const client = makeClient(engine.baseUrl);

    await client.putSettings({ theme: 'dark', unknown: { keepMe: true } });
    const merged = await client.patchSettings({ theme: 'light' });
    expect(merged.theme).toBe('light');
    expect(merged.unknown).toEqual({ keepMe: true });
  });

  test('getConversations returns wrapped response (empty when none provisioned)', async () => {
    engine = await bootEngine({ appDataDir });
    const client = makeClient(engine.baseUrl);
    const res = await client.getConversations();
    expect(res.conversations).toEqual([]);
  });

  test('submitTurn drives the engine; getConversations reflects the new entry', async () => {
    engine = await bootEngine({ appDataDir });
    const client = makeClient(engine.baseUrl);

    await client.submitTurn({
      conv_id: '11111111-1111-4111-8111-111111111111',
      turn_id: 't-1',
      user_message: 'hi engine',
    });

    // Poll briefly for the turn pipeline to land its events on the manifest.
    await waitFor(async () => {
      const list = await client.getConversations();
      return list.conversations.some((c) => c.conv_id === '11111111-1111-4111-8111-111111111111');
    });
    const list = await client.getConversations();
    const entry = list.conversations.find(
      (c) => c.conv_id === '11111111-1111-4111-8111-111111111111',
    );
    expect(entry).toBeDefined();
  });
});

describe('createClient — integration against real engine (WS)', () => {
  let appDataDir: string;
  let engine: RunningEngine | undefined;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'clod-ui-client-int-ws-'));
    appDataDir = join(root, 'app-data');
    mkdirSync(appDataDir, { recursive: true });
    engine = undefined;
  });

  afterEach(() => {
    engine?.server.stop(true);
    engine?.db.close();
    rmSync(appDataDir, { recursive: true, force: true });
  });

  test('subscribe receives validated envelopes for a completed turn', async () => {
    engine = await bootEngine({ appDataDir, sessionId: 'sess-ws-int' });
    const client = makeClient(engine.baseUrl);

    const received: EventEnvelope[] = [];
    let opened = false;
    const sub = client.subscribe({
      onOpen: () => {
        opened = true;
      },
      onEnvelope: (env) => received.push(env),
    });

    // Wait for the WS to open before submitting.
    await waitFor(() => opened);

    await client.submitTurn({
      conv_id: '22222222-2222-4222-8222-222222222222',
      turn_id: 't-1',
      user_message: 'over the wire',
    });

    // Wait for the terminal turn.result envelope.
    await waitFor(() => received.some((e) => e.kind === 'turn.result'));
    const result = received.find((e) => e.kind === 'turn.result');
    expect(result).toBeDefined();
    expect(result!.conv_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(result!.v).toBe(1);

    sub.close();
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeout?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 2000;
  const intervalMs = opts.intervalMs ?? 10;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}
