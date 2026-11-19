# PR #45 — conversation profiles

_2026-11-05. Built from a design brief written in another of the
operator's projects (why one engine with profiles). Not part of the S1–S14 queue; PR #37 stays untouched._

## What and why

One page should talk to several differently configured agents, or to plain Claude. Each
conversation gets a **profile** — the binary that runs its turns and the
directory it runs in — chosen when it is created and fixed after. Profiles
come from a registry file the engine re-reads; with no file the engine is
today's engine, bit for bit.

## Decisions

- **D1 Registry file.** `CLOD_UI_PROFILES`, else `<app-data>/profiles.json`.
  `{ default, profiles: [{ id, label, binary, cwd, require_browser? }] }`.
  Ids `[a-z0-9-]{1,32}`, unique; `default` names one; `binary` non-empty;
  `cwd` absolute path or `null` (= the conversation's own directory).
  Unknown keys in an entry are an error: a typo in `require_browser` must not
  silently drop a gate. Pure parser `parseProfileRegistry` in
  `apps/engine/src/profiles.ts`; the loader stats the file on every access
  and re-parses when (mtime, size, inode) changes.
- **D2 Bad file keeps the last good registry.** The reason goes to the
  engine log (once per file change) and to `GET /profiles` as `warning`
  (no paths in it). A first load that fails runs on the implicit profile.
  A deleted file means no registry: the implicit profile again.
- **D3 Implicit profile** `default`: binary and cwd are the engine-wide ones
  (`CLOD_UI_CLAUDE_BINARY`, `CLOD_UI_CONVERSATION_CWD`). It is stored as
  `NULL`, so every pre-#45 row and every row made without a registry runs on
  it forever — never on whatever the registry's `default` later becomes.
- **D4 Storage.** Migration 2: `conversations.profile TEXT` (nullable).
  Manifest `conversation.created` gains optional `profile`; the fold carries
  it (I-7 last-write-wins). Absent when NULL, so the hash chain of an
  implicit-profile conversation is unchanged.
- **D5 Turns.** Body `profile` (id string, else 400). New conversation:
  body `profile`, else the registry default; its cwd is the profile's.
  Existing conversation: a body `profile` that differs from the row is a 400
  (fixed at creation; the PR #24 stance — never silently ignored); a NULL row
  matches only `default`. Every turn resolves the row's profile in the
  current registry: missing → 409 `{ error: { kind: 'profile_unavailable',
  profile } }`, nothing provisioned or spawned. `require_browser` → the
  request needs an `Origin` header (the same-origin guard has already
  matched it to `Host`), else 403 `{ error: { kind: 'browser_required' } }`.
  Order: body 400 → profile 400/409/403 → provisioning → busy 409.
- **D6 Binary.** `TurnRequest.claude_binary`; `compose()` prefers it over
  `ComposeOptions.claudeBinary`, so the spawn, the warm-reuse comparison and
  the diagnostics recompute all see the profile's binary. Warm reuse needs no
  change: argv[0] is in the compared argv and the profile never changes
  inside a conversation. `GET /models`, `GET /skills`, health and the titler
  stay engine-wide.
- **D7 Wire.** `GET /profiles` → `{ default, profiles: [{ id, label }],
  warning? }`, always on (the implicit profile always exists), no paths.
  `ConversationSummary.profile` optional. Typed client `listProfiles()`.
- **D8 Web.** `useProfiles` (I-2: `loading | ok | error`) also owns the
  next-conversation choice in `localStorage` (`clod-ui.next-profile`; first
  time and stale values: the registry default). Pure `<ProfilePicker>` beside
  "+ New" in the sidebar and in the mobile top bar, only with two or more
  profiles. Pure `<ProfileLabel>` on sidebar rows and in the conversation
  header (desktop: a slim strip over the pane; phone: under the top-bar
  title) for non-default profiles. The body carries `profile` only for a
  conversation the list does not hold yet, and this tab remembers what it
  sent so a second quick turn sends the same.
- **D9 Errors readable.** The typed client's `http` error message now
  carries the engine's error kind/string, so "profile_unavailable (lab)"
  shows in the composer instead of a bare status.

## Tests

- `apps/engine/tests/profiles.test.ts`: parser table; loader re-read,
  last-good-on-malformed, deleted file.
- Spine `T1.22-profiles`: two-profile registry → argv[0] + cwd in
  `GET /diagnostics`; NULL row on the env binary; removed profile → 409, no
  spawn; `require_browser` without `Origin` → 403; fixed-at-creation 400;
  `GET /profiles` shape.
- db migration, manifest fold, compose precedence, client message,
  web helpers, `ProfilePicker`/`ProfileLabel`, sidebar + top bar, hook.

## Deploy note

After merging: `bun run --filter @clod-ui/web build` (the launcher only
builds a missing dist), write `profiles.json` into the app-data dir (or
point `CLOD_UI_PROFILES` at it), then restart the engine when no
turn is running. Migration 2 applies itself on the first open.

## Found on the way

- **Uploads pinned the profile.** `POST …/attachments` provisioned the
  conversation, so an upload before the first turn fixed it on the implicit
  profile (and its cwd) and the first turn's profile became a 400. Fixed:
  the upload writes into the conversation's directory without provisioning
  (the sweeper only walks provisioned rows, so nothing new is swept); spine
  T1.22 pins it.
- **`cli_missing` keyed on the engine-wide binary.** The real backend's
  pre-spawn short-circuit refused every turn when the engine-wide binary was
  missing — including a profile's own. Fixed (applies only without
  `claude_binary`), with a real-backend test.
- **Error bodies were dropped** by the typed client; the composer showed only
  "returned 409". Now the engine's kind/string rides in the message (D9).
- **README spine counts were stale** (49 / 20 against SPINE.md's 52 / 21);
  the README now points at SPINE.md instead of copying the number.
- Warm reuse: confirmed no change needed — `splitArgv` keeps argv[0] in the
  compared part, and a conversation's profile never changes.
- Not done: the page reads `GET /profiles` once per load, so a registry edit
  shows in the picker after a reload (turns see it at once). The lab
  binary must be executable (`Bun.spawn` runs argv[0] directly).
