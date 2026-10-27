/**
 * `TurnView` — pure presentational projection of a `TurnState` from
 * `useTurnStream` (PR #18b). Renders the active or most-recently-completed
 * turn as a stack of typed sub-components: assistant text, thinking block,
 * tool cards, status pill, and per-status add-ons (usage badge / error
 * panel / escalation).
 *
 * Presentational with one interactive concession: ToolCard owns a single
 * `useState` for its collapse toggle (PR #18d.3, Invariant I-4 — state
 * enters only when interactivity forces it). Virtualization is still
 * deferred (named TODO below).
 *
 * Spec: plans/landed/2026-05-02-clod-ui-pr18c-turn-view-v1.md.
 */
import type { ClodError } from '@clod-ui/contracts';
import { useState } from 'react';

import { Markdown } from '@/components/markdown';
import type { ToolCall, TurnState, TurnUsage } from '@/lib/turn-reducer';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export interface TurnViewProps {
  state: TurnState;
  className?: string | undefined;
}

export function TurnView({ state, className }: TurnViewProps): JSX.Element {
  if (state.status === 'idle') {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center text-sm text-muted-foreground',
          className,
        )}
        data-test="turn-view"
        data-state="idle"
        data-turn-id=""
      >
        <p>Waiting for the next turn…</p>
      </div>
    );
  }

  return (
    <div
      // Scroll-agnostic since PR #18d.1: the single scroll container lives in
      // App.tsx; this view renders at natural height below TranscriptHistory.
      className={cn('flex w-full flex-col gap-4 p-6', className)}
      data-test="turn-view"
      data-state={state.status}
      data-turn-id={state.turn_id}
    >
      <header className="flex items-center justify-between gap-3">
        <TurnStatusPill
          status={state.status}
          {...(state.escalation !== undefined ? { escalation: state.escalation } : {})}
        />
        {state.status === 'completed' && state.usage !== undefined ? (
          <UsageBadge usage={state.usage} />
        ) : null}
        {state.model !== undefined ? (
          <span
            className="ml-auto font-mono text-xs text-muted-foreground"
            title="Model the CLI resolved for this turn"
            data-test="turn-model"
          >
            {state.model}
          </span>
        ) : null}
        {state.session_id !== undefined ? (
          <span className="font-mono text-xs text-muted-foreground" title="Claude session id">
            {state.session_id.slice(0, 8)}
          </span>
        ) : null}
      </header>

      <ThinkingBlock text={state.thinking_text} complete={state.thinking_complete} />

      {state.assistant_text !== '' || state.assistant_complete || state.status === 'streaming' ? (
        <AssistantMessage text={state.assistant_text} complete={state.assistant_complete} />
      ) : null}

      {state.tools.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Tool calls" data-test="tool-card-list">
          {state.tools.map((tool) => (
            <ToolCard key={tool.tool_use_id} tool={tool} />
          ))}
        </section>
      ) : null}

      {state.status === 'errored' && state.error !== undefined ? (
        <ErrorPanel error={state.error} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AssistantMessage
// ---------------------------------------------------------------------------

export interface AssistantMessageProps {
  text: string;
  complete: boolean;
}

export function AssistantMessage({ text, complete }: AssistantMessageProps): JSX.Element {
  // Markdown since PR #18d.2. The streaming cursor renders as a sibling
  // after the parsed tree (it can't live inside it — plan §3.4).
  return (
    <article
      className="rounded-md border border-border bg-card p-4 text-sm text-foreground"
      data-test="assistant-message"
      data-streaming={complete ? 'false' : 'true'}
    >
      <Markdown text={text} />
      {complete ? null : <StreamingCursor />}
    </article>
  );
}

function StreamingCursor(): JSX.Element {
  return (
    <span
      className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground align-middle"
      aria-hidden="true"
      data-test="streaming-cursor"
    />
  );
}

// ---------------------------------------------------------------------------
// ThinkingBlock
// ---------------------------------------------------------------------------

export interface ThinkingBlockProps {
  text: string;
  complete: boolean;
}

export function ThinkingBlock({ text, complete }: ThinkingBlockProps): JSX.Element | null {
  // Empty thinking → render nothing. Avoids an empty "thinking" frame before
  // the first thinking delta lands (or when a turn has none at all).
  if (text === '') return null;

  return (
    <article
      className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs italic text-muted-foreground"
      data-test="thinking-block"
      data-streaming={complete ? 'false' : 'true'}
      aria-label="Internal reasoning"
    >
      <header className="mb-1 text-[10px] font-semibold uppercase tracking-wide not-italic">
        Thinking
      </header>
      <pre className="whitespace-pre-wrap break-words font-sans">
        {text}
        {complete ? null : <StreamingCursor />}
      </pre>
    </article>
  );
}

// ---------------------------------------------------------------------------
// ToolCard
// ---------------------------------------------------------------------------

export interface ToolCardProps {
  tool: ToolCall;
}

export function ToolCard({ tool }: ToolCardProps): JSX.Element {
  const inputText = stringifyJson(tool.input);
  // Collapsible since PR #18d.3: collapsed by default, errors start expanded
  // (plan §2.2). Collapse is `hidden`, not unmount — body markers stay in
  // the DOM for tests and a11y tree consistency (plan §2.1).
  const [collapsed, setCollapsed] = useState<boolean>(tool.status !== 'error');
  return (
    <article
      className="rounded-md border border-border bg-card text-xs"
      data-test="tool-card"
      data-tool-id={tool.tool_use_id}
      data-tool-status={tool.status}
      data-tool-name={tool.name}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/30',
          collapsed ? '' : 'border-b border-border',
        )}
        data-test="tool-card-toggle"
      >
        <span className="flex items-center gap-1.5 font-mono font-semibold text-foreground">
          <span aria-hidden="true" className="inline-block w-3 text-muted-foreground">
            {collapsed ? '▸' : '▾'}
          </span>
          {tool.name}
        </span>
        <ToolStatusIndicator status={tool.status} />
      </button>
      <div className="flex flex-col gap-2 p-3" hidden={collapsed}>
        <section>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Input
          </div>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-foreground">
            {inputText}
          </pre>
        </section>

        {tool.status === 'success' && tool.result !== undefined ? (
          <section data-test="tool-card-result">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Result
            </div>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-foreground">
              {stringifyJson(tool.result)}
            </pre>
          </section>
        ) : null}

        {tool.status === 'error' ? (
          <section data-test="tool-card-error">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-destructive">
              Error
            </div>
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-destructive/10 p-2 font-mono text-destructive">
              {tool.error_message ?? '(no message)'}
            </pre>
          </section>
        ) : null}
      </div>
    </article>
  );
}

