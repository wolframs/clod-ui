/**
 * `GET /conversations` route registrar.
 *
 * Opt-in via persistence (mirrors /settings precedent): 404
 * `{ error: 'conversations not configured' }` when the engine runs
 * memory-only. Pipeline:
 *
 *   1. listConversations(db) → rows in created_at DESC.
 *   2. For each row: store.readAll + store.fold → state.title +
 *      max(events.ts) → updated_at (fallback to created_at on empty).
 *   3. Sort by updated_at DESC, created_at DESC, conv_id ASC.
 *   4. Return wrapped: { conversations: ConversationSummary[] }.
 *
 * Spec: plans/landed/2026-04-27-clod-ui-pr12-conversations-list-v1.md.
 */
import type { ConversationSummary } from '@clod-ui/contracts';
import type { ManifestStore } from '@clod-ui/manifest';
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';

import { listConversations } from '../db/index.ts';

export interface ConversationsRouteDeps {
  persistence: { store: ManifestStore; db: Database } | null;
}

export function registerConversationsRoutes(app: Hono, deps: ConversationsRouteDeps): void {
  app.get('/conversations', async (c) => {
    const { persistence } = deps;
    if (!persistence) return c.json({ error: 'conversations not configured' }, 404);
    const rows = listConversations(persistence.db);
    const summaries: ConversationSummary[] = [];
    for (const row of rows) {
      let updated_at = row.created_at;
      let title: string | undefined;
      try {
        const events = await persistence.store.readAll(row.id);
        const last = events[events.length - 1];
        if (last) updated_at = last.ts;
        const state = persistence.store.fold(events);
        title = state.title;
      } catch {
        // TODO(degraded-conversations): surface unreadable manifests as a
        // typed warning entry so the UI can render an inline marker.
        // For now, log-and-skip — one bad manifest must not 500 the sidebar.
        // eslint-disable-next-line no-console
        console.warn(`[engine] /conversations: skipping ${row.id} (manifest unreadable)`);
        continue;
      }
      const summary: ConversationSummary = {
        conv_id: row.id,
        created_at: row.created_at,
        updated_at,
        ...(title !== undefined ? { title } : {}),
        ...(row.claude_session_id ? { claude_session_id: row.claude_session_id } : {}),
      };
      summaries.push(summary);
    }
    summaries.sort((a, b) => {
      if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
      if (b.created_at !== a.created_at) return b.created_at - a.created_at;
      return a.conv_id < b.conv_id ? -1 : a.conv_id > b.conv_id ? 1 : 0;
    });
    return c.json({ conversations: summaries });
  });
}
