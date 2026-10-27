import { z } from 'zod';

/**
 * Per-turn diagnostics wire shape (Phase 5.7, PR #32).
 *
 * Wire-only by I-8 — diagnostics live in a bounded in-memory ring on
 * the engine and are never persisted. `argv` arrives pre-redacted
 * (system-prompt values are length-only placeholders; redaction happens
 * at record time, engine-side). `event` carries the raw backend event
 * (minus turn_id) so "Copy repro" can feed a ScriptedBackend.
 */
export const TurnOutcomeSchema = z.object({
  kind: z.enum(['result', 'cancelled', 'error']),
  detail: z.string().optional(),
});

export const DiagnosticsEventSchema = z.object({
  ts: z.number(),
  kind: z.string(),
  event: z.unknown(),
});

export const TurnDiagnosticsSchema = z.object({
  turn_id: z.string(),
  conv_id: z.string(),
  started_at: z.number(),
  argv: z.array(z.string()),
  env_keys: z.array(z.string()),
  stdin_bytes: z.number(),
  cwd: z.string(),
  /**
   * PR #39: whether this turn spawned a CLI process or was fed to the
   * conversation's warm one (whose spawn argv is `argv`). Absent on rings
   * recorded before PR #39 and on backends that never keep a process warm.
   */
  process: z.enum(['spawned', 'reused']).optional(),
  events: z.array(DiagnosticsEventSchema),
  outcome: TurnOutcomeSchema.optional(),
});
export type TurnDiagnostics = z.infer<typeof TurnDiagnosticsSchema>;

export const DiagnosticsResponseSchema = z.object({
  turns: z.array(TurnDiagnosticsSchema),
});
export type DiagnosticsResponse = z.infer<typeof DiagnosticsResponseSchema>;
