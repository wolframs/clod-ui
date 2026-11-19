/**
 * T1.22 — Conversation profiles.
 *
 * Contract: with a registry of profiles, a new conversation runs on the
 * profile its first turn names (else the registry default) — argv[0] is the
 * profile's binary and the cwd its directory, as `GET /diagnostics` records
 * them. A conversation stored without a profile (every pre-#45 row) runs on
 * the engine-wide binary and its own stored cwd, never on the registry's
 * default. A profile removed from the registry answers its conversation's
 * next turn with 409 `profile_unavailable` and spawns nothing; a
 * `require_browser` profile refuses a turn without an `Origin` header (403
 * `browser_required`); a body profile that differs from the conversation's is
 * a 400. `GET /profiles` lists ids and labels only, plus the default.
 *
 * PR: plans/2026-11-05-clod-ui-pr45-profiles-v1.md §D3–D7.
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TurnRequest } from '@clod-ui/backend';
import { ProfilesResponseSchema } from '@clod-ui/contracts';
import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getConversation, openDb } from '../../apps/engine/src/db/index.ts';
import { createApp } from '../../apps/engine/src/index.ts';
import { FileProfileSource } from '../../apps/engine/src/profiles.ts';
import { ensureProvisioned } from '../../apps/engine/src/provisioning.ts';

const ENV_BINARY = '/env/claude';
const SEAT_BINARY = '/seat/clod_seat.sh';
const GATED_BINARY = '/gated/run';

type Ctx = ReturnType<typeof createApp>;

let root: string;
let profilesPath: string;
let spawned: TurnRequest[];
// Directories live under the test root: provisioning creates them.
let envCwd: string;
let SEAT: { id: string; label: string; binary: string; cwd: string };
let GATED: { id: string; label: string; binary: string; cwd: string; require_browser: true };
const PLAIN = { id: 'plain', label: 'plain Claude', binary: 'claude', cwd: null };

function writeRegistry(body: unknown): void {
  writeFileSync(`${profilesPath}.tmp`, JSON.stringify(body));
  renameSync(`${profilesPath}.tmp`, profilesPath);
}

function boot(): { ctx: Ctx; store: ManifestStore; db: ReturnType<typeof openDb> } {
  const scripted = new ScriptedBackend(script().init('s-22').assistantText('ok').result().end());
  const backend = Object.assign(scripted, {
    claudeBinary: ENV_BINARY,
    startTurn: (req: TurnRequest) => {
      spawned.push(req);
      return ScriptedBackend.prototype.startTurn.call(scripted, req);
    },
  });
  const store = new ManifestStore(root);
  const db = openDb({ path: join(root, 'engine.sqlite') });
  const ctx = createApp({
    backend,
    store,
    db,
    conversationCwd: envCwd,
    diagnostics: {},
    profiles: new FileProfileSource({ path: profilesPath, log: () => {} }),
  });
  return { ctx, store, db };
}

async function postTurn(
  ctx: Ctx,
  conv: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return ctx.app.fetch(
    new Request(`http://x/conversations/${conv}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        turn_id: `t-${conv}-${spawned.length}`,
        user_message: 'hi',
        ...extra,
      }),
    }),
  );
}

async function diagnosticsFor(
  ctx: Ctx,
  conv: string,
): Promise<{ argv: string[]; cwd: string; outcome?: unknown }> {
  for (let i = 0; i < 100; i++) {
    const res = await ctx.app.fetch(new Request('http://x/diagnostics'));
    const body = (await res.json()) as {
      turns: Array<{ conv_id: string; argv: string[]; cwd: string; outcome?: unknown }>;
    };
    const entry = body.turns.find((t) => t.conv_id === conv);
    if (entry?.outcome) return entry;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no finished diagnostics entry for ${conv}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clod-ui-t122-'));
  profilesPath = join(root, 'profiles.json');
  spawned = [];
  envCwd = join(root, 'env-cwd');
  SEAT = { id: 'seat', label: 'Seat', binary: SEAT_BINARY, cwd: join(root, 'seat') };
  GATED = {
    id: 'gated',
    label: 'Gated',
    binary: GATED_BINARY,
    cwd: join(root, 'g'),
    require_browser: true,
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('T1.22 profiles', () => {
  test("a new conversation runs on its profile's binary and cwd", async () => {
    writeRegistry({ default: 'seat', profiles: [SEAT, PLAIN] });
    const { ctx, store, db } = boot();

    expect((await postTurn(ctx, 'c-seat')).status).toBe(202);
    expect((await postTurn(ctx, 'c-plain', { profile: 'plain' })).status).toBe(202);

    const seat = await diagnosticsFor(ctx, 'c-seat');
    expect(seat.argv[0]).toBe(SEAT_BINARY);
    expect(seat.cwd).toBe(SEAT.cwd);
    const plain = await diagnosticsFor(ctx, 'c-plain');
    expect(plain.argv[0]).toBe('claude');
    // cwd null = the conversation's own directory, not the engine-wide cwd.
    expect(plain.cwd).toBe(join(store.conversationDir('c-plain'), 'cwd'));
    expect(getConversation(db, 'c-seat')?.profile).toBe('seat');
    expect(getConversation(db, 'c-plain')?.profile).toBe('plain');

    const list = (await (await ctx.app.fetch(new Request('http://x/conversations'))).json()) as {
      conversations: Array<{ conv_id: string; profile?: string }>;
    };
    expect(list.conversations.map((c) => [c.conv_id, c.profile]).sort()).toEqual([
      ['c-plain', 'plain'],
      ['c-seat', 'seat'],
    ]);
  });

  test('a row without a profile runs on the engine-wide binary, not the registry default', async () => {
    writeRegistry({ default: 'seat', profiles: [SEAT] });
    const { ctx, store, db } = boot();
    // A pre-#45 conversation: provisioned with no profile, on the env cwd.
    await ensureProvisioned({ store, db, defaultCwd: envCwd }, { convId: 'c-old' });

    expect((await postTurn(ctx, 'c-old')).status).toBe(202);
    const old = await diagnosticsFor(ctx, 'c-old');
    expect(old.argv[0]).toBe(ENV_BINARY);
    expect(old.cwd).toBe(envCwd);
    expect(spawned[0]?.claude_binary).toBeUndefined();
  });

  test('no registry file: the implicit profile, stored NULL, on the env binary and cwd', async () => {
    const { ctx, db } = boot();
    expect((await postTurn(ctx, 'c-new')).status).toBe(202);
    const entry = await diagnosticsFor(ctx, 'c-new');
    expect(entry.argv[0]).toBe(ENV_BINARY);
    expect(entry.cwd).toBe(envCwd);
    expect(getConversation(db, 'c-new')?.profile).toBeNull();

    const res = await ctx.app.fetch(new Request('http://x/profiles'));
    expect(await res.json()).toEqual({
      default: 'default',
      profiles: [{ id: 'default', label: 'default' }],
    });
  });

  test('a removed profile answers 409 and spawns nothing', async () => {
    writeRegistry({ default: 'seat', profiles: [SEAT, PLAIN] });
    const { ctx } = boot();
    expect((await postTurn(ctx, 'c-1', { profile: 'plain' })).status).toBe(202);
    await diagnosticsFor(ctx, 'c-1');
    expect(spawned).toHaveLength(1);

    writeRegistry({ default: 'seat', profiles: [SEAT] });
    const res = await postTurn(ctx, 'c-1');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { kind: 'profile_unavailable', profile: 'plain' } });
    // A new conversation naming a profile that is not there: the same.
    expect((await postTurn(ctx, 'c-2', { profile: 'plain' })).status).toBe(409);
    expect(spawned).toHaveLength(1);
  });

  test('require_browser refuses a turn without Origin (403) and takes one with it', async () => {
    writeRegistry({ default: 'gated', profiles: [GATED] });
    const { ctx, db } = boot();
    const refused = await postTurn(ctx, 'c-g');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { kind: 'browser_required' } });
    expect(getConversation(db, 'c-g')).toBeNull();
    expect(spawned).toHaveLength(0);

    const ok = await postTurn(ctx, 'c-g', {}, { origin: 'http://x' });
    expect(ok.status).toBe(202);
    expect((await diagnosticsFor(ctx, 'c-g')).argv[0]).toBe(GATED_BINARY);
  });

  test('an upload before the first turn does not pin the profile', async () => {
    writeRegistry({ default: 'seat', profiles: [SEAT, PLAIN] });
    const { ctx, db } = boot();
    const up = await ctx.app.fetch(
      new Request('http://x/conversations/c-up/attachments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'a.txt', data_base64: btoa('hi') }),
      }),
    );
    expect(up.status).toBe(201);
    expect(getConversation(db, 'c-up')).toBeNull();
    expect((await postTurn(ctx, 'c-up', { profile: 'plain' })).status).toBe(202);
    expect(getConversation(db, 'c-up')?.profile).toBe('plain');
  });

  test('a body profile that differs from the conversation is a 400', async () => {
    writeRegistry({ default: 'seat', profiles: [SEAT, PLAIN] });
    const { ctx } = boot();
    expect((await postTurn(ctx, 'c-f', { profile: 'seat' })).status).toBe(202);
    await diagnosticsFor(ctx, 'c-f');
    const res = await postTurn(ctx, 'c-f', { profile: 'plain' });
    expect(res.status).toBe(400);
    expect(spawned).toHaveLength(1);
    // The same profile again is fine.
    expect((await postTurn(ctx, 'c-f', { profile: 'seat' })).status).toBe(202);
  });

  test('GET /profiles: ids and labels, no paths; a malformed file keeps the last good + warns', async () => {
    writeRegistry({ default: 'plain', profiles: [SEAT, PLAIN, GATED] });
    const { ctx } = boot();
    const get = async (): Promise<unknown> =>
      (await ctx.app.fetch(new Request('http://x/profiles'))).json();

    const body = ProfilesResponseSchema.parse(await get());
    expect(body).toEqual({
      default: 'plain',
      profiles: [
        { id: 'seat', label: 'Seat' },
        { id: 'plain', label: 'plain Claude' },
        { id: 'gated', label: 'Gated' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('/');

    writeRegistry({ default: 'nope', profiles: [SEAT] });
    const broken = ProfilesResponseSchema.parse(await get());
    expect(broken.default).toBe('plain');
    expect(broken.warning).toContain('default must name one of the profiles');
  });
});
