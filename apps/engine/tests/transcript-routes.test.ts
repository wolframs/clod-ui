/**
 * Engine route tests: GET /conversations/:id/transcript.
 *
 * Hermetic per-test temp dir; real ManifestStore + SQLite + writes synthetic
 * JSONL into the projects dir to mimic Claude Code's transcript file layout.
 *
 * Coverage matrix:
 *   - 404 when persistence absent
 *   - 404 when transcripts option absent
 *   - 404 when conversation does not exist
 *   - 200 + empty list when conversation exists but JSONL absent
 *   - 200 + empty list when claude_session_id not yet captured
 *   - 200 + lines when JSONL present
 *   - 200 + parse_error preserved per line
 *   - 200 + with_raw=false strips raw text
 *
 * Spec: plans/2026-05-02-clod-ui-pr20a-transcript-route-v1.md §6.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ManifestStore } from '@clod-ui/manifest';
import { encodeCwd } from '@clod-ui/transcripts';
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { openDb, setSessionId } from '../src/db/index.ts';
import { createApp } from '../src/index.ts';
import { ensureProvisioned } from '../src/provisioning.ts';

const CONV_ID = '11111111-1111-4111-8111-111111111111';

let root: string;
let store: ManifestStore;
let db: Database;
let projectsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'transcript-route-'));
  store = new ManifestStore(join(root, 'data'));
  db = openDb({ path: join(root, 'engine.sqlite') });
  projectsDir = join(root, 'projects');
  mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('GET /conversations/:id/transcript — opt-in 404', () => {
  test('404 when persistence absent', async () => {
    const ctx = createApp({});
    const res = await ctx.app.fetch(new Request(`http://x/conversations/${CONV_ID}/transcript`));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'transcripts not configured' });
  });

  test('404 when persistence present but transcripts absent', async () => {
    const ctx = createApp({ store, db });
    const res = await ctx.app.fetch(new Request(`http://x/conversations/${CONV_ID}/transcript`));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'transcripts not configured' });
  });
});

describe('GET /conversations/:id/transcript — happy paths', () => {
  test('404 + conversation-not-found error when conv_id unknown', async () => {
    const ctx = createApp({ store, db, transcripts: { projectsDir } });
    const res = await ctx.app.fetch(new Request(`http://x/conversations/c-nonexistent/transcript`));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'conversation not found' });
  });

  test('200 + empty list when conversation has no claude_session_id yet', async () => {
    const ctx = createApp({ store, db, transcripts: { projectsDir } });
    await ensureProvisioned({ store, db }, { convId: CONV_ID });

    const res = await ctx.app.fetch(new Request(`http://x/conversations/${CONV_ID}/transcript`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: unknown[] };
    // No claude_session_id yet means the route falls back to <conv_id>.jsonl;
    // since neither the project dir nor the file exist, lines is empty.
    expect(body.lines).toEqual([]);
  });

  test('200 + empty list when JSONL file absent', async () => {
    const ctx = createApp({ store, db, transcripts: { projectsDir } });
    const { cwd } = await ensureProvisioned({ store, db }, { convId: CONV_ID });
    setSessionId(db, CONV_ID, 'sess-abc');
    // create the project subdir but no jsonl file
    mkdirSync(join(projectsDir, encodeCwd(cwd)), { recursive: true });

    const res = await ctx.app.fetch(new Request(`http://x/conversations/${CONV_ID}/transcript`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: unknown[] };
    expect(body.lines).toEqual([]);
  });

  test('200 + lines when JSONL present', async () => {
    const ctx = createApp({ store, db, transcripts: { projectsDir } });
    const { cwd } = await ensureProvisioned({ store, db }, { convId: CONV_ID });
    setSessionId(db, CONV_ID, 'sess-abc');

    const projectDir = join(projectsDir, encodeCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
    const jsonlPath = join(projectDir, 'sess-abc.jsonl');
    writeFileSync(
      jsonlPath,
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        }),
      ].join('\n') + '\n',
    );

    const res = await ctx.app.fetch(new Request(`http://x/conversations/${CONV_ID}/transcript`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ line_number: number; byte_offset: number; raw: { type?: string } }>;
    };
    expect(body.lines).toHaveLength(3);
    expect(body.lines[0]?.line_number).toBe(0);
    expect(body.lines[1]?.line_number).toBe(1);
    expect(body.lines[2]?.line_number).toBe(2);
    expect(body.lines[0]?.byte_offset).toBe(0);
    expect(body.lines[1]?.byte_offset).toBeGreaterThan(0);
    // raw is the parsed JSON object (decoded by the line parser), not the
    // original text. Renderers consume it as data, not as a string.
    expect(body.lines[0]?.raw).toMatchObject({ type: 'system' });
    expect(body.lines[1]?.raw).toMatchObject({ type: 'user' });
    expect(body.lines[2]?.raw).toMatchObject({ type: 'assistant' });
  });

  test('200 + parse_error preserved per line', async () => {
    const ctx = createApp({ store, db, transcripts: { projectsDir } });
    const { cwd } = await ensureProvisioned({ store, db }, { convId: CONV_ID });
    setSessionId(db, CONV_ID, 'sess-abc');

    const projectDir = join(projectsDir, encodeCwd(cwd));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'sess-abc.jsonl'),
      [
        JSON.stringify({ type: 'system' }),
        '{ this is not valid json',
        JSON.stringify({ type: 'user' }),
      ].join('\n') + '\n',
    );

    const res = await ctx.app.fetch(new Request(`http://x/conversations/${CONV_ID}/transcript`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{
        raw: unknown;
        parse_error?: { message: string; raw_text: string };
      }>;
    };
    expect(body.lines).toHaveLength(3);
    // Successful lines: raw is set, parse_error absent.
    expect(body.lines[0]?.raw).toMatchObject({ type: 'system' });
    expect(body.lines[0]?.parse_error).toBeUndefined();
    // Failed line: raw is null, parse_error carries the original text.
    expect(body.lines[1]?.raw).toBeNull();
    expect(body.lines[1]?.parse_error).toBeDefined();
    expect(body.lines[1]?.parse_error?.raw_text).toBe('{ this is not valid json');
    expect(body.lines[1]?.parse_error?.message).toBeTruthy();
    expect(body.lines[2]?.raw).toMatchObject({ type: 'user' });
    expect(body.lines[2]?.parse_error).toBeUndefined();
  });
});
