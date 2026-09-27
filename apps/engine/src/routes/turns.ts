/**
 * `POST /conversations/:id/turns` route registrar.
 *
 * The richest route in the engine. Choreographs:
 *
 *   - Persistence provisioning (PR #6): cwd anchoring + resume_session_id
 *     injection on first turn.
 *   - Concurrent-send rejection (T1.08): only one active turn per conv;
 *     409 with `{ kind: 'conversation_busy', active_turn_id }` otherwise.
 *   - Streaming via fire-and-forget into the broadcast sink. The HTTP
 *     response just acknowledges acceptance (202).
 *   - Session-id capture (PR #6): on first `system.init`, persists the
 *     `claude_session_id` to SQLite + manifest via `recordSessionId`.
 *   - Transcript watcher start (PR #7): on first `system.init`, idempotent.
 *   - Auto-titling (PR #10): per-turn accumulators capture
 *     `user_message` + assistant deltas; on every terminator
 *     (turn.result/cancelled/error/throw), `maybeTitle` fires.
 *   - Iterator-throw classification (PR #5): backend errors → typed
 *     `turn.error` envelope via `classifyCliFailure`.
 *
 * Invariants exercised here:
 *   - I-2 (envelopes the only wire reality)
 *   - I-5 (fire-and-forget worker with double-check) via maybeTitle
 *   - I-6 (atomic IO) via persistence's manifest appends
 *   - I-7 (manifest fold purity) via auto-title invariants in maybeTitle
 *
 * Spec sources: plans/landed/{pr4,pr5,pr6,pr7,pr10}-*.md.
 */
import type { ClaudeBackend } from '@clod-ui/backend';
import { classifyCliFailure } from '@clod-ui/backend';
import type { EventEnvelope } from '@clod-ui/contracts';
import type { ManifestStore } from '@clod-ui/manifest';
import type { TranscriptUpdatedEvent } from '@clod-ui/transcripts';
import { TranscriptWatcher } from '@clod-ui/transcripts';
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';

import { getConversation } from '../db/index.ts';
import { maybeTitle } from '../maybe-title.ts';
import { parseTurnBody } from '../parse-turn-body.ts';
import { ensureProvisioned, recordSessionId } from '../provisioning.ts';
import type { Titler } from '../titler.ts';
import type { EnvelopeIdSource } from '../wire.ts';
import { wrap } from '../wire.ts';

export interface TranscriptOptions {
  projectsDir: string;
  pollIntervalMs?: number;
  debounceMs?: number;
}

export interface TurnsRouteDeps {
  backend: ClaudeBackend;
  envelopeIds: EnvelopeIdSource;
  /** Live broadcast sink. Re-resolved per-event so swap-after-construction works. */
  getBroadcast: () => (envelope: EventEnvelope) => void;
  /** turn_id → conv_id; shared with cancelAll(). */
  activeTurns: Map<string, string>;
  /** conv_id → active turn_id; used to 409 concurrent sends. */
  activeTurnByConv: Map<string, string>;
  /** conv_id → live transcript watcher; shared with cancelAll(). */
  watchers: Map<string, TranscriptWatcher>;
  persistence: { store: ManifestStore; db: Database } | null;
  transcripts: TranscriptOptions | null;
  titler: Titler | null;
}

