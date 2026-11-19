/**
 * Conversation profiles in the web app (PR #45) — pure helpers. Which
 * profile the next new conversation takes, whether the page offers a
 * choice, which label a conversation shows, and what a turn's body names.
 *
 * Spec: plans/2026-11-05-clod-ui-pr45-profiles-v1.md §D8.
 */
import type { ProfilesResponse } from '@clod-ui/contracts';

/** localStorage key of the next new conversation's profile. */
export const NEXT_PROFILE_KEY = 'clod-ui.next-profile';

/** The stored choice when the registry still holds it, else the registry default. */
export function chooseNextProfile(
  stored: string | null | undefined,
  res: ProfilesResponse,
): string {
  return stored != null && res.profiles.some((p) => p.id === stored) ? stored : res.default;
}

/** One profile means no choice: the page looks as it did before profiles. */
export function hasProfileChoice(res: ProfilesResponse | undefined): res is ProfilesResponse {
  return res !== undefined && res.profiles.length >= 2;
}

/**
 * The small label a conversation carries: only for a profile other than the
 * registry default. A profile the registry no longer has shows its id.
 * Undefined profile = the engine's implicit one, which carries none.
 */
export function profileLabelFor(
  profile: string | undefined,
  res: ProfilesResponse | undefined,
): string | undefined {
  if (profile === undefined || res === undefined || profile === res.default) return undefined;
  return res.profiles.find((p) => p.id === profile)?.label ?? profile;
}

/**
 * The profile a turn's body names. A conversation the engine already lists
 * is fixed (none sent); one this tab started keeps what its first turn sent;
 * otherwise the next-conversation choice — and only when there is a choice.
 */
export function profileForTurn(args: {
  listed: boolean;
  sent: string | undefined;
  next: string | undefined;
  choice: boolean;
}): string | undefined {
  if (args.listed) return undefined;
  if (args.sent !== undefined) return args.sent;
  return args.choice ? args.next : undefined;
}
