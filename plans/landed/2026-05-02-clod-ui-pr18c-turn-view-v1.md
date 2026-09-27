# PR #18c — `<TurnView />`: pure presentational projection of the active turn

**Status**: in flight
**Date**: 2026-05-02
**Phase**: 4 (Web UI scaffolding)
**Architecture task**: 4.4 (streaming message renderer — first concrete renderer)
**Predecessors**: PR #18a (`useSubscribe`), PR #18b (`useTurnStream` + `turnReducer`)
**Spec**: this file

---

## 1. Why now

PR #18b landed the typed projection (`TurnState`) of the wire's envelope stream. The pane in
`apps/web/src/App.tsx:30-35` still says "Select a conversation … the transcript pane lands in
the next slice." This PR makes it stop saying that.

Scope is deliberately bounded to **pure presentational** rendering. Three things that *could*
land in this PR are explicitly deferred:

- **Markdown** — assistant text renders as `<pre className="whitespace-pre-wrap">` for now.
  Adding `react-markdown` is its own dep + plugin choice (sanitization, code-block syntax
  highlighting, GFM tables). PR #18d.
- **Virtualization** — only matters once historical messages render alongside the active turn.
  Active-turn-alone is a single `TurnView` instance per pane; nothing to virtualize. PR #20.
- **Collapsible tool cards** — requires `useState` per card and click handlers. The current
  slice keeps the renderer state-free. Tool inputs and results render in fixed-height
  scrollable boxes (`max-h-32 overflow-y-auto`). PR #18d.

The "pure presentational + hook-owned state" invariant (`docs/INVARIANTS.md` I-4) holds
end-to-end: `useTurnStream` owns state, `<TurnView />` is a function from `TurnState` to JSX.

## 2. Surface

**One file:** `apps/web/src/components/turn-view.tsx`. Exports six components — the top-level
plus five sub-components, each independently testable and re-usable in PR #20's transcript
composition.

```ts
// Top-level: switches on TurnState.status
export function TurnView(props: { state: TurnState; className?: string }): JSX.Element;

// Sub-components (also exported for direct use)
export function AssistantMessage(props: { text: string; complete: boolean }): JSX.Element;
export function ThinkingBlock(props: { text: string; complete: boolean }): JSX.Element | null;
export function ToolCard(props: { tool: ToolCall }): JSX.Element;
export function TurnStatusPill(props: {
  status: 'streaming' | 'completed' | 'cancelled' | 'errored';
  escalation?: 'sigint' | 'sigterm' | 'sigkill';
}): JSX.Element;
export function UsageBadge(props: { usage: { input_tokens?: number; output_tokens?: number } }): JSX.Element;
```

**`<TurnView />` render variants:**

| `state.status`    | What renders                                                                                              |
|-------------------|-----------------------------------------------------------------------------------------------------------|
| `idle`            | Centered hint: "Waiting for the next turn…" with subdued styling.                                         |
| `streaming`       | AssistantMessage (with cursor) + ThinkingBlock (if non-empty, with cursor) + ToolCard list + status pill. |
| `completed`       | Same minus cursors + UsageBadge (if `usage` present).                                                     |
| `cancelled`       | Same minus cursors + status pill carrying `escalation`.                                                   |
| `errored`         | Same minus cursors + an `ErrorPanel` showing `error.kind` and `error.message` from `ClodError`.           |

`ErrorPanel` is rendered inline (not exported) because `ClodError` shape is owned by
`@clod-ui/contracts` and has no other consumer yet.

**`<ThinkingBlock />` returns `null` when `text === ''`** so the renderer doesn't show an empty
"thinking" block before any thinking deltas have arrived. Returning `null` keeps the parent
JSX tidy without conditional rendering.

## 3. Test markers (I-3)

Per `docs/INVARIANTS.md` I-3, every component carries `data-test` + variant attributes so
tests assert on contract-shaped attributes, not Tailwind class fragments:

| Component        | Markers                                                                                              |
|------------------|------------------------------------------------------------------------------------------------------|
| `TurnView`       | `data-test="turn-view" data-state={state.status} data-turn-id={turn_id ?? ''}`                       |
| `AssistantMessage` | `data-test="assistant-message" data-streaming={complete ? 'false' : 'true'}`                       |
| `ThinkingBlock`  | `data-test="thinking-block" data-streaming={complete ? 'false' : 'true'}`                            |
| `ToolCard`       | `data-test="tool-card" data-tool-id={tool_use_id} data-tool-status={status} data-tool-name={name}`   |
| `TurnStatusPill` | `data-test="turn-status-pill" data-state={status}` (+ `data-escalation` when relevant)               |
| `UsageBadge`     | `data-test="usage-badge"`                                                                            |

