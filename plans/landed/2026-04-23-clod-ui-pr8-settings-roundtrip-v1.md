# PR #8 — Settings round-trip (T1.09)

> Status: Active. Executes architecture v2 Task **3.6** (`@clod-ui/settings` real impl) plus the engine settings routes. Companion plans: `plans/2026-04-23-clod-ui-architecture-v2.md`, `plans/2026-04-23-clod-ui-test-strategy-v1.md`. Predecessors: `plans/landed/2026-04-23-clod-ui-pr6-sqlite-manifest-v1.md` (persistence template), `plans/landed/2026-04-23-clod-ui-pr7-transcript-watcher-v1.md` (engine-subsystem template).

## Objective

Stand up the user-owned `~/.claude/settings.json` read/write path so a UI client can:

1. **GET `/settings`** — fetch the current `ClaudeSettings`, with documented keys (`theme`, `model`, `allowedTools`, `disallowedTools`) typed and any other keys preserved verbatim under the `unknown` passthrough bucket.
2. **PUT `/settings`** — replace settings atomically (temp file + rename), validating documented keys via Zod, persisting unknown keys exactly as supplied.
3. **PATCH `/settings`** — partial top-level merge: only the supplied keys overwrite their counterparts; everything else (including the user's existing unknown keys) is left untouched.

Every write rotates `.bak` (most recent backup), `.bak.1`, `.bak.2` — last three versions kept on disk. A corrupted `settings.json` (unparseable JSON, or a documented key with the wrong type) surfaces as a typed 5xx with the on-disk file untouched.

Un-skips **T1.09** (2 concrete tests). Spine becomes **20 / 20 contracts live** across 12 contract files — the executable-specification milestone for Phase 2.

## Out of Scope

- **Per-cwd `<cwd>/.claude/settings.json`** — same package surface, same atomic-IO machinery, but a separate slice. The architecture's "global + project-local merge" semantics need a clear precedence story which we'll write when there's a UI consumer for it. The current spine contract only exercises the global file.
- **Mtime conflict detection** — architecture-spec'd in Task 3.6 but not required by T1.09. The seam (record mtime on read, accept `If-Match`-shaped guard on write) is left as a clearly-named TODO; a future PR adds it without changing the wire shape.
- **Per-conversation `PATCH /conversations/:id/settings`** — distinct surface (architecture Task 2.7), distinct storage (manifest events `settings.applied` / `model.changed` / etc., already typed). Not what T1.09 tests.
- **`settings.updated` WS broadcast** — listed in the architecture's wire-event taxonomy but only useful once the UI is multi-tab. Defer until at least one real consumer exists.
- **Schema version field** — `settings.json` does not carry a version yet. We pass through any keys we don't model, so adding one later is a no-op for old files.
- **Restore-from-`.bak` UI action** — Phase 5.4 work; the disk rotation is in place so the affordance is a future one-liner.

## Design

### Wire shape: bucketed, with explicit `unknown` passthrough

```ts
// @clod-ui/contracts
export const ClaudeSettingsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    model: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    unknown: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;
```

Why bucketed rather than a top-level index signature? Two reasons:

1. **TypeScript ergonomics under `noPropertyAccessFromIndexSignature: true`.** A top-level index signature would force every documented-key access to use bracket syntax for the unknown side, while the documented side reads cleanly as `s.theme`. Splitting cleanly into "documented" + "unknown bucket" means callers don't have to think about which is which.
2. **Validation is sharper.** A `.strict()` schema rejects any unrecognized top-level keys, forcing the wire to declare its passthrough explicitly. The IO layer flattens the bucket back to top-level on disk and re-buckets on read; the file's structure stays "ordinary CC settings.json", and the wire's structure is unambiguous.

The flatten-on-write rule is order-stable: documented keys appear in source-declaration order (`theme`, `model`, `allowedTools`, `disallowedTools`), then unknown keys in the order they were stored in the bucket. Insertion order is preserved by JS objects, which is what we want — round-tripping unknown keys *without reorder* is the spine invariant T1.09 pins.

### `SettingsStore` — atomic IO + .bak rotation

```ts
// @clod-ui/settings
export class SettingsStore {
  constructor(opts: { path: string });

  /** Read + parse + validate. Missing file → ClaudeSettings of `{}`. */
  read(): Promise<ClaudeSettings>;

  /** Replace the file atomically. Rotates .bak / .bak.1 / .bak.2 on success. */
  write(settings: ClaudeSettings): Promise<void>;

  /** Top-level read-modify-write. Only the keys present in `partial` are
   *  overwritten; the existing `unknown` bucket survives unless `partial.unknown`
   *  is supplied (in which case it merges per top-level rules too). */
  patch(partial: Partial<ClaudeSettings>): Promise<ClaudeSettings>;

  /** Path to the file (informational). */
  path(): string;
}
```

**Atomic write**:

1. Serialize the in-memory settings (documented keys first, then unknown keys) to a JSON string with two-space indent (matches CC's own convention; tests pin this).
2. Open `<path>.tmp.<pid>.<rand>` with `O_WRONLY | O_CREAT | O_TRUNC`.
3. Write all bytes; `fsync` the file descriptor; close.
4. Rotate backups (see below) **before** the rename, so a crash mid-rotation leaves either the old file or the rotated set, never both.
5. `rename(tmp, path)` — POSIX atomic on the same filesystem.

**Backup rotation** (best-effort; failures here do not fail the write):

```
old.bak.2 → discarded
old.bak.1 → bak.2
old.bak   → bak.1
old       → bak    (this is the file we're about to replace)
```

The rotation runs **after** the temp file is written but **before** the rename. If a step fails (e.g. permission denied on a stale `.bak`), we log a warning via the optional `onWarn` sink and continue; the user's settings are still safe because the rename step lands the new file regardless.

**Validation**: `read()` parses JSON; if it throws, raise `SettingsCorruptError({reason:'parse'})`. Then bucket: split top-level keys into documented vs unknown by name, run the bucketed `ClaudeSettingsSchema` (which is `.strict()` — will fail if a documented key has the wrong type), raise `SettingsCorruptError({reason:'schema', issues})` on Zod failure. The on-disk file is **not** touched in either error path.

`write()` validates the input the same way before any disk IO. Invalid input throws `SettingsValidationError({issues})` and the file is untouched.

### Engine HTTP routes

Three routes added to `createApp`, all gated on a new `settings?` option:

```ts
// CreateAppOptions extension
settings?: { store: SettingsStore };
```

Routes:

| Method | Path | Body | 200 response | Errors |
|---|---|---|---|---|
| GET | `/settings` | — | `ClaudeSettings` | 500 on corrupt file |
| PUT | `/settings` | `ClaudeSettings` | `ClaudeSettings` (echo of what's now on disk) | 400 on schema failure |
| PATCH | `/settings` | `Partial<ClaudeSettings>` | `ClaudeSettings` (post-merge) | 400 on schema failure |

When `settings` is omitted (PR #4/#5/#6/#7 in-process tests, the memory-only entrypoint), the routes return `404 { error: 'settings not configured' }` — the surface is opt-in like persistence and transcripts, and the legacy callers stay working without modification.

The 400/500 response body shape:

```ts
{ error: { kind: 'settings_invalid' | 'settings_corrupt'; detail: string; issues?: unknown } }
```

### Production wiring

The `import.meta.main` entrypoint resolves the settings file path from the same root as transcripts:

```
$CLAUDE_HOME/settings.json   (if CLAUDE_HOME set)
~/.claude/settings.json      (otherwise)
```

When `appDataDir` is resolvable, the engine constructs a `SettingsStore` at that path and passes it via `settings: { store }`. Tests inject an explicit store rooted at `TestEnv.fakeClaudeHome`.

### How T1.09 maps to this surface

**Test 1 — documented + unknown keys survive write/read cycle:**

1. Stand up engine in-process with a `SettingsStore` rooted in a temp dir.
2. PUT `/settings` with `{theme: 'dark', model: 'claude-opus', unknown: {custom_field: 42, another: 'value'}}`.
3. Assert response is `200`, body equals input.
4. GET `/settings`, assert deep-equal to input.
5. Read raw `settings.json` from disk, assert it contains the unknown keys at top level (flattened) in their original insertion order, no extra fields, no missing fields.

**Test 2 — partial update merges without losing unknown keys:**

1. Seed disk with a settings.json containing both documented and unknown keys.
2. PATCH `/settings` with `{theme: 'light'}` only.
3. GET `/settings`, assert `theme === 'light'`, all other documented keys unchanged, all unknown keys still present and equal to the seed.

## Tasks

### §1 — `@clod-ui/contracts/settings.ts`
- Add `ClaudeSettingsSchema` (Zod) with the bucketed shape above.
- Re-export from `@clod-ui/contracts` index.
- Drop the legacy `unknown?: Record<string, unknown>` typed-only declaration in `packages/settings/src/types.ts` and re-export the contracts type instead — single source of truth.

### §2 — `@clod-ui/settings` real impl
- `SettingsStore` class: `read`, `write`, `patch`, `path`.
- Helpers: `bucket(raw): ClaudeSettings`, `flatten(s): Record<string, unknown>`.
- Atomic write: temp file + fsync + rename, with `.bak` / `.bak.1` / `.bak.2` rotation pre-rename.
- Errors: `SettingsCorruptError`, `SettingsValidationError`.
- Tests in `packages/settings/tests/`:
  - missing file → `read()` returns `{}`-equivalent.
  - write + read round-trip preserves documented + unknown keys, with bucket survival on the wire and order on disk.
  - patch merges only the supplied keys; unknown bucket survives.
  - .bak rotation: after 4 sequential writes, `<path>`, `<path>.bak`, `<path>.bak.1`, `<path>.bak.2` all exist with consecutive contents; `<path>.bak.3` does not.
  - unparseable JSON → `read()` throws `SettingsCorruptError({reason:'parse'})`; file on disk is untouched on subsequent `write` validation failure.
  - schema mismatch (e.g. `theme: 'periwinkle'`) → `write()` rejects, `read()` throws on disk-corrupt input.
  - atomic write: even if the process is killed between temp-write and rename, the original file remains intact (modeled by writing tmp manually + asserting `read()` ignores it).

### §3 — Engine HTTP routes
- Extend `CreateAppOptions` with `settings?: { store: SettingsStore }`.
- Implement `GET /settings`, `PUT /settings`, `PATCH /settings`. Each validates Zod at the boundary.
- 404 `{ error: 'settings not configured' }` when the option is absent.
- Tests in `apps/engine/tests/settings-routes.test.ts`:
  - GET on a missing file → `200` with empty `ClaudeSettings`.
  - PUT round-trip with documented + unknown.
  - PATCH preserves unknown.
  - PUT with malformed body → `400 { error: { kind: 'settings_invalid' } }`.
  - GET when the disk file is corrupt → `500 { error: { kind: 'settings_corrupt' } }`.
  - 404 surface when `settings` option is not supplied.

### §4 — Production wiring
- `apps/engine/src/index.ts` `import.meta.main`: resolve path from `$CLAUDE_HOME ?? <HOME>/.claude` joined with `settings.json`, construct `SettingsStore`, pass to `createApp({ settings: { store } })`.

### §5 — Spine T1.09 un-skip
- Replace `describe.skip` with two concrete in-process tests (matching T1.01b / T1.03 / T1.11 boot patterns).
- Both tests stand up the engine with `settings`, exercise the routes via `fetch` calls (the TypedTestClient does not yet have `settings()` helpers — we keep these tests using `fetch` directly to avoid scope creep into the test-kit; a follow-up PR can add typed helpers when the UI uses them).

### §6 — Verify
- `bun run ci:fast` green.
- 10× flake check on `tests/spine/T1.09-*` and `packages/settings/tests/*`.
- Spine: 20 / 20 contracts live, 0 reserved.
- Commit in 4 logical chunks: contracts schema; settings store impl; engine routes; spine un-skip.

## Risk + Mitigation

1. **Order preservation across the bucket flatten/unflatten.** JS objects preserve insertion order; we always re-serialize unknown keys in their original bucket order. The on-disk-order spine assertion pins this. Risk: a future code path that mutates the bucket via spread (`{...unknown, foo: 1}`) could re-order; we add a JSDoc warning and a unit test that verifies a PUT-PATCH-PUT cycle preserves bucket order even when keys are touched.
2. **Atomic write on Bun / macOS.** `rename(2)` is atomic within a filesystem; we do not cross filesystem boundaries (temp file lives in the same dir). `fsync` on the temp fd before rename is the standard belt-and-braces step. Risk on `tmpdir()`-based tests: if Bun's `tmpdir` is on a different fs than the target dir, rename would fail. We mitigate by placing the temp file alongside the target file (`<path>.tmp.<pid>.<rand>`), not in `os.tmpdir`.
3. **`.bak` rotation failure leaves stale state.** The rotation is best-effort and runs *before* the rename, so any failure short-circuits to a warning; the new file still lands. We do not retry. A future PR can add a "Restore previous settings" UI action that surfaces the `.bak` chain when rotation fails.
4. **Concurrent writers (two engines, same settings file).** Same single-instance assumption as the manifest store; pidfile + zombie sweep (Phase 2 Task 2.9) is the right place to enforce. Document in `SettingsStore` JSDoc.
5. **Zod `.strict()` rejects future CC settings keys.** Documented keys are validated by name; unknown keys go through the passthrough bucket. A future CC release adding `mcpServers` would land in `unknown` and survive write/read. When we promote it to documented, callers who already had it in `unknown` would need to migrate — we'd handle that with a small "migrate `unknown.<key>` to top-level" helper at the same time we add the field. Acceptable: documented keys are intentional curation.
6. **Mtime conflict detection deferred.** The seam is left as `// TODO(mtime-guard)` comments at `read()` and `write()`; adding it later does not change the wire shape, only enriches it. Risk: two UI tabs both editing settings at the same time would silently last-write-wins until that lands. For a single-user tool, acceptable.

## Open items (forward)

- Per-cwd `<cwd>/.claude/settings.json` with a documented merge precedence (project-local overrides global). Same `SettingsStore`, two paths.
- `settings.updated` WS broadcast for multi-tab UI. Plumb via `broadcast(wrap(...))` in the same way `transcript.updated` rides the envelope plane.
- Mtime conflict detection — `If-Match`-shaped guard on PUT/PATCH; 412 on stale.
- Schema-versioned settings.json with forward-compat migration helpers.
- "Restore from .bak" UI action exposing the rotation chain.

## What unblocks next

**Spine reaches 20 / 20 contracts live.** The "every essential behavior is covered by an executing test" milestone the previous agent handshake described becomes literally true. Phase 2 closes; Phase 3 polish work (auto-titling, `ChatMessage` normalization for the transcript watcher's raw lines, web-UI scaffolding) starts on a foundation where every regression has an executable spec.
