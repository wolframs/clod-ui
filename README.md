# Clod UI

A chat UI that routes every conversation through the Claude Code CLI instead of
calling an API directly. A Bun engine spawns `claude` headless
(`-p --output-format stream-json`), streams its events over WebSocket, and a
React app renders them. The point is that the operator can see and set the
things the CLI normally hides: model, tool allowlist, system prompt, session
resume.

**Status — the owner's own words:** "Personal tool, under construction. Not
intended for third-party use."

<!-- DRAFT: needs author -->

## Work in progress: what works today

Clod UI is unfinished. The engine is the complete half; the browser UI is a
plain text chat on top of it.

- **The engine runs.** It answers `GET /health` (including the installed CLI
  version), creates and lists conversations, starts a turn by spawning one
  `claude` process, cancels it by killing that process's whole group, serves
  the conversation's transcript, reads and writes Claude Code's
  `settings.json`, and titles each conversation by asking Haiku through a
  second `claude -p`. Its turn endpoint accepts a model, tool allow and deny
  lists, a system prompt (append or override), a working directory and a
  session to resume.
- **The web app** has a conversation sidebar, a text composer with cancel, a
  streaming view of the active turn, the conversation's history, and a health
  badge. It sends only the text you type; none of the controls above have a UI
  yet, and neither do effort or attachments, which the backend can pass to the
  CLI but the engine does not accept.
- **The two halves do not meet in a browser yet.** The launcher that is meant
  to serve both from one origin is a stub, and the engine sends no CORS
  headers, so a page on the Vite dev server cannot read the engine's replies.
  The web app is tested against a mock engine; the engine is tested against
  recorded and scripted CLI output.

Also not built yet:

<!-- /DRAFT -->

- **Launcher** is [nine lines](./apps/launcher/src/index.ts) that log and exit.
  Nothing supervises the engine or opens a browser.
- **Rendering is plain.** Assistant text goes through `<pre>`; no markdown, no
  syntax highlighting, no collapsible tool cards, no scroll-to-bottom. Each is
  a named TODO in `turn-view.tsx` / `transcript-history.tsx`.
- **`ci:deep` / `ci:nightly`** run `ci:fast`, print a TODO and exit 0. The
  layers they are named after (Playwright, chaos, real-CLI smoke, tape diff) do
  not exist.
- **No e2e tests.** `tests/e2e/` and `tests/smoke/` hold only `.gitkeep`.

## The event log

[`packages/manifest`](./packages/manifest) is an append-only NDJSON log, one
file per conversation at
`<app-data>/conversations/<conv-id>/manifest.json`. Each line is a
`ManifestEvent` carrying `seq`, `ts`, `hash_self` and `hash_prev` over a
canonical JSON encoding, so tampering with an earlier line is detectable.
Event kinds are the conversation's state changes — `conversation.created`,
`conversation.titled`, `session.captured`, `settings.applied`,
`model.changed`, `tool_config.changed`, `attachment.added`,
`artifact.observed`, and others. Projected state is a pure fold over the log;
nothing rewrites an earlier line. Appends are `O_APPEND` and unsynced: losing
the last few events to power loss is accepted, corrupting earlier ones is not.

A SQLite index (`engine.sqlite`) sits alongside it for list queries. The log is
authoritative; the index is derived.

Separately, [`packages/transcripts`](./packages/transcripts) tails Claude Code's
own JSONL session files under `<CLAUDE_HOME>/projects/<encoded-cwd>/` and
normalizes them into typed chat messages. That is the CLI's record, not ours.

## Prerequisites

- **Bun**, exactly the version pinned in [`.bun-version`](./.bun-version).
  `scripts/ci.ts` refuses to run on any other version.
  Install: `curl -fsSL https://bun.sh/install | bash`.
