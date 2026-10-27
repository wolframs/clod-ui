/**
 * T1.16 — Static SPA serving (opt-in `static: { dir }`).
 *
 * Contract: an engine constructed with `static: { dir }` serves the built
 * web SPA from its own origin as a GET catch-all:
 *   1. `/` returns `index.html` with an html Content-Type;
 *   2. an existing asset path returns that exact file;
 *   3. an unknown path falls back to `index.html` (SPA client routes);
 *   4. API routes win — `/health` still returns the JSON health body;
 *   5. path resolution can never escape the static root (traversal-safe);
 *   6. without the option, no catch-all exists — `/` stays 404.
 *
 * The I-1 `not configured` JSON body is deliberately NOT used here: static
 * HTML is not a typed-client surface (PR #21 plan §2).
 *
 * Implementation: PR #21 (plans/2026-06-10-clod-ui-pr21-launcher-v1.md).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp, type CreateAppOptions } from '../../apps/engine/src/index.ts';

const INDEX_HTML = '<!doctype html><html><body>clod-ui spa</body></html>';
const APP_JS = 'console.log("clod-ui asset");';
const SECRET = 'outside-the-root';

interface RunningEngine {
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
}

function bootEngine(staticDir: string | null): RunningEngine {
  const built = script().init('sess-noop').assistantText('ok').result().end();
  const opts: CreateAppOptions = { backend: new ScriptedBackend(built) };
  if (staticDir !== null) {
    opts.static = { dir: staticDir };
  }
  const context = createApp(opts);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => context.app.fetch(req),
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

describe('T1.16 static SPA serving', () => {
  let root: string;
  let staticDir: string;
  let engine: RunningEngine | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clod-ui-t116-'));
    staticDir = join(root, 'dist');
    mkdirSync(join(staticDir, 'assets'), { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), INDEX_HTML, 'utf8');
    writeFileSync(join(staticDir, 'assets', 'app.js'), APP_JS, 'utf8');
    // A file *outside* the static root — must never be reachable.
    writeFileSync(join(root, 'secret.txt'), SECRET, 'utf8');
    engine = undefined;
  });

  afterEach(() => {
    engine?.server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('serves index.html at /, exact assets, and SPA fallback for unknown paths', async () => {
    engine = bootEngine(staticDir);

    const index = await fetch(`${engine.baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type') ?? '').toContain('text/html');
    expect(await index.text()).toBe(INDEX_HTML);

    const asset = await fetch(`${engine.baseUrl}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe(APP_JS);

    // Unknown path → SPA fallback: the client router owns it.
    const fallback = await fetch(`${engine.baseUrl}/conversations/some-client-route`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe(INDEX_HTML);
  });

  test('API routes win over the static catch-all', async () => {
    engine = bootEngine(staticDir);

    const res = await fetch(`${engine.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await res.json()) as { cli: string };
    expect(typeof body.cli).toBe('string');
  });

  test('path resolution never escapes the static root', async () => {
    engine = bootEngine(staticDir);

    // Plain and percent-encoded traversal attempts. The URL parser
    // collapses most of these before the route sees them; whatever
    // survives must hit the resolve-prefix guard. Either way the secret
    // outside the root must not come back.
    for (const path of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
    ]) {
      const res = await fetch(`${engine.baseUrl}${path}`);
      const text = await res.text();
      expect(text).not.toBe(SECRET);
    }
  });

  test('without the static option there is no catch-all — / stays 404', async () => {
    engine = bootEngine(null);

    const res = await fetch(`${engine.baseUrl}/`);
    expect(res.status).toBe(404);
  });
});
