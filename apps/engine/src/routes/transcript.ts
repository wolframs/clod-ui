/**
 * `GET /conversations/:id/transcript` route registrar.
 *
 * Read-side companion to the `transcript.updated` wire envelope. Returns the
 * full historical JSONL transcript for a conversation, parsed line-by-line
 * (parse failures preserved with their raw text). The wire watcher continues
 * to push live updates; this route is the bootstrapping read for the UI when
 * a user selects an existing conversation.
 *
 * Opt-in via persistence + transcripts (mirrors /settings + /conversations
 * precedent): 404 `{ error: 'transcripts not configured' }` when either piece
 * is missing.
 *
 * Pipeline:
 *   1. Look up the conversation row by :id (404 if not found — same
 *      `{ error: 'conversation not found' }` shape the cancel route uses).
 *   2. Read the JSONL file at `<projectsDir>/<encodeCwd(cwd)>/<sess>.jsonl`
 *      via `readAllLines`. Empty array is a valid response when the file
 *      does not exist yet (e.g. provisioned but no turn ran).
 *      Falls back to `<conv_id>.jsonl` when no claude_session_id is recorded
 *      yet (the engine starts CC with `--session-id <conv_id>`, so the file
 *      may exist at the conv-id path before the first system.init lands).
 *   3. Return wrapped: `{ lines: TranscriptLine[] }`.
 *
 * **Wire / route identity** — `readAllLines` uses the same
 * `parseTranscriptLine` primitive that the live `TranscriptWatcher` uses, so
 * a `TranscriptLine` arriving over the wire (`transcript.updated`) is
 * byte-identical to one returned here. UI consumers (`useTranscript` +
 * `useSubscribe('transcript.updated')`) can de-dupe by `line_number` /
 * `byte_offset` without ever reaching for a per-source schema. See
 * `docs/INVARIANTS.md` I-9.
 *
 * Spec: plans/landed/2026-05-02-clod-ui-pr20a-transcript-route-v1.md §3.
 */
import type { TranscriptLine } from '@clod-ui/contracts';
import type { ManifestStore } from '@clod-ui/manifest';
import { readAllLines } from '@clod-ui/transcripts';
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';

import { getConversation } from '../db/index.ts';

export interface TranscriptRouteDeps {
  persistence: { store: ManifestStore; db: Database } | null;
  transcripts: { projectsDir: string } | null;
}

export function registerTranscriptRoutes(app: Hono, deps: TranscriptRouteDeps): void {
  app.get('/conversations/:id/transcript', async (c) => {
    const { persistence, transcripts } = deps;
    if (!persistence || !transcripts) {
      return c.json({ error: 'transcripts not configured' }, 404);
    }
    const conv_id = c.req.param('id');
    const row = getConversation(persistence.db, conv_id);
    if (!row) return c.json({ error: 'conversation not found' }, 404);

    const sessionId = row.claude_session_id ?? conv_id;
    let lines: TranscriptLine[] = [];
    try {
      lines = await readAllLines({
        projectsDir: transcripts.projectsDir,
        cwd: row.cwd,
        sessionId,
      });
    } catch (err) {
      // Read errors (permissions, transient I/O) surface as 500 rather than
      // empty 200 so the UI can distinguish 'no transcript yet' (200, lines:
      // []) from 'transcript exists but unreadable' (500).
      // eslint-disable-next-line no-console
      console.warn(`[engine] /conversations/${conv_id}/transcript: read failed`, err);
      return c.json({ error: 'transcript read failed' }, 500);
    }
    return c.json({ lines });
  });
}
