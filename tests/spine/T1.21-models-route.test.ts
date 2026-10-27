/**
 * T1.21 — Model list route.
 *
 * Contract: `GET /models` answers with the backend's own model list
 * (`{ models, fetched_at }`, schema-valid for the typed client), probed in
 * the conversations' cwd when one is configured. A backend that cannot list
 * models gives the exact I-1 body `404 { error: 'models not configured' }`;
 * a failing probe is a 502 carrying the reason.
 *
 * PR: plans/landed/2026-10-27-clod-ui-pr42-models-and-effort-v1.md §3.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelInfo } from '@clod-ui/contracts';
import { ModelsResponseSchema } from '@clod-ui/contracts';
import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { describe, expect, test } from 'bun:test';

import { openDb } from '../../apps/engine/src/db/index.ts';
import { createApp } from '../../apps/engine/src/index.ts';

const OPUS: ModelInfo = {
  value: 'opus',
  display_name: 'Opus 5.5',
  resolved_model: 'claude-opus-5-5',
  effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
};

function scripted(): ScriptedBackend {
  return new ScriptedBackend(script().init('s-21').assistantText('ok').result().end());
}

async function getModels(ctx: {
  app: { fetch: (req: Request) => Response | Promise<Response> };
}): Promise<Response> {
  return ctx.app.fetch(new Request('http://x/models'));
}

describe('T1.21 models route', () => {
  test("lists the backend's models, probed in the conversations' cwd", async () => {
    const seen: Array<{ cwd?: string }> = [];
    const backend = Object.assign(scripted(), {
      async listModels(opts?: { cwd?: string }): Promise<ModelInfo[]> {
        seen.push(opts ?? {});
        return [OPUS];
      },
    });
    const root = mkdtempSync(join(tmpdir(), 'clod-ui-t121-'));
    const ctx = createApp({
      backend,
      store: new ManifestStore(root),
      db: openDb({ path: join(root, 'engine.sqlite') }),
      conversationCwd: '/projects/seat',
    });
    const res = await getModels(ctx);
    expect(res.status).toBe(200);
    const body = ModelsResponseSchema.parse(await res.json());
    expect(body.models).toEqual([OPUS]);
    expect(typeof body.fetched_at).toBe('number');
    expect(seen).toEqual([{ cwd: '/projects/seat' }]);
  });

  test('a backend without a model list is not configured (I-1)', async () => {
    const res = await getModels(createApp({ backend: scripted() }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'models not configured' });
  });

  test('a failing probe is a 502 with the reason', async () => {
    const backend = Object.assign(scripted(), {
      async listModels(): Promise<ModelInfo[]> {
        throw new Error('CLI initialize failed: not logged in');
      },
    });
    const res = await getModels(createApp({ backend }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'CLI initialize failed: not logged in' });
  });
});
