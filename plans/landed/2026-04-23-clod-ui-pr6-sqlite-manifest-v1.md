# PR #6 — SQLite + manifest persistence

> Status: Active. This plan executes architecture v2 Tasks **3.1** (SQLite schema + migrations), **3.2** (`@clod-ui/manifest` real impl), and **3.3** (conversation provisioning) in a single reviewable slice. Companion: `plans/2026-04-23-clod-ui-architecture-v2.md`, `plans/2026-04-23-clod-ui-test-strategy-v1.md`.

## Objective

Stand up the persistence spine so:

1. Each conversation owns a directory with an **append-only NDJSON `manifest.json`** plus `cwd/` and `scratch/`.
2. A `bun:sqlite` index at `<app-data>/clod-ui.sqlite` caches each conversation's `claude_session_id` so resume across engine restarts is a one-row lookup.
3. The first `system.init` event of a conversation's first turn appends a `session.captured` event to the manifest **and** updates the SQLite row.
4. The fold over the manifest is the source of truth; SQLite is a cache that is reproducible from the manifest at any time.

Un-skips **T1.01b** (persistence half), **T1.03** (resume across engine restart), **T1.10** (manifest fold + append-only + corruption detection). Spine becomes 12/12 live by end of this PR — every spine test green except the two PR #7/PR #8 tests still pending.

## Out of Scope

- **Settings IO** (`@clod-ui/settings` real impl) — PR #8 (T1.09).
- **Transcript watcher** — PR #7 (T1.11).
- **Auto-titling** — Phase 3.5, post-spine.
- **Diagnostics ring buffer** — Phase 5.7.
- **Manifest event kinds beyond `conversation.created` and `session.captured`** — `settings.applied`, `attachment.added`, etc., remain typed but unfired in this PR. The fold handles them as no-ops where unimplemented; the next PR that needs one wires it.
- **`ConversationSettings` rows / migrations beyond v1** — only the `conversations` table is created in this PR. Subsequent migrations land with the features that need them.
- **Pidfile + zombie sweep** — Phase 2 Task 2.9, separate PR.
- **Sub-block streaming (`--include-partial-messages`)** — orthogonal.

## Design

### Append-only NDJSON manifest

`<app-data>/conversations/<uuid>/manifest.json` is **NDJSON**. Each line is a JSON object with these fields:

```ts
{
  seq: number;          // 0-indexed, strictly monotonic
  ts: number;           // unix ms
  hash_prev?: string;   // hash_self of the previous line; absent on seq:0
  hash_self: string;    // sha256 over the canonical event payload + hash_prev
  // ... the event-kind-specific fields
}
```

`hash_self` is computed as:

```
hash_self = sha256_hex( canonical_json({ ...event_without_hashes }) + (hash_prev ?? "") )
```

`canonical_json` is `JSON.stringify` with sorted keys, no whitespace, deterministic number formatting. The event includes `seq`, `ts`, `kind`, and kind-specific fields; it does **not** include `hash_prev` (that's an input) or `hash_self` (that's the output).

Append is `fs.appendFileSync(path, line + '\n', { flag: 'a' })`. Open-with-append is atomic per write on POSIX for writes ≤ `PIPE_BUF` (4 KiB on macOS), which all our event lines comfortably are. We do **not** fsync per write — losing the last few events on power-loss is acceptable; corrupting earlier events is not, and append-mode prevents that by construction.

### Corruption detection

`readAll(convId)`:

1. Reads the file line-by-line.
2. For each line, parses JSON; on parse failure raises `ManifestCorruptError({line: i, reason: 'parse'})`.
3. Verifies `seq === i` (strictly monotonic from 0); on mismatch raises `ManifestCorruptError({line: i, reason: 'seq'})`.
4. Recomputes `hash_self` from the event payload + `hash_prev` and compares; on mismatch raises `ManifestCorruptError({line: i, reason: 'hash'})`.
5. If the file ends without a newline on the last line **and** the partial line fails JSON parse, we raise `ManifestCorruptError({line: lastLine, reason: 'truncated'})` rather than silently dropping it — surfaces "process died mid-write" so an operator can intervene.

Missing files are not corrupt; `readAll` on a missing file returns `[]`.

### `ManifestEvent` schema additions

Add a new event kind:

```ts
| { kind: 'session.captured'; session_id: string }
```

