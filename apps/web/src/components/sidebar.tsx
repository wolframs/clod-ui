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
  className,
}: SidebarProps): JSX.Element {
  const header = (
    <div className="flex items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span>Conversations</span>
      {onNew && (
        <button
          type="button"
          data-test="sidebar-new"
          onClick={onNew}
          className="rounded border border-input bg-background px-2 py-0.5 text-xs font-medium normal-case text-foreground shadow-sm hover:bg-accent"
          title="Start a new conversation"
        >
          + New
        </button>
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
      </aside>
    );
  }

  return (
    <aside className={cn(SHELL, className)} data-test="sidebar" data-state="list">
      {header}
      <ul
        className="flex flex-col gap-0.5 overflow-y-auto px-2 pb-3"
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
          />
        ))}
      </ul>
    </aside>
  );
}

interface SidebarRowProps {
  conv: ConversationSummary;
  selected: boolean;
  onSelect: (conv_id: string) => void;
  now?: number | undefined;
}

function SidebarRow({ conv, selected, onSelect, now }: SidebarRowProps): JSX.Element {
  const timeLabel = relativeTime(conv.updated_at, now);
  const titleNode = conv.title ? (
    <span className="truncate text-sm font-medium text-foreground">{conv.title}</span>
  ) : (
    <span className="truncate text-sm font-medium italic text-muted-foreground">untitled</span>
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
          'flex w-full items-start gap-2 rounded-md border-l-2 px-3 py-2 text-left transition-colors',
          'hover:bg-accent hover:text-accent-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected ? 'border-l-primary bg-accent text-accent-foreground' : 'border-l-transparent',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          {titleNode}
          <span className="mt-0.5 truncate text-xs text-muted-foreground">{timeLabel}</span>
        </div>
      </button>
    </li>
  );
}
