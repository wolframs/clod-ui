import { z } from 'zod';

import { ThinkingEffortSchema } from './turn.ts';

/**
 * Model list wire shape (PR #42): what the CLI itself reports in its reply
 * to the stream-json `initialize` control request, reduced to the fields
 * the UI uses.
 *
 * Spec: plans/landed/2026-10-27-clod-ui-pr42-models-and-effort-v1.md §2–§3.
 */
export const ModelInfoSchema = z.object({
  /** What `--model` takes: an alias (`opus`), a full id, or `default`. */
  value: z.string(),
  /** The model id the value currently resolves to. */
  resolved_model: z.string().optional(),
  display_name: z.string(),
  description: z.string().optional(),
  /** `--effort` levels this model takes; absent = no effort control. */
  effort_levels: z.array(ThinkingEffortSchema).optional(),
  supports_thinking_off: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ModelsResponseSchema = z.object({
  models: z.array(ModelInfoSchema),
  /** Epoch ms of the CLI probe this list came from. */
  fetched_at: z.number(),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
