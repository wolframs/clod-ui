/**
 * Conversations list — sidebar projection of the conversations table fused
 * with the manifest fold's `title`.
 *
 * Spec: plans/landed/2026-04-27-clod-ui-pr12-conversations-list-v1.md §2.
 */
import { z } from 'zod';

/**
 * Single conversation entry as projected for the sidebar.
 *
 * - `conv_id` — primary key, mirrors the URL the UI uses.
 * - `title` — `state.title` from the manifest fold; absent until auto-titling
 *   has fired (or never, if the first turn errored before any text).
 * - `created_at` — authoritative SQLite-row timestamp from `ensureProvisioned`.
 * - `updated_at` — `max(events.ts)` over the manifest, falling back to
 *   `created_at` on an empty manifest.
 * - `claude_session_id` — mirror of the SQLite column; populated after the
 *   first `system.init`.
 */
export const ConversationSummarySchema = z.object({
  conv_id: z.string().min(1),
  title: z.string().optional(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  claude_session_id: z.string().optional(),
});

export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

/**
 * `GET /conversations` response shape. Wrapped (not a bare array) so future
 * pagination (`next_page_token`, `total_count`) lands without a wire-shape
 * break.
 */
export const ConversationsListResponseSchema = z.object({
  conversations: z.array(ConversationSummarySchema),
});

export type ConversationsListResponse = z.infer<typeof ConversationsListResponseSchema>;
