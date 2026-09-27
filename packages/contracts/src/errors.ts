import { z } from 'zod';

/**
 * Error taxonomy per plans/2026-04-23-clod-ui-architecture-v2.md Task 2.6.
 * Each kind is a discrete schema; the discriminated union is the public surface.
 */

const baseFields = {
  retryable: z.boolean(),
  detail: z.string().optional(),
  raw_stderr: z.string().optional(),
};

export const AuthFailedErrorSchema = z.object({ kind: z.literal('auth_failed'), ...baseFields });
export const RateLimitedErrorSchema = z.object({
  kind: z.literal('rate_limited'),
  retry_after_ms: z.number().int().nonnegative().optional(),
  ...baseFields,
});
export const ModelUnavailableErrorSchema = z.object({
  kind: z.literal('model_unavailable'),
  model: z.string().optional(),
  ...baseFields,
});
export const ToolDeniedErrorSchema = z.object({
  kind: z.literal('tool_denied'),
  tool: z.string().optional(),
  ...baseFields,
});
export const McpUnreachableErrorSchema = z.object({
  kind: z.literal('mcp_unreachable'),
  server: z.string().optional(),
  ...baseFields,
});
export const CliMissingErrorSchema = z.object({ kind: z.literal('cli_missing'), ...baseFields });
export const CliUnauthenticatedErrorSchema = z.object({
  kind: z.literal('cli_unauthenticated'),
  ...baseFields,
});
export const CliCrashedErrorSchema = z.object({
  kind: z.literal('cli_crashed'),
  exit_code: z.number().int().optional(),
  signal: z.string().optional(),
  ...baseFields,
});
export const TranscriptCorruptErrorSchema = z.object({
  kind: z.literal('transcript_corrupt'),
  line: z.number().int().nonnegative().optional(),
  ...baseFields,
});
export const UnknownErrorSchema = z.object({ kind: z.literal('unknown'), ...baseFields });

export const ClodErrorSchema = z.discriminatedUnion('kind', [
  AuthFailedErrorSchema,
  RateLimitedErrorSchema,
  ModelUnavailableErrorSchema,
  ToolDeniedErrorSchema,
  McpUnreachableErrorSchema,
  CliMissingErrorSchema,
  CliUnauthenticatedErrorSchema,
  CliCrashedErrorSchema,
  TranscriptCorruptErrorSchema,
  UnknownErrorSchema,
]);

export type ClodError = z.infer<typeof ClodErrorSchema>;
export type ClodErrorKind = ClodError['kind'];
