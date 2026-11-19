/**
 * `Sidebar` — pure presentational list of conversations.
 *
 * Five render variants discriminated on `state.status`:
 *   - loading           → three muted skeleton bars.
 *   - ok (empty list)   → "No conversations yet" hint.
 *   - ok (non-empty)    → one row per ConversationSummary, sorted by
 *                         updated_at desc (the engine already does this;
 *                         we render in array order).
 *   - error             → red treatment, ClientError.message visible.
 *   - not_configured    → muted info card mentioning `--persist`.
 *
 * `data-test="sidebar"` and `data-state` markers on the outer element
 * decouple test assertions from styling.
 *
 * Spec: plans/landed/2026-04-29-clod-ui-pr16-sidebar-v1.md §Surface.
 */
import type { ConversationSummary } from '@clod-ui/contracts';
import type * as React from 'react';

import { ProfileLabel, ProfilePicker, type ProfileChoice } from '@/components/profile-picker';
import { relativeTime } from '@/lib/relative-time';
import type { ConversationsState } from '@/lib/use-conversations';
import { cn } from '@/lib/utils';

export interface SidebarProps {
  state: ConversationsState;
  selectedId?: string | undefined;
  onSelect: (conv_id: string) => void;
  /**
   * When provided, renders a "+ New" button in the header. Clicking calls
   * `onNew()`; the callback owns conv_id generation + selection. When
   * undefined, the button is omitted.
   *
   * Spec: plans/landed/2026-05-02-clod-ui-pr19-composer-v1.md §2 ("+ New").
   */
  onNew?: () => void;
  /**
   * Optional `now` override for the relative-time labels. Tests pass a
   * frozen value so render output is deterministic; production callers
   * leave it undefined and `relativeTime` falls back to `Date.now()`.
   */
  now?: number | undefined;
  /** Phone layout: the sidebar is a drawer, with touch-sized rows. */
  compact?: boolean | undefined;
  /** Compact only: the drawer's close button. */
  onClose?: (() => void) | undefined;
  /** Compact only: pinned under the list (what the desktop footer holds). */
  footer?: React.ReactNode;
  /**
   * PR #45: the next new conversation's profile, shown beside "+ New".
   * Passed only when there are two or more profiles.
   */
  profileChoice?: ProfileChoice | undefined;
  /** PR #45: a row's profile label (non-default profiles only). */
  profileLabelOf?: ((conv: ConversationSummary) => string | undefined) | undefined;
  className?: string | undefined;
}

const SHELL =
  'flex h-full w-full flex-col gap-1 overflow-hidden border-r border-border bg-muted/30';

