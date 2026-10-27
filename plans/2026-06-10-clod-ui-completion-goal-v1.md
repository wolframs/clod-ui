# Clod UI — Completion Goal (the remaining arc)

> **What this is:** the ordered queue of remaining slices, written to be
> fed to `/goal` in a fresh session. It is a _living reference_ (like the
> architecture doc), not a per-PR plan. **Every slice below still gets its
> own 80–120-line plan file before any code** — the house cadence in
> `CLAUDE.md` is not optional and this doc does not replace it.
>
> **Goal statement:** land every slice below (or descope it explicitly
> with rationale), at which point Clod UI is spec-complete minus Phase 8.
> Scope pinned with the operator 2026-06-10: Phase 8 stays out (network
> activation remains a deliberate human decision); real claude-CLI token
> spend is allowed _sparingly_; ordering is livable-first.

## Standing constraints (read before every slice)

1. **Cadence per slice:** plan file → contracts → pure logic → wiring →
   spine test if wire-observable → 3–5 commits, `bun run ci:fast` green
   before every commit (check the _exit code_, not piped tail output).
   Then the docs rotation: plan → `landed/`, INDEX row, SPINE/README
   counts, CLAUDE.md WIP, `docs/PROGRESS.md`, rewrite `NEXT-SESSION.md`.
2. **One slice at a time.** Never start slice N+1 with slice N's tree
   dirty or its docs rotation unfinished. A session may land multiple
   slices, but only sequentially and fully.
3. **Token spend (pinned: sparingly).** Real `claude -p` invocations are
   allowed for tape recording and one smoke turn per slice where honesty
   demands it. Use haiku + short prompts wherever possible. Never loop
   retries against the real CLI; if a real-CLI check fails twice, stop
   and leave it for the operator with a written repro.
4. **Ambiguity rule.** Prefer the pinned decisions in this doc and in
   `docs/INVARIANTS.md`. At a genuine unpinned fork, choose the
   _reversible_ option, name the decision in the slice's plan, and flag
   it in `NEXT-SESSION.md`. Block and ask only for: destructive actions,
   network exposure, writes to `~/.claude/settings.json` beyond the
   documented atomic path, or real scope changes.
5. **Safety pins.** Engine stays bound to `127.0.0.1`. No Phase 8
   surface gets activated. CC's real settings file is only ever touched
   through `@clod-ui/settings` (atomic + `.bak`, I-6).
6. **Reality wins.** If the codebase contradicts a slice entry here,
   trust the code, record the correction in the slice's plan, and amend
   this doc's entry in the same docs commit (this doc is living; per-PR
   plans stay immutable).
7. **Inspection moments.** Bugs found in already-landed work get named
   in the commit message and `NEXT-SESSION.md` before being fixed.

## The queue (livable-first)

Slices may be split or merged at plan time — the per-slice plan decides
and says why. Exit criteria are the contract.

