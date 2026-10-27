/**
 * `TranscriptHistory` — pure presentational projection of the historical
 * `ChatMessage[]` from `useTranscript` (PR #20b). Renders the conversation's
 * persisted history; the active turn (`<TurnView />`) renders separately
 * below it.
 *
 * Presentational with one interactive concession: ToolUseBlockView owns a
 * single `useState` for its collapse toggle (PR #18d.3, Invariant I-4 —
 * state enters only when interactivity forces it).
 *
 * The `ChatMessage` shape comes from `@clod-ui/contracts/chat-message` and
 * carries content blocks discriminated on `type`. We render each block via
 * a dedicated sub-component; tool_result blocks are folded under their
 * matching tool_use parent at render time (purely visual, no data
 * transformation — keeps the data shape stable for other consumers).
 *
 * Spec: plans/landed/2026-05-06-clod-ui-pr20b-transcript-history-v1.md §4.
 */
import type {
  ChatMessage,
  ContentBlock,
  ImageBlock,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@clod-ui/contracts';
import { useState } from 'react';

import { Markdown } from '@/components/markdown';
import type { TranscriptState } from '@/lib/use-transcript';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export interface TranscriptHistoryProps {
  state: TranscriptState;
  className?: string | undefined;
}

export function TranscriptHistory({ state, className }: TranscriptHistoryProps): JSX.Element {
  if (state.status === 'idle') {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center text-sm text-muted-foreground',
          className,
        )}
        data-test="transcript-history"
        data-state="idle"
      >
        <p>Select a conversation to load its history.</p>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div
        className={cn(
          'flex h-full w-full items-center justify-center text-sm text-muted-foreground',
          className,
        )}
        data-test="transcript-history"
        data-state="loading"
        aria-busy="true"
      >
        <p>Loading history…</p>
      </div>
    );
  }

  if (state.status === 'not_configured') {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground',
          className,
        )}
        data-test="transcript-history"
        data-state="not_configured"
      >
        <p className="font-medium">Transcripts not configured.</p>
        <p className="text-xs opacity-70">
          The engine was started without <code>--projects-dir</code>; history is unavailable.
        </p>
      </div>
    );
  }

  if (state.status === 'error') {
    const fullMessage = state.error.message;
    const truncatedMessage =
      fullMessage.length > 200 ? `${fullMessage.slice(0, 199)}\u2026` : fullMessage;
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-1 px-6 text-sm text-destructive',
          className,
        )}
        data-test="transcript-history"
        data-state="error"
        role="alert"
      >
        <p className="font-medium">Failed to load history.</p>
        <pre
          className="max-w-full whitespace-pre-wrap text-xs opacity-80"
          title={fullMessage}
          data-test="transcript-history-error"
        >
          {truncatedMessage}
        </pre>
      </div>
    );
  }

  // status === 'ok'
  if (state.messages.length === 0) {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-1 text-sm text-muted-foreground',
          className,
        )}
        data-test="transcript-history"
        data-state="empty"
      >
        <p>No history yet for this conversation.</p>
        <p className="text-xs opacity-70">Send a message to get started.</p>
      </div>
    );
  }

  return (
    <ol
      // Scroll-agnostic since PR #18d.1: the single scroll container lives in
      // App.tsx (useStickyBottom drives it); this list renders at natural height.
      className={cn('flex w-full flex-col gap-3 p-6', className)}
      data-test="transcript-history"
      data-state="ok"
      data-message-count={state.messages.length}
    >
      {state.messages.filter(hasVisibleContent).map((message) => (
        <li key={message.id}>
          <ChatMessageView message={message} />
        </li>
      ))}
    </ol>
  );
}

/**
 * Newer CLIs write the model's thinking as a block with empty text and only a
 * signature. A message made only of those has nothing to show; it stays in
 * the data and leaves the view.
 */
function hasVisibleContent(message: ChatMessage): boolean {
  return message.content.some((b) => b.type !== 'thinking' || b.text.trim() !== '');
}

// ---------------------------------------------------------------------------
// ChatMessageView
// ---------------------------------------------------------------------------

export interface ChatMessageViewProps {
  message: ChatMessage;
}

export function ChatMessageView({ message }: ChatMessageViewProps): JSX.Element {
  // Build a tool_use_id → ToolResultBlock index so we can fold tool_results
  // under their matching tool_use blocks at render time. Pure visual; the
  // underlying ChatMessage data is unchanged.
  const toolResultsById = new Map<string, ToolResultBlock>();
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      toolResultsById.set(block.tool_use_id, block);
    }
  }

  // Render every block in source order *except* tool_result blocks, which we
  // skip at the top level (they appear under their matching tool_use). Stray
  // tool_result blocks (no matching tool_use in this message) still render
  // standalone so we never lose data — see StrayToolResultBlockView.
  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-md border p-4 text-sm',
        message.role === 'user'
          ? 'border-sky-500/30 bg-sky-500/5'
          : 'border-border bg-card text-foreground',
      )}
      data-test="chat-message"
      data-role={message.role}
      data-message-id={message.id}
    >
      <header className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{message.role === 'user' ? 'Human' : 'Claude'}</span>
        <span className="font-mono opacity-60" title="line / byte offset in JSONL">
          L{message.source.line_number} · B{message.source.byte_offset}
        </span>
      </header>
      <div className="flex flex-col gap-2">
        {message.content.map((block, idx) => (
          <ContentBlockView
            key={idx}
            block={block}
            toolResultsById={toolResultsById}
            indexInMessage={idx}
          />
        ))}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// ContentBlockView (dispatcher)
