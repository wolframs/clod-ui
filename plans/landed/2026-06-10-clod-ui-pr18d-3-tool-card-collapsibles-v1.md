# PR #18d.3 — tool-card collapsibles

**Status:** in-flight
**Phase:** 4 (web UI scaffolding)
**Slice of:** PR #18d (scroll-to-bottom ✓ / markdown ✓ / tool-card collapsibles)
**Plan source:** `plans/2026-04-23-clod-ui-architecture-v2.md` Phase 4

## 1. Why now

Tool inputs/results render as always-open `max-h-32` scroll boxes in both the
streaming view (`turn-view.tsx` ToolCard, `// TODO(tool-card-collapse)`) and
history (`transcript-history.tsx` ToolUseBlockView). Turns with many tool calls
drown the prose. The header row (name + status) already carries the essential
signal; the bodies should be opt-in.

## 2. Decisions pinned

1. **Collapse = `hidden`, not unmount.** The body stays in the DOM with the
   `hidden` attribute. Why: every existing renderToString assertion on body
   markers (`tool-card-result`, `tool-result-section`, …) keeps passing —
   collapse is a *visual* policy, not a data policy. Cost: large results keep
   their DOM weight; that's today's status quo, no regression.
2. **Defaults:** collapsed, with one exception — `status === 'error'` /
   `is_error` results default **expanded**. Errors deserve attention; success
   is a header-level fact.
3. **State:** plain `useState` per card. The CLAUDE.md sketch suggested a
   localStorage layout-state hook; rejected here — tool_use_ids are unique
   per turn, so persisted per-id state is write-only garbage. A *global*
   expand-default preference can join the real layout-state module later:
   `// TODO(layout-state)` (already planted in App.tsx).
4. **First `useState` in these components** — Invariant I-4 allows it once
   interactivity forces it; module headers updated to say so.
5. **A11y + markers:** the header becomes a `<button>` with `aria-expanded`;
   the card root gains `data-collapsed="true|false"`. Tests pin markers and
   the `hidden` attribute (I-3).

## 3. Scope

- `turn-view.tsx` ToolCard: header → toggle button (chevron + name + status),
  body wrapped in `hidden={collapsed}` div.
- `transcript-history.tsx` ToolUseBlockView: same treatment.
- No shared abstraction yet — two call sites, differently shaped props; a
  `<CollapsibleCard>` primitive earns its keep at the third consumer
  (`// TODO(collapsible-primitive)`).

## 4. Test plan

- Existing bun renderToString suites: unchanged assertions keep passing;
  add default-state assertions (`data-collapsed` per §2.2).
- New `apps/web/tests/dom/tool-card-collapse.test.tsx` (vitest + RTL):
  click expands a collapsed success card (hidden removed, aria-expanded);
  click collapses again; error card starts expanded — both components.

## 5. Commit cadence

1. `docs(plans): PR #18d.3 — tool-card collapsibles`
2. `feat(web): collapsible ToolCard (turn-view) + ToolUseBlockView (history)`
3. `docs(plans): land PR #18d.3 — rotate plan, refresh INDEX/README/CLAUDE.md`

## 6. Verification

- `bun run ci:fast` green.
