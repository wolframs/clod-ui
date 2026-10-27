# PR #31 — Phase 5.6: skills loader, step 1: discovery (completion goal S7)

Date: 2026-06-12. Spec: completion goal S7 (investigate-first);
v2 Task 5.6. Substrate: `ComposeResult.pendingSkills` is
surfaced-but-unhandled by design; no skills surface exists anywhere.

## Investigation result (pins the scope)

Local CLI 2.1.175 (`claude --help`, no token spend):

- Skills resolve via `/skill-name` **in the prompt text** — loading is
  implicit from the skills directories; there is no per-skill argv.
- The only argv lever is `--disable-slash-commands` ("Disable all
  skills") — all-or-nothing, wrong shape for per-turn enablement.
- A skill is a directory containing `SKILL.md` (frontmatter with
  `description:`), under `~/.claude/skills/` (user) or
  `<cwd>/.claude/skills/` (project).

**Step 2 (enablement via a `SkillsBackend` trait) is descoped**: no
safe, documented mechanism exists; the goal doc says do not invent one.
`TODO(skills-enablement)` planted at the `pendingSkills` surface. No
real-CLI smoke turn needed — the exit criterion's "explicitly deferred"
arm applies.

## Pinned decisions

- **D1 — `GET /skills`, opt-in (I-1).** `createApp({ skills: { dirs:
  Array<{ scope: 'user' | 'project'; path: string }> } })`; absent →
  `404 { error: 'skills not configured' }`. The production entrypoint
  resolves `<CLAUDE_HOME | ~/.claude>/skills` + `<cwd>/.claude/skills`
  (same resolution idiom as the settings path).
- **D2 — response shape.** `{ skills: SkillSummary[] }`,
  `SkillSummary = { name, scope: 'user' | 'project', path,
  description? }` (Zod in contracts; `client.getSkills()`). `name` =
  directory name; `description` = best-effort first `description:`
  value from SKILL.md frontmatter. Missing dir → contributes nothing;
  dir entry without SKILL.md → skipped (not a skill). Sorted by scope
  (user first) then name.
- **D3 — frontmatter parsing is pure and minimal.**
  `parseSkillDescription(text)` in the engine: first `description:`
  line inside the leading `---` block, quotes stripped; `undefined`
  otherwise. Not a YAML parser — one field, best-effort, never throws.
- **D4 — UI mirrors the settings panel.** `useSkills` (I-2: `idle |
  loading | ok | error | not_configured`, fetch-on-open) +
  `<SkillsPanel />` modal from a footer "Skills" button. Rows show
  name + scope badge + description; read-only — display is the whole
  feature (D-investigation). not_configured explains the engine flag.
  Escape priority chain gains the panel: help > settings > skills >
  cancel (order = most recently added sits after settings).
- **D5 — spine: new contract T1.18** (new route family → new T-id):
  (1) skills discovered from both scopes with descriptions, sorted;
  (2) missing/empty dirs → `{ skills: [] }`; (3) unconfigured → I-1
  404 body. 39 → 42 tests, 18 files.
- **D6 — markers (I-3).** `data-test="skills-panel"`,
  `data-state="loading|ok|empty|error|not_configured"`,
  `data-test="skills-row"` + `data-skill-name` + `data-scope`;
  footer `skills-open`.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Contracts + engine:** `SkillSummarySchema`/`SkillsResponseSchema` +
   barrel + `client.getSkills()`; `parseSkillDescription` (+ unit
   tests); `routes/skills.ts` + createApp option + production
   resolution; spine T1.18 + SPINE.md row.
3. **Web:** `use-skills.ts` (+ dom lifecycle tests), `skills-panel.tsx`
   (+ bun variants incl. empty + not_configured), footer button + App
   wiring (escape chain).
4. **Docs:** SPINE/README counts, CLAUDE.md WIP + file map, PROGRESS,
   goal doc S7 entry (descope recorded), rotate plan → landed, INDEX
   (both halves), NEXT-SESSION.md.

## Deferred (named TODOs planted in source)

- `TODO(skills-enablement)` — at `ComposeResult.pendingSkills`: revisit
  when the CLI documents a per-skill mechanism; until then skills are
  invoked by typing `/skill-name` in the prompt, which already works
  through the normal turn path.

## Commits

1. `docs(plans): PR #31 skills-discovery plan + INDEX row`
2. `feat(contracts,engine): GET /skills discovery route + spine T1.18`
3. `feat(web): skills panel (read-only discovery)`
4. `docs: land PR #31 — rotate plan, SPINE/CLAUDE/PROGRESS refresh`
