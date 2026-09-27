/**
 * Engine HTTP-route tests for /settings (PR #8).
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md §3.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SettingsStore } from '@clod-ui/settings';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createApp } from '../src/index.ts';

let dir: string;
let path: string;
function buildBackend() {
  return new ScriptedBackend(
    script().init('sess-engine-settings').assistantText('ok').result().end(),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clod-ui-settings-routes-'));
  path = join(dir, 'settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('engine /settings — routes are 404 when not configured', () => {
  test('GET /settings → 404 when no settings store', async () => {
    const ctx = createApp({ backend: buildBackend() });
    const res = await ctx.app.fetch(new Request('http://x/settings'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('settings not configured');
  });

  test('PUT /settings → 404 when no settings store', async () => {
    const ctx = createApp({ backend: buildBackend() });
    const res = await ctx.app.fetch(
      new Request('http://x/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('engine /settings — GET', () => {
  test('GET on a missing file returns 200 with empty settings', async () => {
    const store = new SettingsStore({ path });
    const ctx = createApp({ backend: buildBackend(), settings: { store } });
    const res = await ctx.app.fetch(new Request('http://x/settings'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  test('GET on a corrupt file returns 500 with typed settings_corrupt', async () => {
    writeFileSync(path, 'not-json{}');
    const store = new SettingsStore({ path });
    const ctx = createApp({ backend: buildBackend(), settings: { store } });
    const res = await ctx.app.fetch(new Request('http://x/settings'));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { kind: string; reason: string } };
    expect(body.error.kind).toBe('settings_corrupt');
    expect(body.error.reason).toBe('parse');
  });
});

describe('engine /settings — PUT', () => {
  test('PUT round-trip with documented + unknown keys', async () => {
    const store = new SettingsStore({ path });
    const ctx = createApp({ backend: buildBackend(), settings: { store } });
    const input = {
      theme: 'dark',
      model: 'claude-opus',
      allowedTools: ['Bash'],
      unknown: { custom_field: 42 },
    };
    const put = await ctx.app.fetch(
      new Request('http://x/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(input);

    const get = await ctx.app.fetch(new Request('http://x/settings'));
    expect(await get.json()).toEqual(input);

    // Disk: documented keys at top-level, unknown flattened back to top-level.
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({
      theme: 'dark',
      model: 'claude-opus',
      allowedTools: ['Bash'],
      custom_field: 42,
    });
  });

  test('PUT with malformed body returns 400 with typed settings_invalid', async () => {
    const store = new SettingsStore({ path });
    const ctx = createApp({ backend: buildBackend(), settings: { store } });
    const res = await ctx.app.fetch(
      new Request('http://x/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme: 'periwinkle' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('settings_invalid');
  });

  test('PUT with non-JSON body returns 400 with typed settings_invalid', async () => {
    const store = new SettingsStore({ path });
    const ctx = createApp({ backend: buildBackend(), settings: { store } });
    const res = await ctx.app.fetch(
      new Request('http://x/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { kind: string } };
    expect(body.error.kind).toBe('settings_invalid');
  });
});

describe('engine /settings — PATCH', () => {
  test('PATCH preserves unknown keys and only overwrites supplied documented keys', async () => {
    const store = new SettingsStore({ path });
    const ctx = createApp({ backend: buildBackend(), settings: { store } });

    // Seed with PUT.
    await ctx.app.fetch(
      new Request('http://x/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          theme: 'dark',
          model: 'claude-opus',
          unknown: { custom: 1, deep: { nested: 'value' } },
        }),
      }),
    );

    // PATCH only theme.
    const patch = await ctx.app.fetch(
      new Request('http://x/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme: 'light' }),
      }),
    );
    expect(patch.status).toBe(200);
    const merged = (await patch.json()) as Record<string, unknown>;
    expect(merged).toEqual({
      theme: 'light',
      model: 'claude-opus',
      unknown: { custom: 1, deep: { nested: 'value' } },
    });

    const reread = (await (await ctx.app.fetch(new Request('http://x/settings'))).json()) as Record<
      string,
      unknown
    >;
    expect(reread).toEqual(merged);
  });

  test('PATCH on missing file initializes from {}', async () => {
    const store = new SettingsStore({ path });
    const ctx = createApp({ backend: buildBackend(), settings: { store } });
    const res = await ctx.app.fetch(
      new Request('http://x/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme: 'dark' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: 'dark' });
  });
});
