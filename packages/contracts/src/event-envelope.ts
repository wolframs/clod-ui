import { z } from 'zod';

/**
 * Envelope wrapping every message crossing the wire.
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md §"Wire Protocol".
 */
export const EventEnvelopeSchema = z.object({
  v: z.literal(1),
  id: z.string().uuid(),
  ts: z.number().int().nonnegative(),
  kind: z.string().min(1),
  conv_id: z.string().uuid().optional(),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
