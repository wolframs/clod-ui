import { z } from 'zod';

/**
 * Skills discovery wire shape (Phase 5.6 step 1, PR #31).
 *
 * Display-only by design: the CLI (2.1.175) resolves skills via
 * `/skill-name` in the prompt text and offers no per-skill argv, so the
 * engine lists what exists and nothing more. Enablement is
 * `TODO(skills-enablement)` at `ComposeResult.pendingSkills` in
 * `@clod-ui/backend`.
 */
export const SkillScopeSchema = z.enum(['user', 'project']);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillSummarySchema = z.object({
  /** Directory name — also the `/skill-name` invocation token. */
  name: z.string(),
  scope: SkillScopeSchema,
  /** Absolute path to the skill directory. */
  path: z.string(),
  /** Best-effort `description:` from SKILL.md frontmatter. */
  description: z.string().optional(),
});
export type SkillSummary = z.infer<typeof SkillSummarySchema>;

export const SkillsResponseSchema = z.object({
  skills: z.array(SkillSummarySchema),
});
export type SkillsResponse = z.infer<typeof SkillsResponseSchema>;
