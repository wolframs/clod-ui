/**
 * Engine integration tests for auto-titling (PR #10).
 *
 * Spec: plans/landed/2026-04-25-clod-ui-pr10-auto-titling-v1.md §Tests
 *
 * Boot pattern: real `createApp` with persistence + `ScriptedBackend` +
 * a custom `Titler` injected for determinism. We use `app.fetch(Request)`
 * to drive the engine and capture broadcasts via `setBroadcast`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EventEnvelope } from '@clod-ui/contracts';
import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, script } from '@clod-ui/test-kit';
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb } from '../src/db/index.ts';
import { createApp } from '../src/index.ts';
import type { Titler, TitlerInput } from '../src/titler.ts';

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';

let root: string;
let store: ManifestStore;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clod-ui-titling-'));
  store = new ManifestStore(root);
  db = openDb({ path: join(root, 'engine.sqlite') });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A Titler that captures every call and returns a scripted title. */
class CapturingTitler implements Titler {
  public readonly calls: TitlerInput[] = [];
  constructor(
    private readonly fn: (input: TitlerInput) => Promise<string> | string = () => 'scripted-title',
  ) {}
  async suggestTitle(input: TitlerInput): Promise<string> {
    this.calls.push(input);
    return Promise.resolve(this.fn(input));
  }
}

/** Wait until `predicate()` returns true (or a Promise resolving to true). */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  if (!(await predicate())) {
    throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
  }
}

function buildBackend() {
  return new ScriptedBackend(
    script()
      .init('sess-titling-1')
      .assistantText('Sure, here is the answer.')
      .assistantComplete()
      .result()
      .end(),
  );
}

