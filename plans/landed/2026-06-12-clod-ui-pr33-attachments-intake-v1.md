# PR #33 — Phase 6a, part 1: attachments intake + wire (completion goal S9)

Date: 2026-06-12. Spec: completion goal S9; v2 Phase 6.x. Substrate:
`encodeStdin` already emits `{type:'image',source:{type:'path',path}}`
content blocks + `--add-dir` for attachment dirs; `TurnRequest.
attachments` exists; provisioning creates `conversations/<id>/{cwd,
scratch}`. Nothing upstream feeds any of it.

**Split (allowed by the goal doc):** S9's exit criteria — intake route
+ attachments-in-body → stdin/argv spine pin + one real-CLI smoke —
land here. The composer UI (picker + drag-drop) and image rendering in
history land as PR #34; S9 is marked ✅ only after both.

## Pinned decisions

- **D1 — intake is JSON + base64, not multipart.** `POST
  /conversations/:id/attachments` with `{ name, content_type?,
  data_base64 }` → engine decodes and writes
  `conversations/<id>/attachments/<sanitized name>` (suffix `-2`, `-3`…
  on collision), returns `{ name, path, content_type?, size }`.
  Localhost single-user: simplicity beats streaming; the typed
  transport stays JSON-only. `TODO(attachments-multipart)` for large
  files. File-by-reference holds where it matters: the CLI gets a
  *path*, bytes never enter stdin.
- **D2 — opt-in (I-1) via persistence:** absent → `404 { error:
  'attachments not configured' }` (the conversation dir is where files
  live). Unknown conversation → provisioned on demand (same
  `ensureProvisioned` the turn route uses) so upload-before-first-turn
  works.
- **D3 — name sanitization + serving.** Names reduce to
  `[A-Za-z0-9._-]` (others → `_`), leading dots stripped (no
  hidden/`..` names). `GET /conversations/:id/attachments/:name` serves
  the file (the UI's image preview source in PR #34); resolution never
  escapes the attachments dir (resolved-prefix check, the static-route
  precedent).
- **D4 — `parseTurnBody` accepts `attachments`** as an array of
  `{ path: string, content_type?: string }`; present-but-malformed →
  400 (paths drive `--add-dir` — sharp control, strict stance).
- **D5 — contracts:** `AttachmentMetaSchema` (+ response/list types) +
  `client.uploadAttachment(conv_id, body)`; `SubmitTurnInput.
  attachments`. `attachmentUrl(conv_id, name)` helper for PR #34.
- **D6 — spine: new contract T1.20**: (1) upload → 201 metadata + file
  bytes on disk in `attachments/`; (2) attachments in the POST body
  reach the backend and `compose()` emits the image content block in
  stdin + `--add-dir <attachments dir>`; (3) malformed attachments →
  400; (4) unconfigured → exact I-1 body. 45 → 49 tests, 20 files.
- **D7 — one real-CLI smoke turn** (the goal's sparing budget, first
  real spend): boot the real engine, upload a tiny generated PNG, POST
  a turn with `model: 'haiku'` + prompt "Reply with exactly one word:
  the dominant color of the attached image." Accept any sane completion
  as pass (the assertion is the pipe, not the model). If it fails
  twice: stop, write the repro in NEXT-SESSION (constraint 3), do not
  loop.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Contracts + parse:** schemas, client method + url helper,
   `parseTurnBody` D4 (+ unit tests).
3. **Engine:** `attachments.ts` (sanitize + write + collision suffix,
   pure parts unit-tested) + `routes/attachments.ts` (intake + serve,
   traversal-guarded) + createApp wiring (persistence-gated) +
   production enable. Spine T1.20 + SPINE.md.
4. **Smoke** (not a commit): real engine + curl + haiku turn; result
   recorded in the docs commit message.
5. **Docs:** counts, CLAUDE.md WIP + file map, PROGRESS, goal doc S9
   note (split recorded), rotate plan, INDEX, NEXT-SESSION (PR #34 is
   next).

## Deferred (named)

- `TODO(attachments-multipart)` — streaming upload for large files.
- PR #34: composer picker + drag-drop + chips; ChatMessage image block
  + history rendering via the serving route; sweeper interplay is S10.

## Commits

1. `docs(plans): PR #33 attachments-intake plan + INDEX row`
2. `feat(contracts,engine): attachments intake/serve routes + turn-body attachments + spine T1.20`
3. `docs: land PR #33 — rotate plan, SPINE/CLAUDE/PROGRESS refresh (smoke result recorded)`