function ToolStatusIndicator({ status }: { status: ToolCall['status'] }): JSX.Element {
  if (status === 'pending') {
    return (
      <span
        className="inline-flex items-center gap-1 text-muted-foreground"
        data-test="tool-status-indicator"
        data-tool-status="pending"
      >
        <span
          className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground"
          aria-hidden="true"
        />
        running
      </span>
    );
  }
  if (status === 'success') {
    return (
      <span
        className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"
        data-test="tool-status-indicator"
        data-tool-status="success"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
        ok
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-destructive"
      data-test="tool-status-indicator"
      data-tool-status="error"
    >
      <span className="h-2 w-2 rounded-full bg-destructive" aria-hidden="true" />
      error
    </span>
  );
}

// ---------------------------------------------------------------------------
// TurnStatusPill
// ---------------------------------------------------------------------------

export interface TurnStatusPillProps {
  status: 'streaming' | 'completed' | 'cancelled' | 'errored';
  escalation?: 'sigint' | 'sigterm' | 'sigkill' | undefined;
}

const STATUS_LABEL: Record<TurnStatusPillProps['status'], string> = {
  streaming: 'streaming',
  completed: 'completed',
  cancelled: 'cancelled',
  errored: 'errored',
};

export function TurnStatusPill({ status, escalation }: TurnStatusPillProps): JSX.Element {
  const palette =
    status === 'streaming'
      ? 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
      : status === 'completed'
        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
        : status === 'cancelled'
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-destructive/10 text-destructive';

  const dot =
    status === 'streaming'
      ? 'animate-pulse bg-sky-500'
      : status === 'completed'
        ? 'bg-emerald-500'
        : status === 'cancelled'
          ? 'bg-amber-500'
          : 'bg-destructive';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        palette,
      )}
      data-test="turn-status-pill"
      data-state={status}
      {...(escalation !== undefined ? { 'data-escalation': escalation } : {})}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} aria-hidden="true" />
      {STATUS_LABEL[status]}
      {status === 'cancelled' && escalation !== undefined ? (
        <span className="ml-1 font-mono opacity-80">{escalation}</span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// UsageBadge
// ---------------------------------------------------------------------------

export interface UsageBadgeProps {
  usage: TurnUsage;
}

/** 57141 → "57.1k"; below 1000 unchanged. */
export function compactTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/**
 * Share of the turn's prompt served from cache, in whole percent, or
 * undefined when the CLI reported no cache fields.
 */
export function cacheHitPercent(usage: TurnUsage): number | undefined {
  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  if (read === undefined && write === undefined) return undefined;
  const total = (read ?? 0) + (write ?? 0) + (usage.input_tokens ?? 0);
  return total === 0 ? undefined : Math.floor(((read ?? 0) / total) * 100);
}

export function UsageBadge({ usage }: UsageBadgeProps): JSX.Element {
  const inTok = usage.input_tokens;
  const outTok = usage.output_tokens;
  const read = usage.cache_read_input_tokens;
  const write = usage.cache_creation_input_tokens;
  const hit = cacheHitPercent(usage);
  const hasAny = inTok !== undefined || outTok !== undefined || hit !== undefined;
  return (
    <span
      className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-0.5 font-mono text-xs text-muted-foreground"
      data-test="usage-badge"
    >
      {hasAny ? (
        <>
          <span data-test="usage-input" title="uncached input tokens">
            {inTok !== undefined ? `↑ ${compactTokens(inTok)}` : '↑ —'}
          </span>
          {hit !== undefined ? (
            <span
              data-test="usage-cache"
              title={`prompt cache: ${read ?? 0} tokens read, ${write ?? 0} written`}
            >
              {`cache ${hit}% · ${compactTokens(read ?? 0)} read · ${compactTokens(write ?? 0)} written`}
            </span>
          ) : null}
          <span data-test="usage-output" title="output tokens">
            {outTok !== undefined ? `↓ ${compactTokens(outTok)}` : '↓ —'}
          </span>
        </>
      ) : (
        <span>—</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ErrorPanel (inline; not exported; ClodError-shaped)
// ---------------------------------------------------------------------------

interface ErrorPanelProps {
  error: ClodError;
}

function ErrorPanel({ error }: ErrorPanelProps): JSX.Element {
  const detail = error.detail ?? error.raw_stderr ?? '';
  return (
    <article
      className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
      data-test="error-panel"
      data-error-kind={error.kind}
      role="alert"
    >
      <header className="mb-1 flex items-center gap-2">
        <span
          className="rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide"
          data-test="error-panel-kind"
        >
          {error.kind}
        </span>
        {error.retryable ? (
          <span className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
            retryable
          </span>
        ) : null}
      </header>
      {detail !== '' ? (
        <pre
          className="whitespace-pre-wrap break-words font-mono text-xs opacity-90"
          data-test="error-panel-detail"
        >
          {detail}
        </pre>
      ) : (
        <p className="text-xs opacity-70" data-test="error-panel-detail">
          (no detail)
        </p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Circular references or non-serializable values fall back to String.
    return String(value);
  }
}
