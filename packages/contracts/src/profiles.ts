import { z } from 'zod';

/**
 * Conversation profiles (PR #45): which binary runs a conversation's turns
 * and in which directory. The registry with paths lives on the engine;
 * the wire carries only ids and labels.
 *
 * Spec: plans/2026-11-05-clod-ui-pr45-profiles-v1.md §D7.
 */
export const PROFILE_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

export const ProfileIdSchema = z.string().regex(PROFILE_ID_PATTERN);

export const ProfileSummarySchema = z.object({
  id: ProfileIdSchema,
  label: z.string().min(1),
});
export type ProfileSummary = z.infer<typeof ProfileSummarySchema>;

/**
 * `GET /profiles`. `default` is the profile a new conversation takes when
 * the turn names none. `warning` says why the registry file was not taken
 * (the engine keeps the last good one); absent when the file is fine.
 */
export const ProfilesResponseSchema = z.object({
  default: ProfileIdSchema,
  profiles: z.array(ProfileSummarySchema).min(1),
  warning: z.string().optional(),
});
export type ProfilesResponse = z.infer<typeof ProfilesResponseSchema>;