### S1 — Phase 5.3: system-prompt editor ✅ (PR #25, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr25-system-prompt-editor-v1.md`.
> One amendment vs the entry below: not strictly UI-only — `parseTurnBody`
> now 400s a present-but-malformed `system_prompt` (PR #25 D1, extending
> PR #24 D3's closed-vocabulary rationale).

- **Substrate:** `system_prompt {mode, text}` already flows body →
  `parseTurnBody` → composer (`--append-system-prompt` /
  `--system-prompt`). UI-only plus tests.
- **Pinned:** append is the default; override shows a dismissible
  warning (ToS-conscious, v2 Task 5.3). Lives with the PR #24 controls
  (extend `TurnControls` + `<TurnControlsBar />` area — a collapsible
  editor, not a always-open textarea). Live char count; token estimate
  optional.
- **Exit:** spine extension (T1.17 file) pins body → argv for both
  modes; controls bar variants tested; per-conv state in App.

### S2 — Phase 7.2: honest dark mode ✅ (PR #26, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr26-dark-mode-v1.md`.
> Persistence: localStorage, as the entry's default. Bonus fix: the
> Tailwind config never defined a `card` color, so `bg-card` had been a
> silent no-op at 7 call sites — tokens added in both modes.

- **Pinned:** "honest" = a real designed dark palette over the existing
  shadcn-style tokens, not `invert`. Default follows
  `prefers-color-scheme`; manual toggle wins. Persistence: decide at
  plan time between localStorage and the settings `theme` key (the key
  exists in `ClaudeSettings`; writing it means writing CC's real
  settings file — if chosen, justify in the plan; localStorage is the
  reversible default).
- **Exit:** every component legible in both modes (walk the variants in
  the bun tests), `data-theme` attribute switch, toggle reachable in UI.

### S3 — Phase 7.1: keyboard map ✅ (PR #27, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr27-keyboard-map-v1.md`.
> As pinned: keymap as data, no library; Escape doubles as
> overlay-close > cancel (consumer-owned priority).

- **Pinned:** pure keymap module (`lib/keymap.ts`) + one hook; no
  library. Minimum: new conversation, focus composer, cancel active
  turn, prev/next conversation, `?` shortcut overlay. No collisions
  with browser/IME defaults; Enter behavior in Composer unchanged.
- **Exit:** keymap unit-tested as data; overlay component variant-tested;
  hook dom-tested.

### S4 — Phase 5.8: raw-flags escape hatch ✅ (PR #28, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr28-raw-flags-v1.md`.
> As pinned, plus: per-turn `extra_argv` lands after the (kept)
> backend-level `ComposeOptions.extraArgv` seam; malformed wire input
> is a 400 (PR #24 D3 stance), deliberately stricter than
> `allowed_tools`' silent filtering.

- **Substrate:** `ComposeOptions.extraArgv` exists, unplumbed.
- **Pinned:** becomes per-turn `extra_argv?: string[]` on the wire
  (validated: array of strings, parseTurnBody). UI: advanced field,
  collapsed + off by default, visible warning when non-empty. Appended
  verbatim _after_ composed flags (already the composer's contract).
- **Exit:** spine pins body → argv tail ordering; UI variants tested.

### S5 — Phase 5.5: active tools editor ✅ (PR #29, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr29-tools-editor-v1.md`.
> As pinned: curated checkboxes + `Tool(pattern)` chips +
> grammar helper; MCP discovery noted as out, not built.

- **Substrate:** `allowed_tools`/`disallowed_tools` already flow
  end-to-end (T1.02).
- **Pinned:** checkbox list over a curated builtin-tool list constant +
  free-form entries; Bash pattern chips (`Bash(npm run *)` style) with a
  small grammar helper. Per-conv, same `TurnControls` state. MCP tool
  discovery is OUT (no MCP surface exists yet) — note it, don't build it.
- **Exit:** spine extension pins both flags' passthrough; UI tested.

### S6 — Phase 5.4: preferences UI ✅ (PR #30, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr30-preferences-ui-v1.md`.
> As pinned: I-2 useSettings, schema-aware form, unknown read-only,
> diff preview gating PUT; verified live against a sandboxed
> CLAUDE_HOME (file + .bak observed).

- **Substrate:** `GET/PUT/PATCH /settings` + typed client methods exist;
  `useSettings` hook does not.
- **Pinned:** `useSettings` follows the I-2 discriminated template
  (`loading | ok | error | not_configured`). Form is schema-aware over
  documented keys only; `unknown` bucket rendered read-only. Show a
  diff preview before PUT; engine already does atomic + `.bak` (I-6).
- **Exit:** settings round-trip from the UI verified in dom tests;
  not_configured variant renders the "--persist" affordance.

### S7 — Phase 5.6: skills loader ✅ step 1 / descoped step 2 (PR #31, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr31-skills-discovery-v1.md`.
> Step 1 shipped (GET /skills + panel, spine T1.18). Step 2 descoped
> with evidence: CLI 2.1.175 resolves skills via /skill-name in prompt
> text and has no per-skill argv (only the all-or-nothing
> --disable-slash-commands). `TODO(skills-enablement)` planted.

- **Substrate:** `ComposeResult.pendingSkills` is surfaced-but-unhandled
  by design; enablement mechanism upstream is still moving.
- **Pinned:** investigate-first slice. Step 1: discovery + display only
  (engine route listing `~/.claude/skills/` + `<cwd>/.claude/skills/`,
  opt-in 404 contract I-1; sidebar/panel list). Step 2 (enablement via
  `SkillsBackend` trait) only if a safe, documented mechanism exists at
  plan time — otherwise descope step 2 with rationale and a planted
  `TODO(skills-enablement)`. Do not invent a mechanism.
- **Exit:** discovery route spine-pinned; UI lists skills; enablement
  either works against the real CLI (one sparing smoke turn) or is
  explicitly deferred.

### S8 — Phase 5.7: diagnostics panel ✅ (PR #32, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr32-diagnostics-v1.md`.
> As pinned: record-time redaction (raw system-prompt text never held),
> wire-only ring, repro JSON round-trips into ScriptedBackend
> (unit-pinned), spine T1.19. Phase 5 complete.

- **Pinned:** engine keeps a bounded per-turn diagnostics ring (argv
  with system-prompt text redacted, env keys only, stdin byte size,
  event timeline, exit/error) — wire-only, never in the manifest (I-8).
  Opt-in route (I-1). Hidden-by-default panel; "Copy repro" exports
  JSON that test-kit's ScriptedBackend can consume.
- **Exit:** spine pins the route shape + redaction; repro JSON
  round-trips into a test-kit replay in a unit test.

### S9 — Phase 6a: attachments intake + image turns ✅ (PR #33 + #34, 2026-06-12)

> Part 1 landed per `plans/landed/2026-06-12-clod-ui-pr33-attachments-intake-v1.md`:
> intake/serve routes, turn-body attachments, spine T1.20, and the
> real-CLI smoke (which corrected encodeStdin: the CLI rejects
> path-source image blocks; base64 source pinned — haiku read a red
> PNG and answered 'Red'). Part 2 (composer picker/drag-drop + image
> rendering in history) = PR #34; S9 closes with it.

- **Substrate:** composer (`encodeStdin`) already emits image
  content-blocks + `--add-dir` for attachment dirs; nothing upstream
  feeds it.
- **Pinned:** file-by-reference only (no byte inlining, per v2 6.x):
  intake route copies/links into the conversation dir's `attachments/`,
  returns typed metadata; `TurnRequest.attachments` populated from the
  composer UI (file picker + drag-drop). Images render in TurnView /
  history.
- **Exit:** spine pins intake route + attachments-in-body → stdin/argv;
  one real-CLI smoke turn with a small image (sparing-spend budget).

### S10 — Phase 6b: cleanup / orphan sweeper ✅ (PR #35, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr35-orphan-sweeper-v1.md`.
> Reference semantics pinned: name-appears-in-transcript-text
> (over-inclusive by design) + 24h grace window; dry-run default,
> deletion only via CLOD_UI_SWEEPER=delete; I-5 double-check pinned by
> a deterministic race test.

- **Pinned:** sweeper is a fire-and-forget worker with double-check
  (I-5 shape) over `attachments/`; never deletes anything referenced by
  manifest or transcript; dry-run mode default-on first.
- **Exit:** sweeper logic pure + unit-tested against fixture trees;
  wired behind an explicit engine option.

### S11 — ci:deep de-stubbing (Playwright) ✅ (PR #36, 2026-06-12)

> Landed per `plans/landed/2026-06-12-clod-ui-pr36-ci-deep-v1.md`.
> Five scenarios (the pinned six with new-conv+streamed-render shared);
> argv asserted via the S8 diagnostics route as pinned; planted-failure
> check done (exit 1) and unplanted.

- **Pinned:** Playwright drives the _built_ SPA against a real engine
  with ScriptedBackend (no real CLI in deep tier). Scenarios: boot →
  new conv → streamed turn renders → cancel → reconnect banner →
  controls change argv (assert via diagnostics route if S8 landed,
  else a recording backend). `scripts/ci.ts deep` runs it for real;
  GH Actions shim updated.
- **Exit:** `bun run ci:deep` green locally, exits non-zero on a
  planted failure (verify once, then unplant).

### S12 — ci:nightly de-stubbing (tapes + real-CLI smoke)

- **Pinned:** record L1 contract tapes against the real CLI (sparing:
  haiku, minimal prompts, a handful of invocations), check them into
  `tests/fixtures/cli-tapes/`; nightly replays tapes + runs one live
  smoke + flake shuffle. **This slice settles the effort-vocabulary
  question with evidence:** pin what `--effort` actually accepts; if
  the real vocabulary diverges from `THINKING_EFFORT_MAP` (e.g.
  `xhigh`), extend the contracts enum + map in this slice, citing the
  tape.
- **Exit:** `bun run ci:nightly` runs tapes hermetically; live smoke
  isolated behind an env guard so CI without CLI auth skips loudly.

### S13 — Phase 7.5: structured logging

- **Pinned:** engine logs become NDJSON lines (level, ts, subsystem,
  conv/turn ids where known) behind a tiny logger module; launcher
  passes through. No log files yet — stdout only; `TODO(log-files)`.
- **Exit:** log lines parse as JSON in a unit test; noisy paths
  (watcher ticks) stay quiet by default.

### S14 — Completion audit

- **Pinned:** the closing slice. Re-walk `docs/INVARIANTS.md`,
  `docs/SPINE.md`, README, PROGRESS, architecture v3 — refresh the
  drift ledger (v3 → v4 only if >5 rows, per the v3 rule). Sweep for
  stale `TODO(...)` markers: each one either gets a slice rationale in
  NEXT-SESSION or is closed. Declare the goal met in PROGRESS.md with
  Phase 8 explicitly parked.
- **Exit:** PROGRESS shows 5/6/7 complete + CI tiers live; NEXT-SESSION
  describes a finished campsite and what "optional Phase 8" would take.

## Out of scope (named, deliberate)

- **Phase 8** (auth/TLS/origin/QR, T6 tests) — parked by the operator's call.
- **Performance budgets (T5)** — remain provisional; ratification is its
  own future decision.
- **Phase 4 leftovers** (3-pane inspector layout, list virtualization) —
  not goal-gating; S8's panel may partially cover the inspector. Revisit
  at S14 if daily use demands them.

## Definition of done

Every slice S1–S14 landed or descoped-with-rationale; ci:fast/deep green
locally, nightly runnable; spine count grown per slice exits; all docs
current; working tree clean; `NEXT-SESSION.md` says so.
