/**
 * `ConnectionBanner` — pure presentational banner over the event-stream
 * connection state (PR #22, Phase 7.4).
 *
 * Discriminated render over `SubscribeState` from the *same* subscription
 * that feeds the turn view (via `useTurnStream().connection`) — a separate
 * probe socket could report healthy while the real stream is down. Hidden
 * for `idle | connecting | open`; visible while the transport retries
 * (`reconnecting` — the launcher's restart-once means the engine usually
 * comes back) and after a clean close (`closed` — the transport will not
 * retry; a reload re-subscribes).
 *
 * Spec: plans/2026-06-10-clod-ui-pr22-crash-recovery-v1.md decision 7.
 */
import type { SubscribeState } from '@/lib/use-subscribe';
import { cn } from '@/lib/utils';

export interface ConnectionBannerProps {
  state: SubscribeState;
  className?: string;
}

export function ConnectionBanner({ state, className }: ConnectionBannerProps): JSX.Element | null {
  if (state.status !== 'reconnecting' && state.status !== 'closed') return null;

  const base = 'flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-sm font-medium';

  if (state.status === 'reconnecting') {
    return (
      <div
        className={cn(
          base,
          'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
          className,
        )}
        data-test="connection-banner"
        data-state="reconnecting"
        role="status"
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
        Engine connection lost — reconnecting…
      </div>
    );
  }

  return (
    <div
      className={cn(base, 'border-destructive/30 bg-destructive/10 text-destructive', className)}
      data-test="connection-banner"
      data-state="closed"
      role="status"
    >
      <span className="h-2 w-2 rounded-full bg-destructive" aria-hidden="true" />
      Disconnected from engine — reload once it&apos;s back.
    </div>
  );
}