export function registerTurnRoutes(app: Hono, deps: TurnsRouteDeps): void {
  const {
    backend,
    envelopeIds,
    getBroadcast,
    activeTurns,
    activeTurnByConv,
    watchers,
    persistence,
    transcripts,
    titler,
  } = deps;
  /** turn_id → assistant text accumulated from deltas. Cleared on terminator. */
  const turnAssistantText = new Map<string, string>();
  /** turn_id → user_message captured from the request. Cleared on terminator. */
  const turnUserMessage = new Map<string, string>();

  app.post('/conversations/:id/turns', async (c) => {
    const convId = c.req.param('id');
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = parseTurnBody(convId, body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const req = parsed.value;

    // Persistence: provision the conversation directory + DB row on first
    // turn, and inject a known claude_session_id as resume_session_id when
    // the caller didn't already supply one.
    if (persistence) {
      try {
        const prov = await ensureProvisioned(persistence, { convId });
        // Re-anchor the spawn cwd to the conversation's directory so
        // attachments + tool calls land in the right place.
        req.cwd = prov.cwd;
        if (req.resume_session_id === undefined) {
          const row = getConversation(persistence.db, convId);
          if (row?.claude_session_id) {
            req.resume_session_id = row.claude_session_id;
          }
        }
      } catch (err) {
        return c.json({ error: { kind: 'provisioning_failed', detail: String(err) } }, 500);
      }
    }

    // Concurrent-send rejection: only one active turn per conversation.
    const existingTurn = activeTurnByConv.get(convId);
    if (existingTurn !== undefined) {
      return c.json(
        {
          error: {
            kind: 'conversation_busy',
            active_turn_id: existingTurn,
          },
        },
        409,
      );
    }

    activeTurns.set(req.turn_id, convId);
    activeTurnByConv.set(convId, req.turn_id);
    // Auto-titling: capture the user_message at request time so the titler
    // can derive a title even if the turn ends before any assistant text is
    // produced (cancelled / error path).
    if (titler) {
      turnUserMessage.set(req.turn_id, req.user_message);
      turnAssistantText.set(req.turn_id, '');
    }

    // Fire-and-forget stream into connected sockets; the HTTP response just
    // acknowledges acceptance.
    void (async () => {
      try {
        for await (const ev of backend.startTurn(req)) {
          // Persistence intercept: capture session_id on first init.
          if (persistence && ev.kind === 'system.init') {
            try {
              await recordSessionId(persistence, {
                convId,
                session_id: ev.session_id,
              });
            } catch {
              // Persistence failures are non-fatal for the in-flight turn;
              // the envelope still flows so the user sees their answer.
            }
            // Transcript watcher: start on first session.captured, idempotent
            // for re-emitted system.init on subsequent turns.
            if (transcripts && !watchers.has(convId)) {
              const row = getConversation(persistence.db, convId);
              if (row?.cwd) {
                const watcher = new TranscriptWatcher({
                  conv_id: convId,
                  session_id: ev.session_id,
                  cwd: row.cwd,
                  projectsDir: transcripts.projectsDir,
                  ...(transcripts.pollIntervalMs !== undefined
                    ? { pollIntervalMs: transcripts.pollIntervalMs }
                    : {}),
                  ...(transcripts.debounceMs !== undefined
                    ? { debounceMs: transcripts.debounceMs }
                    : {}),
                  onUpdate: (event: TranscriptUpdatedEvent) => {
                    getBroadcast()(wrap(envelopeIds.next(), event, convId));
                  },
                });
                watcher.start();
                watchers.set(convId, watcher);
              }
            }
          }
          // Auto-titling: accumulate assistant text.
          if (titler && persistence && ev.kind === 'assistant.delta') {
            const prev = turnAssistantText.get(req.turn_id) ?? '';
            turnAssistantText.set(req.turn_id, prev + ev.text);
          }
          getBroadcast()(wrap(envelopeIds.next(), ev, convId));
          if (
            titler &&
            persistence &&
            (ev.kind === 'turn.result' || ev.kind === 'turn.cancelled' || ev.kind === 'turn.error')
          ) {
            const userMessage = turnUserMessage.get(req.turn_id) ?? '';
            const assistantText = turnAssistantText.get(req.turn_id) ?? '';
            void maybeTitle({
              titler,
              persistence,
              convId,
              broadcast: getBroadcast(),
              envelopeIds,
              user_message: userMessage,
              assistant_text: assistantText,
              ts: Date.now(),
            });
            turnUserMessage.delete(req.turn_id);
            turnAssistantText.delete(req.turn_id);
          }
        }
      } catch (err) {
        // The backend iterator threw — route through the classifier so the
        // error envelope carries the right kind / retryable flag.
        const refined = classifyCliFailure({
          ...(err instanceof Error ? { raw_stderr: err.message } : {}),
        });
        getBroadcast()(
          wrap(
            envelopeIds.next(),
            {
              kind: 'turn.error',
              turn_id: req.turn_id,
              error: refined,
            },
            convId,
          ),
        );
        // Auto-title even on iterator throw: the user typed *something*, so
        // a fallback-derived title is still meaningful.
        if (titler && persistence) {
          const userMessage = turnUserMessage.get(req.turn_id) ?? '';
          const assistantText = turnAssistantText.get(req.turn_id) ?? '';
          void maybeTitle({
            titler,
            persistence,
            convId,
            broadcast: getBroadcast(),
            envelopeIds,
            user_message: userMessage,
            assistant_text: assistantText,
            ts: Date.now(),
          });
        }
      } finally {
        activeTurns.delete(req.turn_id);
        if (activeTurnByConv.get(convId) === req.turn_id) {
          activeTurnByConv.delete(convId);
        }
        turnUserMessage.delete(req.turn_id);
        turnAssistantText.delete(req.turn_id);
      }
    })();
    return c.json({ accepted: true }, 202);
  });
}