- **Claude Code CLI** on `PATH`, installed and authenticated. See
  [Anthropic's install docs](https://docs.claude.com/en/docs/claude-code/quickstart).
  Clod UI stores no credentials of its own; it inherits the CLI's.
- Developed on macOS. The full gate also runs on Linux, in GitHub Actions and
  locally. Windows is untested.

## Run it

```sh
bun install
bun run ci:fast    # the whole gate: install, lint, typecheck, format, tests, README link-check
```

There is no single command that starts the product, because
`apps/launcher` still only logs and exits. The two halves start separately:

```sh
bun run --filter '@clod-ui/engine' dev    # Bun + Hono engine, hot reload
bun run --filter '@clod-ui/web' dev       # Vite dev server
```

The engine binds `127.0.0.1`, takes a port from `CLOD_UI_ENGINE_PORT` and an
app-data root from `CLOD_UI_APP_DATA_DIR`, and logs the port it chose. The web
app talks to whatever `VITE_ENGINE_URL` points at, defaulting to its own origin.
See [`.env.example`](./.env.example) for the complete list; none of them are
secrets.

Other commands that work:

```sh
bun test --path-ignore-patterns='apps/web/tests/dom/**'   # or: bun run test:fast
bun run web:test          # the jsdom half, under Vitest
bun run lint typecheck format:check
bun run tape:record -- --name <slug> --prompt-file <path>
```

`tape:record` spawns the real CLI and writes everything it said into
`tests/fixtures/cli-tapes/`, including the prompt. Read a tape before committing
it.

Git hooks (via [`lefthook.yml`](./lefthook.yml)): pre-commit runs
`lint:staged` + `typecheck`, pre-push runs `ci:fast`. `LEFTHOOK=0` bypasses.

## Layout

```
apps/
  engine/      Bun + Hono server: routes, SQLite index, manifest store,
               transcript watcher, auto-titling.
  web/         Vite + React + Tailwind + shadcn/ui. Sidebar, Composer,
               streaming TurnView, TranscriptHistory.
  launcher/    Stub. Logs one line and exits 0.

packages/
  contracts/   Wire schemas + typed client.
  backend/     `ClaudeBackend` interface. Real = `claude` subprocess;
               Tape = replay a recording; Scripted and Chaos live in test-kit.
  manifest/    The append-only event log (above).
  settings/    Atomic temp+rename writes with .bak rotation; unknown Claude
               Code settings keys survive a round-trip byte-for-byte.
  transcripts/ Watcher + normalizer for CC's own JSONL.
  test-kit/    TestEnv, FakeClock, ScriptedBackend, TapeBackend, ChaosBackend,
               MockEngineServer, typed test client, assertions, tape recorder.

tests/spine/   The spine assertions (T1.01–T1.15), catalogued in docs/SPINE.md.
```

[`packages/contracts`](./packages/contracts) is the single source of truth for
everything that crosses engine ↔ web: Zod schemas plus the TS types derived from
them. Engine surface: `GET /health`, `GET|POST /conversations`,
`POST /conversations/:id/turns`, `POST /conversations/:id/cancel`,
`GET /conversations/:id/transcript`, `GET|PUT /settings`, and a WebSocket
upgrade at `/ws` that accepts `?since=<lastEventId>` to replay the gap after a
reconnect.

## Design docs

- [`plans/INDEX.md`](./plans/INDEX.md) — index of every plan
- [`plans/2026-04-23-clod-ui-architecture-v2.md`](./plans/2026-04-23-clod-ui-architecture-v2.md) — architecture
- [`plans/2026-04-23-clod-ui-test-strategy-v1.md`](./plans/2026-04-23-clod-ui-test-strategy-v1.md) — test layers L0–L8
- [`docs/INVARIANTS.md`](./docs/INVARIANTS.md) — the nine contracts (I-1…I-9) that hardened across PRs
- [`docs/SPINE.md`](./docs/SPINE.md) — what each spine test pins down
- [`plans/landed/`](./plans/landed/) — one design doc per landed PR
- [`docs/archive/`](./docs/archive/) — superseded v1 plans. History, not spec.

Plans are written before the code and describe intent at the time. Where a plan
and the code disagree, the code is what exists.

## Licence

MIT. The full text is in [`LICENSE`](./LICENSE).
