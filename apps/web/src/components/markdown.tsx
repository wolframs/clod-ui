/**
 * `<Markdown>` — shared GFM renderer for model- and user-authored text.
 *
 * react-markdown + remark-gfm with a hand-styled component map (no
 * typography plugin: the Tailwind surface stays explicit and themable).
 * No rehype-raw — embedded HTML renders as escaped text, never as DOM
 * (the safety decision pinned in the PR #18d.2 plan §3.1).
 *
 * Pure presentational: no state, no effects (Invariant I-4). Consumers:
 * `AssistantMessage` (turn-view) and `TextBlockView` (transcript-history).
 *
 * Spec: plans/2026-06-10-clod-ui-pr18d-2-markdown-renderer-v1.md.
 */
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

export interface MarkdownProps {
  text: string;
  className?: string | undefined;
}

/**
 * Component map: each block element gets compact chat-appropriate spacing.
 * `first:mt-0` / `last:mb-0` keep the rendered block flush inside its card.
 */
const components: Components = {
  p: ({ children }) => <p className="mb-2 whitespace-pre-wrap break-words last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mb-2 mt-3 text-base font-bold first:mt-0 last:mb-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-3 text-sm font-bold first:mt-0 last:mb-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-2.5 text-sm font-semibold first:mt-0 last:mb-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-2 text-sm font-semibold text-muted-foreground first:mt-0 last:mb-0">
      {children}
    </h4>
  ),
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="break-words">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-border pl-3 italic text-muted-foreground last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-600 underline underline-offset-2 hover:text-sky-500 dark:text-sky-400"
    >
      {children}
    </a>
  ),
  // Inline code vs fenced block: react-markdown renders fenced code as
  // <pre><code>; the <pre> map below owns the block chrome, so the <code>
  // map only styles the inline case (detected by absence of a language
  // class is unreliable — instead, <pre> resets its child's styles).
  code: ({ children, className }) => (
    <code
      className={cn(
        'rounded bg-muted/60 px-1 py-0.5 font-mono text-[0.85em]',
        '[pre_&]:rounded-none [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-xs',
        className,
      )}
    >
      {children}
    </code>
  ),
  // TODO(syntax-highlighting): language-aware highlighting in a later slice.
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-xs last:mb-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border/50 last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-2 py-1.5 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }) => <td className="px-2 py-1.5 align-top">{children}</td>,
};

export function Markdown({ text, className }: MarkdownProps): JSX.Element {
  return (
    <div className={cn('text-sm text-foreground', className)} data-test="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
