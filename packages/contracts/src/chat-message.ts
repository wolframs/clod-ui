import { z } from 'zod';

/**
 * The UI-facing chat-message shape. Derived from CC's per-session JSONL
 * transcript by `@clod-ui/transcripts/normalize`.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 3.4 (second half).
 * IMPL: plans/landed/2026-04-24-clod-ui-pr9-chatmessage-normalization-v1.md.
 *
 * One JSONL line maps to at most one `ChatMessage`. The data preserves the
 * chronological structure of the on-disk transcript — folding `tool_result`s
 * into the prior assistant's `tool_use` blocks is a *rendering* decision and
 * lives in the UI, not in this primitive.
 */

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  text: z.string(),
  /** Cryptographic signature CC sometimes attaches; absent → key omitted. */
  signature: z.string().optional(),
});

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  tool_use_id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  /**
   * Body of the tool result. CC emits this as a string, an array of
   * `{type:'text', text}` blocks, or a structured object — we keep it as
   * `unknown` and let the renderer decide how to display each shape.
   */
  content: z.unknown(),
  /**
   * Required (not optional) so consumers don't have to guard with `?? false`.
   * The normalizer reads CC's `is_error: true | undefined` once and writes
   * `false` explicitly when absent.
   */
  is_error: z.boolean(),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

export const ChatRoleSchema = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageSchema = z.object({
  /** Stable identifier; deterministic from the source line_number. */
  id: z.string().min(1),
  role: ChatRoleSchema,
  content: z.array(ContentBlockSchema),
  /** Provenance: where in the JSONL this message came from. */
  source: z.object({
    line_number: z.number().int().nonnegative(),
    byte_offset: z.number().int().nonnegative(),
  }),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
