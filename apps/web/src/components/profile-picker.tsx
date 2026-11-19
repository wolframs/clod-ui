/**
 * `<ProfilePicker />` — the next new conversation's profile (PR #45), a
 * native select so a phone gets its own picker. `<ProfileLabel />` — the
 * small label a conversation on a non-default profile carries. Both pure
 * (I-4); the choice lives in `useProfiles`.
 *
 * Spec: plans/2026-11-05-clod-ui-pr45-profiles-v1.md §D8.
 */
import type { ProfileSummary } from '@clod-ui/contracts';
import type * as React from 'react';

import { cn } from '@/lib/utils';

export interface ProfileChoice {
  profiles: readonly ProfileSummary[];
  value: string;
  onChange: (id: string) => void;
}

export interface ProfilePickerProps extends ProfileChoice {
  className?: string | undefined;
}

export function ProfilePicker({
  profiles,
  value,
  onChange,
  className,
}: ProfilePickerProps): React.ReactElement {
  return (
    <select
      data-test="profile-picker"
      data-state={value}
      aria-label="Profile for new conversations"
      title="Profile for new conversations"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'min-w-0 rounded border border-input bg-background text-foreground shadow-sm',
        className,
      )}
    >
      {profiles.map((p) => (
        <option key={p.id} value={p.id} data-test="profile-option">
          {p.label}
        </option>
      ))}
    </select>
  );
}

export function ProfileLabel({
  label,
  className,
}: {
  label: string;
  className?: string | undefined;
}): React.ReactElement {
  return (
    <span
      data-test="profile-label"
      className={cn(
        'inline-flex max-w-full shrink-0 items-center truncate rounded border border-border bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground',
        className,
      )}
    >
      {label}
    </span>
  );
}
