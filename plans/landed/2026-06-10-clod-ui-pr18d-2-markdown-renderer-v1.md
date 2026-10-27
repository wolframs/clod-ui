# PR #18d.2 — markdown renderer

**Status:** in-flight
**Phase:** 4 (web UI scaffolding)
**Slice of:** PR #18d (scroll-to-bottom ✓ / markdown / tool-card collapsibles)
**Plan source:** `plans/2026-04-23-clod-ui-architecture-v2.md` Phase 4

## 1. Why now

Assistant text renders as `<pre className="whitespace-pre-wrap">` in two places
(`turn-view.tsx` AssistantMessage `:109`, `transcript-history.tsx` TextBlockView
`:257`), both carrying `// TODO(markdown-renderer)`. Claude output is markdown;
verbatim rendering makes headings, lists, tables and fenced code read as noise.
PR #18d.1 landed the single scroll container, so vertical content can now grow
properly — the renderer is the next visible-quality jump.

## 2. Scope

- **In scope:**
  - `react-markdown` + `remark-gfm` as `apps/web` deps.
  - `apps/web/src/components/markdown.tsx` — shared `<Markdown text={...} />`,
    hand-styled component map (no typography plugin; keeps the Tailwind
    surface explicit and themable).
  - Swap `TextBlockView` (history, both roles) and `AssistantMessage`
    (streaming turn) to `<Markdown>`.
- **Out of scope:**
  - Syntax highlighting in code fences — `// TODO(syntax-highlighting)`.
  - Tool input/result rendering (stays `<pre>`/JSON — it IS verbatim data).
  - Thinking blocks (stay verbatim `<pre>` — reasoning text is not authored
    for presentation; rendering it would imply it is).
  - Markdown in turn-view's error pane (verbatim is correct there).

## 3. Decisions pinned

1. **Safety:** no `rehype-raw`; react-markdown escapes embedded HTML by
   default. Model- or user-authored `<script>` stays inert text.
2. **Newline semantics:** standard GFM — single `\n` is a soft break. No
   `remark-breaks`. Claude emits real markdown; verbatim layouts belong in
   code fences. If chat ergonomics disagree in practice:
   `// TODO(remark-breaks)`.
3. **Links:** `target="_blank"` + `rel="noopener noreferrer"` via the
   component map. The engine UI must never navigate away in-pane.
4. **Streaming cursor:** the cursor can't live *inside* a parsed tree; it
   renders as a sibling after `<Markdown>` while `!complete`. Slight visual
   change from inline-after-last-char; acceptable, revisit only if it grates.
5. **Re-parse per delta:** react-markdown re-parses the full text on every
   delta. Chat-sized texts parse in well under a frame; if long turns
   stutter: `// TODO(markdown-memo)` (memoize completed prefix or debounce).
6. **Markers:** `<Markdown>` root carries `data-test="markdown"`. The
   existing `data-test="content-block"` / `data-test="assistant-message"`
   wrappers are unchanged (Invariant I-3 — tests pin markers, not classes).

## 4. The component contract

```tsx
export interface MarkdownProps {
  text: string;
  className?: string | undefined;
}
export function Markdown({ text, className }: MarkdownProps): JSX.Element
```

Pure presentational, no state/effects (Invariant I-4). Component map covers:
p, h1–h4, ul/ol/li, blockquote, hr, a, strong/em, inline `code`, fenced
`pre > code`, table/thead/tbody/tr/th/td. Anything unmapped falls through to
react-markdown defaults (unstyled but correct).

## 5. Test plan

- `apps/web/tests/markdown.test.tsx` (bun, renderToString, stateless):
  paragraph split; heading levels; GFM table; fenced code (`<pre>` +
  `font-mono`); inline code; link gets `target`/`rel`; raw HTML arrives
  escaped (no `<script>` element in output); GFM strikethrough.
- `turn-view.test.tsx`: existing assertions are text-content + marker based;
  verify green, adjust only if a `<pre>` assertion existed for assistant text.
- `transcript-history.test.tsx`: same expectation — markers + text survive.

## 6. Commit cadence

1. `docs(plans): PR #18d.2 — markdown renderer`
2. `feat(web): <Markdown> — react-markdown + GFM with styled component map`
3. `feat(web): markdown rendering in AssistantMessage + TextBlockView`

## 7. Verification

- `bun run ci:fast` green.