## 4. App wiring

`apps/web/src/App.tsx` updates:

- When `selectedId` is `undefined`: render the existing "Select a conversation…" hint, but
  drop the "lands in the next slice" line.
- When `selectedId` is set: replace the placeholder card with
  `<TurnView state={useTurnStream({ conv_id: selectedId })} />`.
- The existing `<HealthBadge />` moves to a small footer slot so it stays visible alongside
  active-turn rendering.

`useTurnStream` is enabled iff `selectedId !== undefined` (mounting the hook with `enabled:
false` until selection picks the conversation; this is the established `enabled` pattern
from PR #18a).

The `// TODO(layout-state)` in `App.tsx:11-12` stays put — hoisting `selectedId` into a typed
layout-state module (with localStorage) is its own slice and isn't on the critical path.

## 5. Test plan

`apps/web/tests/turn-view.test.tsx` (renderToString tier). DOM tests aren't needed because
no component holds state, takes click handlers, or schedules effects.

**TurnView render variants (5):**

- `data-state="idle"` for `INITIAL_TURN_STATE`; visible hint copy.
- `data-state="streaming"` while the turn is active; AssistantMessage carries
  `data-streaming="true"`; status pill present with `data-state="streaming"`.
- `data-state="completed"` after `turn.result`; AssistantMessage carries
  `data-streaming="false"`; UsageBadge present with token counts when usage was supplied.
- `data-state="cancelled"` with status pill carrying `data-escalation="sigterm"` when set.
- `data-state="errored"` with ErrorPanel showing the ClodError's `kind` and `message`.

**Sub-component variants (8):**

- AssistantMessage: streaming variant has a visible cursor marker; completed variant doesn't.
  Empty `text` while streaming still renders the cursor (so the user sees *something* during
  the brief gap before the first delta lands).
- ThinkingBlock: returns no DOM nodes for empty `text`; non-empty text renders with the
  appropriate streaming attribute.
- ToolCard pending: spinner present; result section absent.
- ToolCard success: result rendered as JSON in a fixed-height pre.
- ToolCard error: error message visible in a destructive treatment.
- TurnStatusPill: `data-state` matches; visible label matches the status.
- TurnStatusPill cancelled: `data-escalation` populated when escalation was supplied.
- UsageBadge: renders both token counts when both are present; renders only the present one
  otherwise; renders a `—` for an empty usage object.

## 6. Deferred (named TODOs)

| Marker                              | Where                | Closes                                                                 |
|-------------------------------------|----------------------|------------------------------------------------------------------------|
| `// TODO(markdown-renderer)`        | `turn-view.tsx`      | PR #18d — `react-markdown` + GFM + code-block highlighting             |
| `// TODO(tool-card-collapse)`       | `turn-view.tsx`      | PR #18d — click-to-toggle expand/collapse with `useState`              |
| `// TODO(scroll-to-bottom)`         | `App.tsx`            | PR #18d — scrollable container + sticky-bottom behavior                |
| `// TODO(transcript-history)`       | `App.tsx`            | PR #20 — `useTranscript` hook + ChatMessage rendering above active turn |
| `// TODO(turn-history)`             | `use-turn-stream.ts` | PR #20 — buffer of past completed turns alongside the active one       |

## 7. Risk register

- **`json` rendering of `tool.input` / `tool.result`** — the reducer types `input` and
  `result` as `unknown`. Real CC tool inputs are usually plain objects; results vary
  (string for Bash, object for many tools). `JSON.stringify(value, null, 2)` is the safe
  default; if it throws (circular references), the renderer falls back to `String(value)`.
  Tested with the standard cases; circular-ref edge case is on the radar but unlikely from
  the wire.
- **Empty-state visibility on conv-id change** — `useTurnStream` resets to `idle` on
  conv-id change (PR #18b's "adjust state on prop change"). The renderer must show the
  empty hint, not a stale streaming view. The conv-id-change test in PR #18b proves the
  reset happens; this PR's `data-state="idle"` test pins the rendered empty hint.
- **Performance for long assistant text** — a single `<pre>` with `whitespace-pre-wrap` is
  fine up to several thousand lines. Past that, virtualization matters (PR #20). For a
  single active turn, it's not a concern.

## 8. Verification

- ci:fast green; spine 24/24 unchanged.
- 5× web:test flake check; 5× full spine flake check.
- New test count: ~13 across the renderToString tier (no new vitest+RTL tests this slice).

## 9. Commit cadence

Four chunks following the established pattern:

1. `docs(plans):` — this file.
2. `feat(web):` — `turn-view.tsx` (component file, isolated).
3. `feat(web):` — App.tsx wire-in (small, focused).
4. `test(web):` — `turn-view.test.tsx` (the verification chunk).
