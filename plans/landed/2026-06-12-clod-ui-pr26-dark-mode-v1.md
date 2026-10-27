# PR #26 — Phase 7.2: honest dark mode (completion goal S2)

Date: 2026-06-12. Spec: completion goal S2
(`plans/2026-06-10-clod-ui-completion-goal-v1.md`). Substrate: shadcn-style
HSL tokens in `apps/web/src/index.css` with a scaffold `.dark` block that
has been unreachable since PR #1 (nothing ever sets the class), and
`darkMode: ['class']` in `tailwind.config.cjs`. Several components already
carry (dormant) `dark:` variants.

## Inspection moments (named before fixing, standing constraint 7)

- **`bg-card` is a silent no-op.** 7 call sites (Composer, ToolCards,
  Sidebar empty card, jump-to-bottom, history rows) use `bg-card`, but the
  Tailwind config defines no `card` color — the class generates no CSS and
  every "card" surface inherits its parent background. Invisible in light
  mode only because card-white ≈ background-white. Fixed here by adding
  the `--card` / `--card-foreground` tokens.
- **Scaffold `.dark` block never wired** — this slice is the wiring.

## Pinned decisions

- **D1 — `data-theme` attribute switch (goal pin).** `darkMode:
  ['selector', '[data-theme="dark"]']` (Tailwind 3.4-native); the CSS
  block becomes `[data-theme='dark']`. Applied to `<html>`
  (`document.documentElement`). All dormant `dark:` variants go live.
- **D2 — designed dark palette over our tokens, not `invert`.** Tuned
  from the scaffold: softened near-black blue-gray background, slightly
  elevated `--card`, desaturated borders, muted-foreground lifted for
  contrast. `--card`/`--card-foreground` added to **both** modes + config.
- **D3 — three-state preference, localStorage persistence.**
  `ThemePreference = 'system' | 'light' | 'dark'` in pure `lib/theme.ts`:
  `parseThemePreference` (unknown → `'system'`), `resolveTheme(pref,
  systemPrefersDark)`, `nextThemePreference` (cycle system → light →
  dark), `THEME_STORAGE_KEY = 'clod-ui:theme'`. Default follows
  `prefers-color-scheme`; a manual choice wins (goal pin). Persistence is
  localStorage — the settings `theme` key describes Claude Code's own
  terminal theme, not this web UI; writing CC's real settings file for a
  web-local preference would conflate the two surfaces (descoped, no TODO
  — it's a different feature, not deferred work).
- **D4 — `useTheme` hook owns the side effects (I-4).** Lazy-init from
  localStorage; applies `dataset.theme = resolved` in an effect;
  subscribes to `matchMedia('(prefers-color-scheme: dark)')` changes,
  which re-resolve only while preference is `'system'`; `setPreference`
  persists + applies immediately. Components stay pure.
- **D5 — `<ThemeToggle />` pure presentational**, in the App footer next
  to HealthBadge. Cycles via `nextThemePreference`. Markers (I-3):
  `data-test="theme-toggle"`, `data-preference`, `data-resolved`. Label
  shows the preference ("System" / "Light" / "Dark").
- **D6 — FOUC guard: inline script in `index.html`.** Reads the storage
  key + matchMedia and sets `data-theme` before first paint. Mirrors
  `lib/theme.ts` resolve logic; breadcrumb comments point both ways
  (I-9 precedent for mirrored copies).
- **D7 — legibility sweep result.** Audit of all hardcoded palette
  classes: only ConnectionBanner's reconnecting variant
  (`text-amber-700`) lacks a dark variant → add `dark:text-amber-400`.
  Everything else already pairs (`turn-view`, `health-badge`,
  `transcript-history`, `markdown`) or is mode-neutral (alpha overlays,
  `*-500` dots). Verification: build the SPA, boot the engine
  (ScriptedBackend not needed — no turns), Playwright screenshot in both
  themes; walk the bun variant tests as the component checklist.
- **D8 — no spine change.** Theme is not wire-observable; exit criteria
  are component/dom tests + the visual walk.

## Work plan (cadence order)

1. **Plan** (this file) + INDEX row.
2. **Pure logic:** `lib/theme.ts` + `tests/theme.test.ts` (bun, data-only).
3. **Wiring:** tokens (index.css both modes + card), tailwind selector,
   index.html FOUC script, `lib/use-theme.ts`, `components/theme-toggle.tsx`,
   App footer, ConnectionBanner dark variant. Tests: bun variants for
   ThemeToggle; vitest dom for `useTheme` (stubbed matchMedia +
   localStorage: system default, manual wins + persists, system-change
   re-resolve only under `'system'`, dataset applied).
4. **Visual verification** (not a commit): `bun run --filter @clod-ui/web
   build`, boot, Playwright screenshots light + dark.
5. **Docs:** README known-gaps line, CLAUDE.md WIP + file map, PROGRESS,
   goal doc S2 entry, rotate plan → landed, INDEX, NEXT-SESSION.md.

## Commits

1. `docs(plans): PR #26 dark-mode plan + INDEX row`
2. `feat(web): theme module — preference vocabulary + resolution (pure)`
3. `feat(web): honest dark mode — tokens, data-theme switch, useTheme + ThemeToggle`
4. `docs: land PR #26 — rotate plan, CLAUDE/PROGRESS refresh`
