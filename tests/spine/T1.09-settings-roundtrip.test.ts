/**
 * T1.09 — Settings round-trip.
 *
 * Contract: a `ClaudeSettings` object written via the engine's settings
 * endpoint and then re-read returns identical documented keys (`theme`,
 * `model`, `allowedTools`, `disallowedTools`) and preserves any unknown
 * keys byte-for-byte in the `unknown` passthrough bucket without
 * corruption or reordering of the underlying settings file.
 *
 * Implementation: PR #8 (plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SettingsStore } from '@clod-ui/settings';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '../../apps/engine/src/index.ts';

interface RunningEngine {
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  settingsPath: string;
}

async function bootEngine(opts: { settingsPath: string }): Promise<RunningEngine> {
  const built = script().init('sess-T109').assistantText('ok').result().end();
  const backend = new ScriptedBackend(built);
  const store = new SettingsStore({ path: opts.settingsPath });
  const context = createApp({ backend, settings: { store } });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => context.app.fetch(req),
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    settingsPath: opts.settingsPath,
  };
}

function shutdown(engine: RunningEngine): void {
  engine.server.stop(true);
}

describe('T1.09 settings round-trip', () => {
  let dir: string;
  let settingsPath: string;
  let engine: RunningEngine | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clod-ui-t109-'));
    settingsPath = join(dir, 'settings.json');
    mkdirSync(dir, { recursive: true });
    engine = undefined;
  });

  afterEach(() => {
    if (engine) shutdown(engine);
    rmSync(dir, { recursive: true, force: true });
  });

  test('documented + unknown keys survive write/read cycle', async () => {
    engine = await bootEngine({ settingsPath });

    const payload = {
      theme: 'dark',
      model: 'claude-opus',
      allowedTools: ['Bash', 'Read'],
      disallowedTools: ['Write'],
      unknown: {
        // Deliberately non-alphabetic insertion order; flatten preserves it.
        zKey: 1,
        aKey: 'value',
        nestedConfig: { feature: true },
      },
    };

    // PUT round-trips the response.
    const put = await fetch(`${engine.baseUrl}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(payload);

    // GET reads the same payload back through the same store.
    const get = await fetch(`${engine.baseUrl}/settings`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(payload);

    // Disk: documented keys at top level, then unknown keys flattened in their
    // original insertion order. No reorder, no extra fields, no missing fields.
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toEqual([
      'theme',
      'model',
      'allowedTools',
      'disallowedTools',
      'zKey',
      'aKey',
      'nestedConfig',
    ]);
    expect(onDisk).toEqual({
      theme: 'dark',
      model: 'claude-opus',
      allowedTools: ['Bash', 'Read'],
      disallowedTools: ['Write'],
      zKey: 1,
      aKey: 'value',
      nestedConfig: { feature: true },
    });
  });

  test('partial update merges without losing unknown keys', async () => {
    // Seed disk directly with documented + unknown keys *before* engine boot,
    // proving that the round-trip survives a fresh engine reading an existing
    // user settings.json.
    const seed = {
      theme: 'dark',
      model: 'claude-opus',
      mcpServers: { foo: 'bar' },
      experimental_flag: 'on',
    };
    writeFileSync(settingsPath, JSON.stringify(seed, null, 2));

    engine = await bootEngine({ settingsPath });

    // PATCH only `theme`.
    const patch = await fetch(`${engine.baseUrl}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'light' }),
    });
    expect(patch.status).toBe(200);

    // Subsequent GET shows the merged shape.
    const get = await fetch(`${engine.baseUrl}/settings`);
    const body = (await get.json()) as {
      theme: string;
      model: string;
      unknown: Record<string, unknown>;
    };
    expect(body.theme).toBe('light');
    expect(body.model).toBe('claude-opus');
    expect(body.unknown).toEqual({ mcpServers: { foo: 'bar' }, experimental_flag: 'on' });

    // Disk: unknown keys preserved verbatim, theme overwritten, no reorder.
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({
      theme: 'light',
      model: 'claude-opus',
      mcpServers: { foo: 'bar' },
      experimental_flag: 'on',
    });
  });
});
