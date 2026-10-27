#!/usr/bin/env bun
/**
 * Deep-tier E2E server (PR #36, goal S11).
 *
 * Boots the REAL engine (`createApp` + `startEngineServer` — the same
 * WS plumbing production uses) against a hermetic ChaosBackend over a
 * ScriptedBackend: every turn replays init → 4 slow assistant deltas →
 * result, slow enough for the cancel scenario to land mid-stream, and
 * ChaosBackend turns a cancel into a proper `turn.cancelled`.
 *
 * Serves the BUILT SPA from apps/web/dist (build it first — ci.ts deep
 * does). Temp app-data dir per run. One test-only route:
 * `POST /_test/drop-sockets` force-closes every live WS (the
 * reconnect-banner scenario's trigger). Never part of the engine proper.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import { ChaosBackend } from '@clod-ui/test-kit';
import { ScriptedBackend, script } from '@clod-ui/test-kit';

import { openDb } from '../../apps/engine/src/db/index.ts';
import { createApp, startEngineServer } from '../../apps/engine/src/index.ts';

export const DEEP_PORT = 4609;

const appDataDir = mkdtempSync(join(tmpdir(), 'clod-ui-deep-'));
const store = new ManifestStore(appDataDir);
const db = openDb({ path: join(appDataDir, 'engine.sqlite') });

const built = script()
  .init('deep-session')
  .assistantText('Streaming ')
  .assistantText('response ')
  .assistantText('from ')
  .assistantText('the deep tier.')
  .result()
  .end();
const backend = new ChaosBackend(new ScriptedBackend(built, { perEventDelayMs: 250 }), {});

const staticDir = resolve(import.meta.dir, '../../apps/web/dist');
const context = createApp({
  backend,
  store,
  db,
  diagnostics: {},
  static: { dir: staticDir },
});

const { dropSockets } = (() => {
  const handle = startEngineServer(context, { port: DEEP_PORT });
  // Test-only route, registered on the live Hono app after boot: POST has
  // no competing routes at this path, so ordering is safe.
  context.app.post('/_test/drop-sockets', (c) => {
    const dropped = handle.dropSockets();
    return c.json({ dropped });
  });
  return handle;
})();
void dropSockets;

console.log(`[deep] engine + SPA on http://127.0.0.1:${DEEP_PORT} (app-data: ${appDataDir})`);
