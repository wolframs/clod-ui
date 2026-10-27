# Progress at a glance

_Last updated: 2026-10-27, after PR #43. Update this file in every
"land PR #N" docs commit — it is the one-screen answer to "where is
this project?"; the details live in the links, not here._

```
Phase 0  Hygiene / monorepo / CI skeleton   ████████  done
Phase 1  Contracts & protocol               ███████░  done*
Phase 2  Engine core                        ███████░  done*
Phase 3  Persistence / manifest / transcripts ████████  done
Phase 4  Web UI (full conversation loop)    ███████░  done*
Phase 5  First-class controls               ████████  done*
Phase 6  Attachments                        ████████  done
Phase 7  Polish & resilience                ██████░░  partial
Phase 8  Network activation (opt-in)        ░░░░░░░░  open (by design)
CI       fast / deep / nightly tiers        █████░░░  fast+deep live
```

\* done with named remainders — see the table.

## Phases

| Phase                                              | Status | PRs                | Open remainders                            |
| -------------------------------------------------- | ------ | ------------------ | ------------------------------------------ |
| 0 — hygiene, monorepo, CI skeleton                 | ✅     | #1                 | —                                          |
| 1 — contracts & protocol                           | ✅     | #1, #13            | `TODO(protocol-doc)`                       |
| 2 — engine core (backend, flags, cancel, errors)   | ✅     | #2–#5              | `TODO(pidfile)` (Task 2.9)                 |
| 3 — persistence, manifest, transcripts             | ✅     | #6–#11             | —                                          |
| 4 — web UI (read/write loop end-to-end)            | ✅     | #12–#20b, #18d.1–3 | 3-pane inspector, virtualization           |
| 5 — first-class controls (model, thinking, tools…) | 🔶     | #24, #25, #28      | 5.4–5.7: prefs, tools, skills, diagnostics |
| 6 — attachments                                    | ◻      | —                  | the whole phase                            |
| 7.3 — launcher (`bun run start`)                   | ✅     | #21                | `TODO(ready-file)`                         |
| 7.4 — crash recovery (restart-once + banner)       | ✅     | #5, #22            | `TODO(restart-policy)`                     |
| 7.2 — honest dark mode (data-theme + toggle)       | ✅     | #26                | —                                          |
| 7.1 — keyboard map (n / j k / ? overlay / Esc)     | ✅     | #27                | —                                          |
| 7.5 — structured logging                           | ◻      | —                  | the slice                                  |
| 8 — network activation                             | ◻      | —                  | deliberately last, opt-in                  |
| CI tiers                                           | 🔶     | #1                 | `ci:deep`/`ci:nightly` are stubs           |

## The numbers

- **51 PRs landed** (catalog: [`plans/INDEX.md`](../plans/INDEX.md))
- **52 / 52 spine tests live**, 21 files ([`docs/SPINE.md`](./SPINE.md))
- **9 invariants** pinned by tests ([`docs/INVARIANTS.md`](./INVARIANTS.md))
- **813 bun + 117 vitest tests**, 0 fail, gating every commit
- Architecture spec current as of PR #23
  ([v3 + drift ledger](../plans/2026-06-10-clod-ui-architecture-v3.md))

## What works today

`bun run start` → builds the web app if needed, boots the engine,
serves the SPA same-origin, opens the browser. Full conversation loop:
sidebar, history, streaming turns with tool/thinking cards, markdown,
submit/cancel, auto-titling, reconnect-and-resume. Per-conversation
model picker, thinking-effort, and a collapsible system-prompt editor
(append/override) compose observable `--model` / `--effort` /
`--append-system-prompt` / `--system-prompt` argv (PR #24/#25). If the
engine crashes, the launcher restarts it once on the same port while
the UI shows a reconnecting banner. Light/dark theme follows the OS by
default; the footer toggle (system → light → dark) wins and persists.
Keyboard: n new conversation, / focus composer, j/k switch
conversations, ? shortcut overlay, Esc closes/cancels. A raw-flags
escape hatch appends verbatim argv after every composed flag; a tools
editor curates --allowedTools/--disallowedTools with pattern chips. A
settings panel edits CC's real settings.json behind a diff preview; a
skills panel lists what /skill-name can invoke and from where; a
Debug panel shows per-turn redacted argv + timelines with Copy repro.
Attachments: pick or drag-drop files into the composer, chips track
uploads, images reach the model as base64 blocks (real-CLI-verified:
haiku read a red PNG and said 'Red') and render in history.
Each conversation keeps one warm CLI process between turns (PR #39):
SessionStart hooks run once, not per turn; the usage badge shows the
turn's cache hit, read and written tokens. Retirement is bounded
(EOF → SIGTERM → SIGKILL, until the whole process group is gone) and
engine shutdown waits for it (PR #40/#41/#43). The model picker lists
the CLI's own models (name · resolved id) and effort is the CLI's
`/effort` scale, Auto…Max plus Ultracode, gated per model (PR #42).

## Up next (the completion goal queue)

Working through `plans/2026-06-10-clod-ui-completion-goal-v1.md` in
order. S1–S11 landed; next is S12 (ci:nightly — tapes + real-CLI
smoke).
