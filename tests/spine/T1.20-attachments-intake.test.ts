/**
 * T1.20 — Attachments intake + turn-body passthrough.
 *
 * Contract: `POST /conversations/:id/attachments` (JSON + base64,
 * persistence-gated) writes the decoded bytes into the conversation
 * dir's `attachments/` (sanitized name, collision-suffixed) and
 * returns typed metadata whose `path` feeds `TurnRequest.attachments`.
 * Attachments in the turn body reach the backend unmodified and
 * `compose()` emits the image content block in stdin plus `--add-dir
 * <attachments dir>`. Malformed body attachments → 400. The serving
 * route returns the stored bytes and never escapes the attachments
 * dir. Unconfigured engines answer the exact I-1 404 body.
 *
 * PR: plans/2026-06-12-clod-ui-pr33-attachments-intake-v1.md §D1–D6.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BackendEvent, ClaudeBackend, TurnRequest } from '@clod-ui/backend';
import { compose } from '@clod-ui/backend';
import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, TestEnv, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb } from '../../apps/engine/src/db/index.ts';
import { createApp } from '../../apps/engine/src/index.ts';

const CONV = '20202020-2020-4020-8020-202020202020';
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

class RecordingBackend implements ClaudeBackend {
  readonly requests: TurnRequest[] = [];
  constructor(private readonly inner: ScriptedBackend) {}
  startTurn(req: TurnRequest): AsyncIterable<BackendEvent> {
    this.requests.push(req);
    return this.inner.startTurn(req);
  }
  cancel(turnId: string): Promise<void> {
    return this.inner.cancel(turnId);
  }
  version(): Promise<string> {
    return this.inner.version();
  }
  health(): ReturnType<ClaudeBackend['health']> {
    return this.inner.health();
  }
}

let env: TestEnv;

beforeEach(async () => {
  env = await TestEnv.create({ name: 't1.20' });
});

afterEach(async () => {
  await env.dispose();
});

function boot(): {
  ctx: { app: { fetch: (req: Request) => Response | Promise<Response> } };
  backend: RecordingBackend;
  store: ManifestStore;
} {
  const store = new ManifestStore(env.appDataDir);
  const db = openDb({ path: join(env.appDataDir, 'engine.sqlite') });
  const backend = new RecordingBackend(
    new ScriptedBackend(script().init('s-20').assistantText('ok').result().end()),
  );
  const ctx = createApp({ backend, store, db });
  return { ctx, backend, store };
}

async function upload(
  ctx: { app: { fetch: (req: Request) => Response | Promise<Response> } },
  body: Record<string, unknown>,
): Promise<Response> {
  return ctx.app.fetch(
    new Request(`http://x/conversations/${CONV}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('T1.20 attachments intake', () => {
  test('upload writes bytes into attachments/ and returns typed metadata; serving round-trips', async () => {
    const { ctx, store } = boot();
    const res = await upload(ctx, {
      name: 'tiny image.png',
      content_type: 'image/png',
      data_base64: Buffer.from(PNG_BYTES).toString('base64'),
    });
    expect(res.status).toBe(201);
    const meta = (await res.json()) as { name: string; path: string; size: number };
    expect(meta.name).toBe('tiny_image.png'); // sanitized
    expect(meta.size).toBe(PNG_BYTES.byteLength);
    expect(meta.path).toBe(join(store.conversationDir(CONV), 'attachments', 'tiny_image.png'));
    expect(Uint8Array.from(readFileSync(meta.path))).toEqual(PNG_BYTES);

    // Second upload with the same name gets a collision suffix.
    const res2 = await upload(ctx, {
      name: 'tiny image.png',
      data_base64: Buffer.from(PNG_BYTES).toString('base64'),
    });
    expect(((await res2.json()) as { name: string }).name).toBe('tiny_image-2.png');

    // Serving returns the stored bytes; traversal never escapes.
    const served = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV}/attachments/tiny_image.png`),
    );
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG_BYTES);
    const escape = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV}/attachments/..%2Fmanifest.json`),
    );
    expect(escape.status).toBe(404);
  });

  test('attachments in the turn body reach the backend and compose to stdin block + --add-dir', async () => {
    const { ctx, backend, store } = boot();
    const up = await upload(ctx, {
      name: 'pic.png',
      content_type: 'image/png',
      data_base64: Buffer.from(PNG_BYTES).toString('base64'),
    });
    const meta = (await up.json()) as { path: string };

    const res = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          turn_id: 'turn-20-a',
          user_message: 'what is this?',
          attachments: [{ path: meta.path, content_type: 'image/png' }],
        }),
      }),
    );
    expect(res.status).toBe(202);

    let req: TurnRequest | undefined;
    for (let i = 0; i < 100 && !req; i++) {
      req = backend.requests[0];
      if (!req) await new Promise((r) => setTimeout(r, 10));
    }
    if (!req) throw new Error('backend never received the request');
    // The engine loads image bytes at turn time (base64 source pinned by
    // the PR #33 real-CLI smoke — the CLI rejects path-source blocks).
    expect(req.attachments).toEqual([
      {
        path: meta.path,
        content_type: 'image/png',
        data_base64: Buffer.from(PNG_BYTES).toString('base64'),
      },
    ]);

    const { argv, stdin } = compose(req);
    const stdinText = new TextDecoder().decode(stdin);
    expect(stdinText).toContain('"type":"image"');
    expect(stdinText).toContain('"type":"base64"');
    expect(stdinText).toContain(Buffer.from(PNG_BYTES).toString('base64'));
    const attachmentsDir = join(store.conversationDir(CONV), 'attachments');
    const addDirs = argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : []));
    expect(addDirs).toContain(attachmentsDir);
  });

  test('malformed turn-body attachments are a 400', async () => {
    const { ctx } = boot();
    const res = await ctx.app.fetch(
      new Request(`http://x/conversations/${CONV}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          turn_id: 'turn-20-b',
          user_message: 'hi',
          attachments: ['/just/a/string'],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('attachments must be an array');
  });

  test('unconfigured engine answers the exact I-1 not-configured body', async () => {
    const backend = new ScriptedBackend(script().init('s').result().end());
    const ctx = createApp({ backend });
    const res = await upload(ctx, { name: 'x.png', data_base64: 'aGk=' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'attachments not configured' });
  });
});