Rationale: `conversation.created` happens at provisioning time (before any turn); `session.captured` happens when the first `system.init` arrives. Append-only logs naturally separate state changes that arrive at different moments. The fold projects both into a single `ConversationState`.

`fold(events) → ConversationState`:

```ts
interface ConversationState {
  conv_id: string;            // implicit from convId argument
  title?: string;
  created_at?: number;
  claude_session_id?: string;
  model?: string;
  system_prompt?: { mode: 'append' | 'override'; text: string };
  allowed_tools?: string[];
  disallowed_tools?: string[];
  attachments: Array<{ id: string; relative_path: string; content_hash: string; bytes: number }>;
  artifacts: Array<{ relative_path: string; content_hash: string; bytes: number }>;
}
```

Pure left-fold. Unknown kinds skip silently (forward-compat). Tests in §1 cover the kinds we currently emit; the rest stay declared-but-untested until their owning PR lands.

### SQLite schema (migration v1)

```sql
CREATE TABLE IF NOT EXISTS migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,                -- UUIDv4 of conversation
  claude_session_id TEXT,             -- nullable until first system.init
  cwd TEXT NOT NULL,                  -- absolute path to <root>/conversations/<id>/cwd
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(claude_session_id);
```

DB opened with `WAL` mode and `foreign_keys = ON`. Migrations are forward-only and applied at engine startup inside a transaction.

### Conversation provisioning

`provisionConversation(store, db, {convId, cwd})`:

1. `mkdir -p <root>/conversations/<convId>/{cwd,scratch}`
2. Append `conversation.created` event to manifest with `ts: Date.now()`.
3. `INSERT INTO conversations` row.

`recordSessionId(store, db, {convId, session_id})`:

1. Append `session.captured` event.
2. `UPDATE conversations SET claude_session_id = ? WHERE id = ?`.

### Engine wiring

`createApp({backend, store?, db?, ...})` becomes the new shape. When `store` and `db` are omitted (existing in-process tests), the engine runs in **memory-only** mode: provisioning is no-op, session_id is not persisted, manifest reads return `[]`. This keeps the PR #4/#5 in-process tests passing without modification.

When `store` and `db` are provided:

- POST `/conversations/:id/turns` calls `ensureProvisioned(convId, cwd)` before submitting.
- The broadcast wrapper intercepts `system.init` and calls `recordSessionId` once per conversation (idempotent — second call no-ops if `claude_session_id` already set).

`CLOD_UI_APP_DATA_DIR` env var picks the app-data root. Default for production: `process.env.HOME + '/.local/share/clod-ui'`. Tests pass an explicit dir via `TestEnv.appDataDir`.

### Resume on second engine

On `import.meta.main` startup, the engine reads existing rows from `conversations`. The state is rehydrated lazily — the first POST to `/conversations/:id/turns` on a known conv looks up `claude_session_id`, and if absent and not provided in the request body, includes it as `resume_session_id` in the spawned `TurnRequest`. (The flag composer already handles `--resume <id>`.)

## Tasks

### §1 — `@clod-ui/manifest` real impl
- Add `session.captured` to `ManifestEvent` union; `ConversationState` interface.
- Implement `ManifestStore` class with `appendEvent`, `readAll`, `fold`.
- Implement `ManifestCorruptError` (extends Error, fields `line`, `reason`).
- Implement canonical JSON serializer + sha256 hex helper (use `Bun.CryptoHasher` or `node:crypto`).
- Tests in `packages/manifest/tests/`:
  - fold over a fixture sequence covering `conversation.created` + `session.captured` (every kind we emit in this PR) → expected state.
  - Append-only byte-prefix invariant: snapshot file contents after each append; assert each snapshot is a strict prefix of the next.
  - Truncated file detection: write valid 5-event manifest, truncate to 60% of last line's bytes, `readAll` raises `ManifestCorruptError({reason:'truncated', line:4})`.
  - Hash chain detection: tamper with one event's content; `readAll` raises with `reason:'hash'` at that line.
  - Sequence skip detection: hand-write a manifest with `seq: 0,1,3`; `readAll` raises with `reason:'seq', line:2`.
  - Missing file → `readAll` returns `[]`.

