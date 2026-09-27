/**
 * T1.15 — Transcript HTTP route round-trip.
 *
 * Contract: `GET /conversations/:id/transcript` returns the parsed JSONL
 * transcript for a provisioned conversation as a wrapped
 * `{ lines: TranscriptLine[] }` response. The lines:
 *   1. arrive in file-order with `line_number` and `byte_offset` populated;
 *   2. carry a `raw` field with the JSON-decoded payload for valid lines;
 *   3. carry a `parse_error: { message, raw_text }` for malformed lines
 *      (and a `null` `raw`) — the route never throws on partial corruption;
 *   4. surface as a 404 `{ error: 'transcripts not configured' }` when the
 *      engine was constructed without the `transcripts` option (the opt-in
 *      404 contract from INVARIANTS I-1).
 *
 * Implementation: PR #20a (plans/2026-05-02-clod-ui-pr20a-transcript-route-v1.md).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import { ScriptedBackend, TypedTestClient, script } from '@clod-ui/test-kit';
import { encodeCwd } from '@clod-ui/transcripts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb } from '../../apps/engine/src/db/index.ts';
import { setSessionId } from '../../apps/engine/src/db/repositories.ts';
import { createApp, type CreateAppOptions } from '../../apps/engine/src/index.ts';
import { ensureProvisioned } from '../../apps/engine/src/provisioning.ts';
import { FallbackTitler } from '../../apps/engine/src/titler.ts';

interface RunningEngine {
  server: ReturnType<typeof Bun.serve>;
  client: TypedTestClient;
  db: ReturnType<typeof openDb>;
  baseUrl: string;
  appDataDir: string;
  projectsDir: string;
  store: ManifestStore;
}

interface BootOptions {
  appDataDir: string;
  withTranscripts: boolean;
}

async function bootEngine(opts: BootOptions): Promise<RunningEngine> {
  const built = script().init('sess-noop').assistantText('ok').result().end();
  const backend = new ScriptedBackend(built);
  const store = new ManifestStore(opts.appDataDir);
  const db = openDb({ path: join(opts.appDataDir, 'engine.sqlite') });
  const projectsDir = join(opts.appDataDir, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  const createAppOpts: CreateAppOptions = {
    backend,
    store,
    db,
    titler: new FallbackTitler(),
  };
  if (opts.withTranscripts) {
    createAppOpts.transcripts = { projectsDir };
  }
  const context = createApp(createAppOpts);

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
      message: () => {
        /* no framed client protocol yet */
      },
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const client = new TypedTestClient({ baseUrl });
  await client.connect();
  return { server, client, db, baseUrl, appDataDir: opts.appDataDir, projectsDir, store };
}

async function shutdown(engine: RunningEngine): Promise<void> {
  await engine.client.close();
  engine.server.stop(true);
  engine.db.close();
}

interface TranscriptLineResponse {
  line_number: number;
  byte_offset: number;
  raw?: unknown;
  parse_error?: { message: string; raw_text: string };
}

interface TranscriptResponseShape {
  lines: TranscriptLineResponse[];
}

describe('T1.15 transcript HTTP route', () => {
  let appDataDir: string;
  let engine: RunningEngine | undefined;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'clod-ui-t115-'));
    appDataDir = join(root, 'app-data');
    mkdirSync(appDataDir, { recursive: true });
    engine = undefined;
  });

  afterEach(async () => {
    if (engine) await shutdown(engine);
    rmSync(appDataDir, { recursive: true, force: true });
  });

  test('returns parsed lines in file-order, tolerating malformed JSON', async () => {
    const sessionId = 'sess-T115-A';
    const convId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const cwd = join(appDataDir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    engine = await bootEngine({ appDataDir, withTranscripts: true });

    // Provision the conversation directly (no need to drive a turn for this
    // contract — the route reads from disk, not the live wire).
    await ensureProvisioned({ store: engine.store, db: engine.db }, { convId, cwd });
    setSessionId(engine.db, convId, sessionId);

    // Write a JSONL file with three lines:
    //   - valid user message
    //   - malformed line (bad JSON)
    //   - valid assistant message
    const encodedCwd = encodeCwd(cwd);
    const projDir = join(engine.projectsDir, encodedCwd);
    mkdirSync(projDir, { recursive: true });
    const jsonlPath = join(projDir, `${sessionId}.jsonl`);
    const validUser = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'first message' },
    });
    const validAssistant = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] },
    });
    const malformed = '{not valid json at all';
    const fileContent = `${validUser}\n${malformed}\n${validAssistant}\n`;
    writeFileSync(jsonlPath, fileContent, 'utf8');

    // Hit the route.
    const res = await fetch(`${engine.baseUrl}/conversations/${convId}/transcript`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TranscriptResponseShape;
    expect(body.lines).toHaveLength(3);

    // Line 0: valid user message.
    const line0 = body.lines[0]!;
    expect(line0.line_number).toBe(0);
    expect(line0.byte_offset).toBe(0);
    expect(line0.raw).toEqual({
      type: 'user',
      message: { role: 'user', content: 'first message' },
    });
    expect(line0.parse_error).toBeUndefined();

    // Line 1: malformed JSON, parse_error populated, raw is null.
    const line1 = body.lines[1]!;
    expect(line1.line_number).toBe(1);
    expect(line1.byte_offset).toBeGreaterThan(0);
    expect(line1.raw).toBeNull();
    expect(line1.parse_error).toBeDefined();
    expect(line1.parse_error!.raw_text).toBe(malformed);
    expect(typeof line1.parse_error!.message).toBe('string');

    // Line 2: valid assistant message — proves we kept reading past the
    // malformed line (parse-error tolerance, INVARIANTS I-2 spirit).
    const line2 = body.lines[2]!;
    expect(line2.line_number).toBe(2);
    expect(line2.byte_offset).toBeGreaterThan(line1.byte_offset);
    expect(line2.raw).toEqual({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] },
    });
    expect(line2.parse_error).toBeUndefined();
  });

  test('returns 404 not_configured when transcripts option absent', async () => {
    engine = await bootEngine({ appDataDir, withTranscripts: false });

    const res = await fetch(`${engine.baseUrl}/conversations/anything/transcript`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('transcripts not configured');
  });
});
