# PR #42 — the CLI's own model list and effort levels

_2026-10-27. The operator's ask: the model picker "still doesn't actually show
individual model identifiers available via the CC CLI", and the thinking levels
should be "the actual CC Thinking Effort Levels"; many models no longer
support thinking off. Closes `TODO(model-discovery)` from PR #24._

## Evidence (CLI 2.1.310)

- `claude --help`: `--effort <level>` takes `low, medium, high, xhigh, max`.
  `--effort auto` and unknown values print a warning and fall back to the
  default. `--effort ultracode` is accepted silently: the request carries
  effort `xhigh`, and the session gets an `ultra_effort_enter` attachment
  (multi-agent orchestration on). The interactive `/effort` offers
  `low|medium|high|xhigh|max|auto|ultracode`.
- With no `--effort`, haiku ran at `medium`: "auto" means "send no flag".
- The CLI has no flag that turns thinking off.
- The CLI lists its models in its reply to the stream-json `initialize`
  control request. Each entry has `value`, `resolvedModel`, `displayName`,
  `description`, `supportsEffort`, `supportedEffortLevels` (Opus 4.6 has no
  `xhigh`; Haiku 4.5 has no effort at all) and `supportsThinkingOff`. With
  `--settings '{"disableAllHooks":true}'` the reply takes about 0.6s, runs no
  hooks and writes no transcript.

## Decisions

1. **Vocabulary = `/effort`'s:** `auto | low | medium | high | xhigh | max |
   ultracode`. `auto` composes no `--effort`; every other level passes
   through verbatim. The old literals (`off think think_hard think_harder
   ultrathink`) are accepted on the wire as aliases (`normalizeThinkingEffort`,
   mapped to auto, low, medium, high and max), so an open tab running the old
   bundle keeps working. Any other value is still a 400 (PR #24 D3).
2. **Model list from the CLI.** `RealClaudeBackend.listModels(cwd?)` spawns the
   configured binary with hooks disabled, sends `initialize`, reads the
   `control_response`, and retires the process. The pure parser
   (`parseModelList`) keeps the fields we use and drops the rest. Results are
   cached for 10 minutes; concurrent callers share one probe in flight.
3. **`GET /models`** (opt-in: 404 `models not configured` when the backend has
   no `listModels`): `{ models, fetched_at }`, or 502 `{ error }` when the
   probe fails. The probe runs in the conversation cwd when one is
   configured, so project settings apply. Spine T1.21.
4. **Picker:** options come from `/models`, labelled `displayName ·
   resolvedModel`; the CLI's `default` entry is our Default (no `--model`).
   "Custom…" stays. If the list can't be loaded, the picker falls back to
   the curated aliases plus the resolved names learned from earlier turns, as
   before.
5. **Effort segments:** `Auto Low Medium High XHigh Max Ultracode`, gated by
   the selected model. Only the levels in `supportedEffortLevels` are
   enabled; Ultracode needs `xhigh`; a model without `supportsEffort` offers
   Auto only. When the model changes to one that lacks the chosen level, the
   choice resets to Auto. Ultracode's tooltip spells out the cost. The
   segment group's label becomes "Effort".

## Not done

- `TODO(thinking-off)`: some older models report `supportsThinkingOff`, but
  the CLI has no per-turn flag for it.

## Tests

contracts (vocabulary + aliases + ModelInfo), compose map, `parseModelList`
over a captured reply, a shim-driven `listModels` test (one probe, shared and
cached), route + spine T1.21, effort gating helpers, and the bar's options
(DOM).