### §2 — SQLite layer in `apps/engine`
- New module `apps/engine/src/db/`:
  - `migrations.ts` — array of `{version, sql}`.
  - `db.ts` — `openDb(path) → Database`, runs pending migrations in a transaction.
  - `repositories.ts` — `createConversation`, `getConversation`, `listConversations`, `setSessionId` typed wrappers.
- Tests in `apps/engine/tests/db.test.ts`:
  - openDb creates schema on fresh file; idempotent on rerun.
  - createConversation + getConversation roundtrip.
  - setSessionId updates `claude_session_id`.
  - opening DB on a future schema version fails clearly (forward-only safety check).

### §3 — Conversation provisioning service
- `apps/engine/src/provisioning.ts` exports `provisionConversation`, `recordSessionId`, `ensureProvisioned`.
- Tests in `apps/engine/tests/provisioning.test.ts`:
  - provision creates dirs + manifest line + DB row.
  - second provision on same id is idempotent (no duplicate manifest line, no DB conflict).
  - recordSessionId appends + updates DB.
  - second recordSessionId on same conv is no-op.

### §4 — Engine integration
- `createApp` accepts optional `{store, db, appDataDir}`.
- POST turns: ensureProvisioned, intercept `system.init`, call `recordSessionId`.
- `import.meta.main`: open store + db rooted at `CLOD_UI_APP_DATA_DIR ?? <home>/.local/share/clod-ui`, pass into createApp.
- Resume: if request body lacks `resume_session_id` but DB has one for this conv, inject it into `TurnRequest`.

### §5 — Un-skip T1.10
- Remove `describe.skip` shell, replace with three concrete tests imported from `@clod-ui/manifest` API.

### §6 — Un-skip T1.01b + T1.03
- T1.01b: stand up engine in-process with `store` + `db` rooted at a temp dir; submit turn with ScriptedBackend; assert manifest contains `session.captured` and DB row has matching `claude_session_id`.
- T1.03: spawn engine as subprocess **twice** against the same `CLOD_UI_APP_DATA_DIR`. Each subprocess uses a synthetic `claude` shim (PATH-based, like T1.12) emitting a known session_id. Assert:
  - After engine #1's turn completes and engine is killed, manifest file contains `conversation.created` + `session.captured` events.
  - Engine #2 starts; its DB read on this conv returns the persisted session_id.
  - Engine #2 submits a second turn; the spawned shim receives `--resume <session_id>` in argv (verified via shim writing argv to a file).
  - Final manifest is a strict byte-prefix extension of the snapshot taken after engine #1's death (append-only across restarts).

### §7 — Verify
- `bun run ci:fast` green.
- 10× flake check.
- Process-leak sanity (T1.03 spawns subprocesses; ensure they die).
- Commit in 4–5 logical chunks.

## Risk + Mitigation

1. **T1.03 timing** — engine subprocess startup + first turn + manifest write all need to complete deterministically. We poll `/health` for readiness, await the WS `system.init` envelope before killing, and use generous (not tight) timeouts.
2. **bun:sqlite WAL mode left a `-wal` and `-shm` file** that the second engine must reopen cleanly. WAL is designed for exactly this; we just need to not skip the `journal_mode=WAL` PRAGMA on every open.
3. **Manifest hash chain false positives** if our canonical JSON differs between writer and reader. Mitigation: same `canonicalize()` helper used in both directions, plus a round-trip test (`canonicalize(parse(canonicalize(x))) === canonicalize(x)`).
4. **Concurrent writes to the same manifest** would interleave bytes. We deliberately do not handle this — the engine is single-instance per app-data-dir (Phase 2 Task 2.9 will enforce via pidfile). For now, document the assumption in `ManifestStore` JSDoc.

## Open items (forward)

- `pidfile + zombie sweep` (Phase 2 Task 2.9) is the right place to enforce single-instance and to recover from PR #6's leftover SQLite-WAL-with-no-engine state.
- `settings.applied`, `attachment.added`, `model.changed`, etc. event firing — when their owning PRs land, they reuse `ManifestStore.appendEvent` unchanged.
- Soft-delete + 7-day trash window (architecture risk #4) — separate PR, doesn't block spine.

## What unblocks next

Spine reaches 12/12 once PR #7 (transcript watcher → T1.11) and PR #8 (settings IO → T1.09) land. Both are independent of each other and of this PR; either can go next. PR #7 is the marginally more involved one because it touches the WS event plane.