export function Sidebar({
  state,
  selectedId,
  onSelect,
  onNew,
  now,
  compact = false,
  onClose,
  footer,
  profileChoice,
  profileLabelOf,
  className,
}: SidebarProps): JSX.Element {
  const footerNode =
    footer !== undefined ? <div className="mt-auto shrink-0 border-t p-2">{footer}</div> : null;
  const header = compact ? (
    <div className="shrink-0 px-2 pt-[max(var(--safe-top),0.5rem)]">
      <div className="flex items-center justify-between pl-2">
        <span className="text-lg font-semibold tracking-tight text-foreground">Clod UI</span>
        <button
          type="button"
          data-test="sidebar-close"
          aria-label="Close menu"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-full text-lg text-foreground active:bg-accent"
        >
          ✕
        </button>
      </div>
      {onNew && (
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            data-test="sidebar-new"
            onClick={onNew}
            className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted px-3 text-[15px] font-medium text-foreground active:bg-accent"
          >
            ＋ New conversation
          </button>
          {profileChoice ? (
            <ProfilePicker {...profileChoice} className="h-11 max-w-[40%] px-2 text-[15px]" />
          ) : null}
        </div>
      )}
      <div className="px-2 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Conversations
      </div>
    </div>
  ) : (
    <div className="flex items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span>Conversations</span>
      {onNew && (
        <div className="flex min-w-0 items-center gap-1.5 normal-case">
          {profileChoice ? (
            <ProfilePicker {...profileChoice} className="max-w-[9rem] px-1 py-0.5 text-xs" />
          ) : null}
          <button
            type="button"
            data-test="sidebar-new"
            onClick={onNew}
            className="shrink-0 whitespace-nowrap rounded border border-input bg-background px-2 py-0.5 text-xs font-medium normal-case text-foreground shadow-sm hover:bg-accent"
            title="Start a new conversation"
          >
            + New
          </button>
        </div>
      )}
    </div>
  );

  if (state.status === 'loading') {
    return (
      <aside
        className={cn(SHELL, className)}
        data-test="sidebar"
        data-state="loading"
        aria-busy="true"
      >
        {header}
        <div className="flex flex-col gap-2 px-3" aria-label="Loading conversations">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
        {footerNode}
      </aside>
    );
  }

  if (state.status === 'error') {
    return (
      <aside className={cn(SHELL, className)} data-test="sidebar" data-state="error">
        {header}
        <div
          className="mx-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          <div className="font-medium">Couldn't load conversations</div>
          <div className="mt-1 break-words text-xs opacity-80" title={state.error.message}>
            {state.error.message}
          </div>
        </div>
        {footerNode}
      </aside>
    );
  }

  if (state.status === 'not_configured') {
    return (
      <aside className={cn(SHELL, className)} data-test="sidebar" data-state="not_configured">
        {header}
        <div className="mx-3 rounded-md border border-border bg-card p-3 text-sm text-muted-foreground">
          <div className="font-medium text-foreground">Persistence is off</div>
          <p className="mt-1 text-xs">
            Restart the engine with{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-foreground">--persist</code> to
            enable saved conversations.
          </p>
        </div>
        {footerNode}
      </aside>
    );
  }

  // status === 'ok'
  if (state.conversations.length === 0) {
    return (
      <aside className={cn(SHELL, className)} data-test="sidebar" data-state="empty">
        {header}
        <div className="mx-3 rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          <div className="font-medium text-foreground">No conversations yet</div>
          <p className="mt-1 text-xs">Submit a turn in the main pane to start your first one.</p>
        </div>
        {footerNode}
      </aside>
    );
  }

  return (
    <aside className={cn(SHELL, className)} data-test="sidebar" data-state="list">
      {header}
      <ul
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pb-3"
        role="listbox"
        aria-label="Conversations"
      >
        {state.conversations.map((conv) => (
          <SidebarRow
            key={conv.conv_id}
            conv={conv}
            selected={conv.conv_id === selectedId}
            onSelect={onSelect}
            now={now}
            compact={compact}
            profileLabel={profileLabelOf?.(conv)}
          />
        ))}
      </ul>
      {footerNode}
    </aside>
  );
}

interface SidebarRowProps {
  conv: ConversationSummary;
  selected: boolean;
  onSelect: (conv_id: string) => void;
  now?: number | undefined;
  compact: boolean;
  profileLabel?: string | undefined;
}

function SidebarRow({
  conv,
  selected,
  onSelect,
  now,
  compact,
  profileLabel,
}: SidebarRowProps): JSX.Element {
  const timeLabel = relativeTime(conv.updated_at, now);
  const titleNode = conv.title ? (
    <span
      className={cn('truncate font-medium text-foreground', compact ? 'text-[15px]' : 'text-sm')}
    >
      {conv.title}
    </span>
  ) : (
    <span
      className={cn(
        'truncate font-medium italic text-muted-foreground',
        compact ? 'text-[15px]' : 'text-sm',
      )}
    >
      untitled
    </span>
  );

  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        data-test="sidebar-row"
        data-conv-id={conv.conv_id}
        data-selected={selected ? 'true' : 'false'}
        onClick={() => onSelect(conv.conv_id)}
        className={cn(
          'flex w-full items-start gap-2 rounded-md border-l-2 px-3 text-left transition-colors',
          compact ? 'py-2.5' : 'py-2',
          'hover:bg-accent hover:text-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'border-l-primary bg-accent text-accent-foreground' : 'border-l-transparent',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          {titleNode}
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {profileLabel !== undefined ? <ProfileLabel label={profileLabel} /> : null}
            <span className="truncate">{timeLabel}</span>
          </span>
        </div>
      </button>
    </li>
  );
}
