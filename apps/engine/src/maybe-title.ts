/**
 * Auto-titling fire-and-forget worker. Called from the per-turn iterator
 * in `routes/turns.ts` on every terminator (turn.result / cancelled /
 * error / iterator throw).
 *
 * Pattern: read → fold → guard → titler.suggestTitle → re-read → re-fold
 * → re-guard → append + broadcast. The re-check after the external call
 * defends against a concurrent UI title-set racing the titler. Borrowed
 * from the double-check pattern in `recordSessionId` (PR #6).
 *
 * Failures inside this worker are silent (auto-titling is non-fatal
 * background work — never propagate to the user's turn). The next turn
 * naturally retries the title because `state.title` stays unset.
 *
 * Spec: plans/landed/2026-04-25-clod-ui-pr10-auto-titling-v1.md
 *       §Engine wiring.
 *
 * Invariants:
 *   - I-5 (fire-and-forget worker with double-check)
 *   - I-7 (manifest fold purity vs. engine policy)
 */
import type { EventEnvelope } from '@clod-ui/contracts';
import type { ManifestStore } from '@clod-ui/manifest';
import type { Database } from 'bun:sqlite';

import type { ConversationTitledEvent, Titler } from './titler.ts';
import { wrap, type EnvelopeIdSource } from './wire.ts';

export interface MaybeTitleArgs {
  titler: Titler;
  persistence: { store: ManifestStore; db: Database };
  convId: string;
  broadcast: (envelope: EventEnvelope) => void;
  envelopeIds: EnvelopeIdSource;
  user_message: string;
  assistant_text: string;
  ts: number;
}

export async function maybeTitle(args: MaybeTitleArgs): Promise<void> {
  const { titler, persistence, convId, broadcast, envelopeIds } = args;
  try {
    const events = await persistence.store.readAll(convId);
    const state = persistence.store.fold(events);
    if (state.title !== undefined) return;

    const title = await titler.suggestTitle({
      conv_id: convId,
      user_message: args.user_message,
      assistant_text: args.assistant_text,
      ts: args.ts,
    });
    if (typeof title !== 'string' || title.length === 0) return;

    // Re-check after the titler resolves — a concurrent title-set could
    // have raced us. Correctness requires a fresh manifest read, not a
    // cache.
    const freshEvents = await persistence.store.readAll(convId);
    const freshState = persistence.store.fold(freshEvents);
    if (freshState.title !== undefined) return;

    await persistence.store.appendEvent(convId, {
      kind: 'conversation.titled',
      title,
    });
    const titledEvent: ConversationTitledEvent = {
      kind: 'conversation.titled',
      conv_id: convId,
      title,
    };
    broadcast(wrap(envelopeIds.next(), titledEvent, convId));
  } catch {
    // Auto-titling is best-effort. A persistence failure here doesn't
    // break the user's turn (already broadcast) and the next turn will
    // retry the title (state.title still unset).
  }
}