async function postTurn(
  ctx: { app: { fetch: (req: Request) => Promise<Response> } },
  args: { convId: string; turnId: string; userMessage: string },
): Promise<Response> {
  return ctx.app.fetch(
    new Request(`http://x/conversations/${args.convId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        turn_id: args.turnId,
        user_message: args.userMessage,
      }),
    }),
  );
}

describe('auto-titling — happy path', () => {
  test('first turn.result triggers titler and persists conversation.titled', async () => {
    const titler = new CapturingTitler(() => 'Refactor the login form');
    const broadcasts: EventEnvelope[] = [];
    const ctx = createApp({
      backend: buildBackend(),
      store,
      db,
      titler,
      onBroadcast: (env) => broadcasts.push(env),
    });

    const res = await postTurn(ctx, {
      convId: CONV_A,
      turnId: 'turn-1',
      userMessage: 'Help me refactor the login form.',
    });
    expect(res.status).toBe(202);

    // Wait for the titler to be invoked + the manifest event to land.
    await waitFor(() => titler.calls.length > 0);
    await waitFor(async () => {
      const events = await store.readAll(CONV_A);
      return events.some((e) => e.kind === 'conversation.titled');
    });

    // (a) Titler called exactly once with the right input.
    expect(titler.calls).toHaveLength(1);
    expect(titler.calls[0]?.conv_id).toBe(CONV_A);
    expect(titler.calls[0]?.user_message).toBe('Help me refactor the login form.');
    expect(titler.calls[0]?.assistant_text).toBe('Sure, here is the answer.');

    // (b) Manifest contains a conversation.titled event with the chosen title.
    const events = await store.readAll(CONV_A);
    const titled = events.find((e) => e.kind === 'conversation.titled');
    expect(titled).toBeDefined();
    expect((titled as { title: string }).title).toBe('Refactor the login form');

    // The fold projects state.title.
    const state = store.fold(events);
    expect(state.title).toBe('Refactor the login form');

    // (c) Wire broadcast fired with the same title + conv_id.
    const titledBroadcasts = broadcasts.filter((b) => b.kind === 'conversation.titled');
    expect(titledBroadcasts).toHaveLength(1);
    expect(titledBroadcasts[0]?.conv_id).toBe(CONV_A);
    const payload = titledBroadcasts[0]?.payload as { title: string; conv_id: string };
    expect(payload.title).toBe('Refactor the login form');
    expect(payload.conv_id).toBe(CONV_A);
  });

  test('broadcast carries conv_id (multi-conv routing)', async () => {
    const titler = new CapturingTitler(() => 'Other Title');
    const broadcasts: EventEnvelope[] = [];
    const ctx = createApp({
      backend: buildBackend(),
      store,
      db,
      titler,
      onBroadcast: (env) => broadcasts.push(env),
    });

    await postTurn(ctx, {
      convId: CONV_B,
      turnId: 'turn-other',
      userMessage: 'Different conversation',
    });

    await waitFor(() => broadcasts.some((b) => b.kind === 'conversation.titled'));
    const titled = broadcasts.find((b) => b.kind === 'conversation.titled');
    expect(titled?.conv_id).toBe(CONV_B);
    expect((titled?.payload as { conv_id: string }).conv_id).toBe(CONV_B);
  });
});

describe('auto-titling — idempotency', () => {
  test('second turn does not re-trigger titler once title is set', async () => {
    const titler = new CapturingTitler(() => 'First-title');
    // ScriptedBackend replays the same script for every startTurn() call —
    // perfect for "two turns, same shape" tests. The second turn's titler
    // worker reads the manifest, sees the title is already set, and aborts.
    const broadcasts: EventEnvelope[] = [];
    const ctx = createApp({
      backend: buildBackend(),
      store,
      db,
      titler,
      onBroadcast: (env) => broadcasts.push(env),
    });

    await postTurn(ctx, {
      convId: CONV_A,
      turnId: 'turn-1',
      userMessage: 'First message',
    });
    await waitFor(async () => {
      const events = await store.readAll(CONV_A);
      return events.some((e) => e.kind === 'conversation.titled');
    });
    const callsAfterFirst = titler.calls.length;
    expect(callsAfterFirst).toBe(1);

    await postTurn(ctx, {
      convId: CONV_A,
      turnId: 'turn-2',
      userMessage: 'Second message',
    });
    // Wait long enough for the second turn's terminator + titler attempt
    // to resolve (the worker reads, sees the title, aborts — synchronous
    // enough that 50ms is plenty in Bun).
    await new Promise<void>((r) => setTimeout(r, 100));

    // Manifest still has exactly one conversation.titled event.
    const events = await store.readAll(CONV_A);
    const titledEvents = events.filter((e) => e.kind === 'conversation.titled');
    expect(titledEvents).toHaveLength(1);
    // Exactly one conversation.titled wire broadcast.
    const titledBroadcasts = broadcasts.filter((b) => b.kind === 'conversation.titled');
    expect(titledBroadcasts).toHaveLength(1);
    // The second turn's titler attempt MAY or MAY NOT have called
    // `suggestTitle` (the engine's pre-titler check is best-effort: it reads
    // state.title before invoking, so it usually short-circuits). What's
    // *guaranteed* is the title-write count, which is 1.
    expect(titler.calls.length).toBeLessThanOrEqual(2);
  });

  test('concurrent UI title-set wins over titler (re-check race guard)', async () => {
    let titlerResolveBlocker: (() => void) | undefined;
    const titler = new CapturingTitler(async () => {
      // Block until the test releases us — simulating a slow titler with a
      // concurrent direct manifest write happening in between.
      await new Promise<void>((r) => {
        titlerResolveBlocker = r;
      });
      return 'titler-derived';
    });
    const broadcasts: EventEnvelope[] = [];
    const ctx = createApp({
      backend: buildBackend(),
      store,
      db,
      titler,
      onBroadcast: (env) => broadcasts.push(env),
    });

    await postTurn(ctx, {
      convId: CONV_A,
      turnId: 'turn-1',
      userMessage: 'race the titler',
    });
    // Wait until the titler has been entered (its promise is in flight).
    await waitFor(() => titler.calls.length > 0);

    // Simulate a UI direct title-set landing while the titler is still pending.
    await store.appendEvent(CONV_A, {
      kind: 'conversation.titled',
      title: 'user-supplied',
    });

    // Release the titler.
    expect(titlerResolveBlocker).toBeDefined();
    titlerResolveBlocker!();

    // Give the engine a tick to attempt its append + re-check.
    await new Promise<void>((r) => setTimeout(r, 50));

    const events = await store.readAll(CONV_A);
    const titled = events.filter((e) => e.kind === 'conversation.titled');
    // Exactly one title event — the user-supplied one. The engine's re-check
    // saw state.title set and aborted before appending.
    expect(titled).toHaveLength(1);
    expect((titled[0] as { title: string }).title).toBe('user-supplied');
    const titledBroadcasts = broadcasts.filter((b) => b.kind === 'conversation.titled');
    // The engine never broadcast its derived title — the re-check fired before
    // append+broadcast.
    expect(titledBroadcasts).toHaveLength(0);
  });
});

describe('auto-titling — opt-in surface', () => {
  test('no titler ⇒ no titling event nor broadcast', async () => {
    const broadcasts: EventEnvelope[] = [];
    const ctx = createApp({
      backend: buildBackend(),
      store,
      db,
      // no titler!
      onBroadcast: (env) => broadcasts.push(env),
    });

    await postTurn(ctx, {
      convId: CONV_A,
      turnId: 'turn-1',
      userMessage: 'Hello',
    });
    await waitFor(() => broadcasts.some((b) => b.kind === 'turn.result'));

    const events = await store.readAll(CONV_A);
    expect(events.some((e) => e.kind === 'conversation.titled')).toBe(false);
    expect(broadcasts.some((b) => b.kind === 'conversation.titled')).toBe(false);
  });

  test('titler without persistence is a configuration error', () => {
    const titler = new CapturingTitler();
    expect(() =>
      createApp({
        backend: buildBackend(),
        titler,
      }),
    ).toThrow(/titler requires persistence/);
  });
});
