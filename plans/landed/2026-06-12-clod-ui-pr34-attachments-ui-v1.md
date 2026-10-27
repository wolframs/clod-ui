# PR #34 — Phase 6a, part 2: composer attachments + image rendering (goal S9)

Date: 2026-06-12. Spec: completion goal S9 (closes it; part 1 = PR #33).
Substrate: `client.uploadAttachment` + `AttachmentMeta`;
`SubmitTurnInput.attachments`; transcripts now carry the API-standard
base64 image source in user messages (what `encodeStdin` sends, pinned
by the PR #33 smoke); `normalizeTranscriptLines` is the single
extension point for new block kinds (I-9 downstream).

## Pinned decisions

- **D1 — `useAttachmentUploads(conv_id)` hook owns upload state.**
  List of `{ meta: AttachmentMeta, status: 'uploading' | 'ready' |
  'error' }`; `addFiles(files)` (File → `arrayBuffer` → base64 →
  `uploadAttachment`), `remove(name)`, `clear()`. Per-conv reset via
  the adjust-on-prop pattern. Upload failures mark the chip 'error'
  (removable, never submitted).
- **D2 — Composer stays presentational.** New props: `attachments:
  UploadedAttachment[]`, `onAttachFiles(files: FileList)`,
  `onRemoveAttachment(name)`. Renders: a 📎 button + hidden
  `<input type="file" multiple>`, drag-over highlight on the form
  (`data-dragging`), and a chips row (name + size, × remove,
  `data-status`). Enter-to-send behavior untouched.
- **D3 — App submit:** ready attachments map to
  `{ path, content_type? }`; cleared after dispatch (the submit-error
  path keeps them, mirroring the text-retention rule).
- **D4 — ChatMessage gains an image block.** `ImageBlockSchema =
  { type: 'image', media_type: string, data_base64: string }` in
  contracts; `normalize.toBlock` maps `{type:'image',source:
  {type:'base64',media_type,data}}` (exactly what we send; other
  source types → skipped, additive-lenient like every block parser).
  History renders `<img src="data:<mt>;base64,<data>">` capped height
  — no serving round-trip needed for history (the data is in the
  transcript); the serving route remains for future thumbs/full-size.
- **D5 — markers (I-3).** `composer-attach`, `composer-file-input`,
  `composer-attachment-chip` (+ `data-name`, `data-status`),
  `composer-attachment-remove`, form `data-dragging`; history
  `image-block` (+ `data-media-type`).
- **D6 — no new spine.** T1.20 pins the wire; UI exits are dom-tested
  (upload → chip → submit carries paths; image block renders).

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Contracts + normalize:** image block schema + `toBlock` case +
   normalize unit tests (bun, in packages/transcripts).
3. **Web:** `lib/use-attachment-uploads.ts` (+ dom tests with stubbed
   client + File), Composer props/UI (+ bun variants + dom interaction),
   `ImageBlockView` in transcript-history (+ bun variant), App wiring.
4. **Docs:** CLAUDE/PROGRESS/goal S9 → ✅, rotate plan, INDEX,
   NEXT-SESSION (S10 next).

## Deferred (named)

- Pre-send thumbnails (object URLs) — chips show name+size only.
- `TODO(attachment-size-cap)` — engine accepts any size today; cap +
  friendly error when someone drops a 4K video.

## Commits

1. `docs(plans): PR #34 attachments-ui plan + INDEX row`
2. `feat(contracts,transcripts): ChatMessage image block + normalize mapping`
3. `feat(web): composer attachments (picker, drag-drop, chips) + history image rendering`
4. `docs: land PR #34 — close goal S9, rotate plan, refresh`