// ---------------------------------------------------------------------------

interface ContentBlockViewProps {
  block: ContentBlock;
  toolResultsById: Map<string, ToolResultBlock>;
  indexInMessage: number;
}

function ContentBlockView({
  block,
  toolResultsById,
  indexInMessage,
}: ContentBlockViewProps): JSX.Element | null {
  switch (block.type) {
    case 'text':
      return <TextBlockView block={block} />;
    case 'thinking':
      return <ThinkingBlockView block={block} />;
    case 'image':
      return <ImageBlockView block={block} />;
    case 'tool_use': {
      const result = toolResultsById.get(block.tool_use_id);
      return (
        <ToolUseBlockView
          block={block}
          {...(result !== undefined ? { result } : {})}
          indexInMessage={indexInMessage}
        />
      );
    }
    case 'tool_result':
      // Skipped here; rendered under matching tool_use. If no parent
      // exists in this message it falls through to the stray renderer.
      // (We can't tell from this block alone whether it has a parent in
      // the same message — that lookup happened in ChatMessageView. A
      // tool_result that *does* have a parent in this message is in the
      // map; one that doesn't is missing. We render the stray case.)
      return <StrayToolResultBlockView block={block} />;
  }
}

// ---------------------------------------------------------------------------
// TextBlockView
// ---------------------------------------------------------------------------

/**
 * User-sent image (PR #34): renders the base64 payload carried by the
 * transcript directly as a data URI — no fetch, no serving round-trip.
 */
function ImageBlockView({ block }: { block: ImageBlock }): JSX.Element {
  return (
    <img
      data-test="image-block"
      data-media-type={block.media_type}
      src={`data:${block.media_type};base64,${block.data_base64}`}
      alt="attachment"
      className="max-h-64 max-w-full rounded-md border border-border object-contain"
    />
  );
}

function TextBlockView({ block }: { block: TextBlock }): JSX.Element {
  // Markdown since PR #18d.2 (both roles — users paste markdown too).
  return (
    <div data-test="content-block" data-block-type="text">
      <Markdown text={block.text} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThinkingBlockView
// ---------------------------------------------------------------------------

function ThinkingBlockView({ block }: { block: ThinkingBlock }): JSX.Element | null {
  if (block.text.trim() === '') return null;
  return (
    <article
      className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs italic text-muted-foreground"
      data-test="content-block"
      data-block-type="thinking"
      aria-label="Internal reasoning"
    >
      <header className="mb-1 text-[10px] font-semibold uppercase tracking-wide not-italic">
        Thinking
      </header>
      <pre className="whitespace-pre-wrap break-words font-sans">{block.text}</pre>
    </article>
  );
}

// ---------------------------------------------------------------------------
// ToolUseBlockView
// ---------------------------------------------------------------------------

interface ToolUseBlockViewProps {
  block: ToolUseBlock;
  result?: ToolResultBlock | undefined;
  indexInMessage: number;
}

function ToolUseBlockView({ block, result }: ToolUseBlockViewProps): JSX.Element {
  // Collapsible since PR #18d.3: collapsed by default, error results start
  // expanded (plan §2.2). Collapse is `hidden`, not unmount (plan §2.1).
  const [collapsed, setCollapsed] = useState<boolean>(!(result?.is_error ?? false));
  return (
    <article
      className="rounded-md border border-border bg-card text-xs"
      data-test="content-block"
      data-block-type="tool_use"
      data-tool-id={block.tool_use_id}
      data-tool-name={block.name}
      data-has-result={result !== undefined ? 'true' : 'false'}
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
            {collapsed ? '\u25b8' : '\u25be'}
          </span>
          {block.name}
        </span>
        {result === undefined ? (
          <span className="font-mono text-[10px] text-muted-foreground">no result</span>
        ) : result.is_error ? (
          <span className="font-mono text-[10px] text-destructive">error</span>
        ) : (
          <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">ok</span>
        )}
      </button>
      <div className="flex flex-col gap-2 p-3" hidden={collapsed}>
        <section>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Input
          </div>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-foreground">
            {stringifyJson(block.input)}
          </pre>
        </section>
        {result !== undefined ? (
          <section data-test="tool-result-section">
            <div
              className={cn(
                'mb-1 text-[10px] font-semibold uppercase tracking-wide',
                result.is_error ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {result.is_error ? 'Error' : 'Result'}
            </div>
            <pre
              className={cn(
                'max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded p-2 font-mono',
                result.is_error
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-muted/40 text-foreground',
              )}
            >
              {stringifyJson(result.content)}
            </pre>
          </section>
        ) : null}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// StrayToolResultBlockView
// ---------------------------------------------------------------------------

function StrayToolResultBlockView({ block }: { block: ToolResultBlock }): JSX.Element {
  // A tool_result with no matching tool_use in the same message. Rendered
  // standalone so data is never lost; the visual cue (orphan label) hints
  // that the parent lives in a different message.
  return (
    <article
      className={cn(
        'rounded-md border border-dashed text-xs',
        block.is_error ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-muted/20',
      )}
      data-test="content-block"
      data-block-type="tool_result"
      data-tool-id={block.tool_use_id}
      data-stray="true"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          orphan tool_result
        </span>
        <span className="font-mono text-[10px] opacity-70">{block.tool_use_id}</span>
      </header>
      <pre
        className={cn(
          'max-h-32 overflow-y-auto whitespace-pre-wrap break-words p-3 font-mono',
          block.is_error ? 'text-destructive' : 'text-foreground',
        )}
      >
        {stringifyJson(block.content)}
      </pre>
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
    return String(value);
  }
}
