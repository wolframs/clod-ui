/**
 * `<MobileTopBar />` — the compact layout's header: menu, title, new.
 * Spec: plans/2026-11-01-clod-ui-pr44-mobile-v1.md.
 */
import type * as React from 'react';

import { ProfileLabel, ProfilePicker, type ProfileChoice } from '@/components/profile-picker';

export interface MobileTopBarProps {
  title: string;
  /** A turn is running in this conversation. */
  busy: boolean;
  onMenu: () => void;
  onNew: () => void;
  /** PR #45: the next new conversation's profile, beside ＋ (two or more profiles). */
  profileChoice?: ProfileChoice | undefined;
  /** PR #45: this conversation's profile label (non-default profiles only). */
  profileLabel?: string | undefined;
}

const ICON_BUTTON =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl text-foreground active:bg-accent';

export function MobileTopBar({
  title,
  busy,
  onMenu,
  onNew,
  profileChoice,
  profileLabel,
}: MobileTopBarProps): React.ReactElement {
  return (
    <header
      data-test="mobile-top-bar"
      data-state={busy ? 'busy' : 'idle'}
      className="flex shrink-0 items-center gap-1 border-b border-border bg-background px-1 pb-1 pt-[max(var(--safe-top),0.25rem)]"
    >
      <button
        data-test="mobile-menu"
        type="button"
        aria-label="Open menu"
        onClick={onMenu}
        className={ICON_BUTTON}
      >
        ☰
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="truncate text-[15px] font-medium text-foreground">{title}</h1>
        {profileLabel !== undefined ? (
          <ProfileLabel label={profileLabel} className="self-start" />
        ) : null}
      </div>
      {busy ? (
        <span
          className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
          aria-label="A turn is running"
        />
      ) : null}
      {profileChoice ? (
        <ProfilePicker {...profileChoice} className="h-9 max-w-[7rem] px-1.5 text-sm" />
      ) : null}
      <button
        data-test="mobile-new"
        type="button"
        aria-label="New conversation"
        onClick={onNew}
        className={ICON_BUTTON}
      >
        ＋
      </button>
    </header>
  );
}
