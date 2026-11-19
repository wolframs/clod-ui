# PR #44 — the phone layout

_2026-11-01. The operator, from a phone: the UI "needs proper
mobile UX/UI overhauls"; see how chat UIs solve it. The desktop layout at 412 px
gives the sidebar 288 px and the conversation the rest._

## Looked at (claude.ai at 412×780, mobile emulation)

One pane. Top bar: menu, title, actions. Conversations in a drawer over
everything. Viewport meta `viewport-fit=cover, interactive-widget=resizes-content`.
A rounded composer that grows, send inside it, 16 px text, model · effort as one
quiet control under it. Messages use the full width.

## Decisions

1. **Below `md` (768 px) only.** The desktop layout does not change. Sizing goes
   in `max-md:`/`md:` classes; what differs in structure goes through one hook,
   `useCompact` (a render branch keeps `data-test` markers unique, I-3).
2. **Route in the hash:** `#/c/<id>`, on every width. A phone kills tabs; a reload
   must come back to the conversation, and Android Back must mean something.
   j/k replace, everything else pushes. No router dependency.
3. **Back closes what is open.** `useBackDismiss(open, onClose)`: one history
   entry per overlay (drawer, panels, controls sheet), compact only. Picking a
   conversation from the drawer *replaces* that entry, so Back goes to the
   previous conversation and not to a reopened drawer.
4. **Fresh composer on open** (compact, no hash): as claude.ai. The empty pane
   stays the desktop's.
5. **Drawer footer** takes what the desktop footer holds: theme, settings, skills,
   debug, health.
6. **Composer:** box with + and send inside, grows to ~6 lines
   (`field-sizing: content`), stop replaces send. Enter is a newline on the
   phone; the keyboard has no Shift. Sending drops the keyboard so the reply can
   be read.
7. **Turn controls in a bottom sheet**, behind one line: `Model · Effort`, a dot
   when a system prompt, tool list or raw flags are set. The bar itself is reused
   unchanged, enlarged by the sheet.
8. **Sticky bottom survives a resize:** the keyboard shrinks the scroller; if you
   were at the bottom you stay there (ResizeObserver).

9. **Found on the way, all widths:** tool cards never collapsed (`flex` beat the
   `hidden` attribute), and every tool result rendered as a Human "orphan" because
   the CLI writes it into the next message. Cards now hide; results fold across
   messages.
10. **Installable:** manifest and icons, so a home-screen icon drops the URL bar.

## Not in this PR

`TODO(controls-persistence)` still stands: per-conversation controls are lost on
reload, which a phone does more often. Edge-swipe for the drawer: Android's
gesture navigation owns that edge.

## Tests

`conversation-route` (bun, pure), `use-back-dismiss` + composer compact (vitest),
`tests/e2e/mobile.spec.ts` at 412×780 with touch: no horizontal overflow, drawer,
Back, reload, Enter, sheet, touch-target size.

## Review

Sol (GPT-6.1), one pass, both reproduced in Chromium and fixed: a reload kept a
dead Back entry; rotating past the breakpoint with the sheet open leaked one.

Not tested on a real phone by this PR: the emulated viewport has no software
keyboard.
