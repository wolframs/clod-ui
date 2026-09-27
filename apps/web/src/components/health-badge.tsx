/**
 * `HealthBadge` — pure presentational badge for the engine's `/health` state.
 *
 * Discriminated render over `HealthState` from `useHealth`. No data fetching
 * here; purely styling + conditional content. Three variants: loading
 * (muted), ok (green), error (red).
 *
 * Spec: plans/landed/2026-04-29-clod-ui-pr14-engine-provider-v1.md §4.
 */
import type { HealthState } from '@/lib/use-health';
import { cn } from '@/lib/utils';

const ERROR_MESSAGE_CAP = 80;

export interface HealthBadgeProps {
  state: HealthState;
  className?: string;
}

export function HealthBadge({ state, className }: HealthBadgeProps): JSX.Element {
  const base = 'inline-flex items-center gap-2 rounded-md px-3 py-1 text-sm font-medium';

  if (state.status === 'loading') {
    return (
      <span
        className={cn(base, 'bg-muted text-muted-foreground', className)}
        data-test="health-badge"
        data-state="loading"
      >
        <span
          className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground"
          aria-hidden="true"
        />
        Connecting…
      </span>
    );
  }

  if (state.status === 'ok') {
    const versionFragment = state.health.version ? ` · v${state.health.version}` : '';
    return (
      <span
        className={cn(base, 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400', className)}
        data-test="health-badge"
        data-state="ok"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
        Engine OK{versionFragment}
      </span>
    );
  }

  const message = state.error.message ?? 'Engine error';
  const truncated =
    message.length > ERROR_MESSAGE_CAP ? message.slice(0, ERROR_MESSAGE_CAP - 1) + '…' : message;
  return (
    <span
      className={cn(base, 'bg-destructive/10 text-destructive dark:text-red-400', className)}
      data-test="health-badge"
      data-state="error"
      title={message}
    >
      <span className="h-2 w-2 rounded-full bg-destructive" aria-hidden="true" />
      {truncated}
    </span>
  );
}
