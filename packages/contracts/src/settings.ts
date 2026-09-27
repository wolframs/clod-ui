import { z } from 'zod';

/**
 * Claude Code's `~/.claude/settings.json` shape.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 3.6.
 * IMPL: plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md.
 *
 * Documented keys are typed and validated; everything else lands in the
 * `unknown` passthrough bucket so we never drop user fields on round-trip.
 * The IO layer flattens this bucket back to top-level on disk, so the
 * `settings.json` file looks exactly like an ordinary CC settings file.
 */
export const ClaudeThemeSchema = z.enum(['light', 'dark', 'system']);
export type ClaudeTheme = z.infer<typeof ClaudeThemeSchema>;

export const ClaudeSettingsSchema = z
  .object({
    theme: ClaudeThemeSchema.optional(),
    model: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    /** Verbatim passthrough of any keys we do not explicitly model. */
    unknown: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;

/** The set of top-level keys we explicitly model (everything else → unknown). */
export const DOCUMENTED_SETTINGS_KEYS = [
  'theme',
  'model',
  'allowedTools',
  'disallowedTools',
] as const satisfies readonly (keyof ClaudeSettings)[];
