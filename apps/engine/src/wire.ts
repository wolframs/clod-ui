/**
 * Wire-layer helpers shared between createApp and per-route registrars.
 *
 * - `wrap()` is the canonical envelope constructor. Every event that
 *   crosses the WS boundary passes through it.
 * - `EnvelopeIdSource` produces deterministic, monotonic envelope IDs
 *   suitable for both production and replay-buffer reasoning. Each
 *   `createApp` call gets its own instance.
 *
 * Keeping these in one tiny module means routes/turns.ts and
 * maybe-title.ts can both import them without circular dependencies.
 */
import type { BackendEvent } from '@clod-ui/backend';
import type { EventEnvelope } from '@clod-ui/contracts';
import type { TranscriptUpdatedEvent } from '@clod-ui/transcripts';

import type { ConversationTitledEvent } from './titler.ts';

/**
 * Wrap any engine-internal event into the canonical `EventEnvelope`
 * shape consumers see on the wire. The `kind` is forwarded verbatim
 * from the inner event so consumers can discriminate on it.
 */
export function wrap(
  id: string,
  ev: BackendEvent | TranscriptUpdatedEvent | ConversationTitledEvent,
  convId: string,
): EventEnvelope {
  return {
    v: 1,
    id,
    ts: Date.now(),
    kind: ev.kind,
    conv_id: convId,
    payload: ev,
  };
}

/**
 * Monotonic envelope ID source. Per-app-instance, so two engines
 * sharing nothing else can't collide. Tests compare IDs as strings;
 * production stores them in the replay buffer.
 */
export class EnvelopeIdSource {
  private counter = 0;
  next(): string {
    this.counter++;
    const hex = this.counter.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
  }
}
