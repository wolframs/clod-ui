/**
 * Per-conversation turn controls (Phase 5.1/5.2) — the pure vocabulary
 * behind `<TurnControlsBar />`. `{}` means "the CLI decides": no
 * `--model`, no `--effort` (PR #24, D5/D6).
 *
 * Spec: plans/2026-06-10-clod-ui-pr24-turn-controls-v1.md.
 */
import type { ModelInfo, ThinkingEffort } from '@clod-ui/contracts';

/** Mirrors the wire shape (`SubmitTurnInput.system_prompt`). */
export interface SystemPrompt {
  mode: 'append' | 'override';
  text: string;
}

export interface TurnControls {
  model?: string;
  thinking_effort?: ThinkingEffort;
  system_prompt?: SystemPrompt;
  /**
   * Raw-flags editor draft (PR #28, D3): newline-separated argv tokens,
   * exactly as typed. The wire shape is `string[]` — see
   * `effectiveExtraArgv`.
   */
  extra_argv_text?: string;
  /**
   * Tool allow/disallow lists (PR #29, D1): wire-shaped chip entries
   * (`Read`, `Bash(npm run *)`). Never stored empty — helpers drop the
   * key so absent keeps meaning "the CLI decides".
   */
  allowed_tools?: string[];
  disallowed_tools?: string[];
}

/**
 * The system prompt a submit should carry: `undefined` unless the draft
 * has non-whitespace text (PR #25, D2). State may hold an empty draft so
 * the editor keeps the user's mode choice; the wire never sees it.
 */
export function effectiveSystemPrompt(controls: TurnControls): SystemPrompt | undefined {
  const sp = controls.system_prompt;
  if (sp === undefined || sp.text.trim().length === 0) return undefined;
  return sp;
}

/**
 * Editor text → argv tokens (PR #28, D3): one token per line, trimmed,
 * empties dropped. No shell quoting/splitting — `--model opus` is two
 * lines. Verbatim beyond that.
 */
export function parseExtraArgv(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The argv tail a submit should carry: `undefined` unless ≥ 1 token. */
export function effectiveExtraArgv(controls: TurnControls): string[] | undefined {
  const tokens = parseExtraArgv(controls.extra_argv_text ?? '');
  return tokens.length > 0 ? tokens : undefined;
}

/**
 * Curated builtin-tool list for the tools editor (PR #29, D2) — a UI
 * affordance, not a wire contract; free-form entries take anything the
 * CLI accepts. MCP tool discovery is deliberately absent: no MCP
 * surface exists in the engine yet.
 */
export const KNOWN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'NotebookEdit',
] as const;

export interface ToolEntry {
  name: string;
  pattern?: string;
}

/**
 * The "small grammar helper" (PR #29, D3): a tool entry is a bare name
 * (`Read`) or `Name(pattern)` (`Bash(npm run *)`). Returns null for
 * malformed input — empty name, empty pattern, unbalanced or trailing
 * text after the closing paren. Not a shell parser.
 */
export function parseToolEntry(raw: string): ToolEntry | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  const open = text.indexOf('(');
  if (open === -1) {
    return /^[A-Za-z][\w-]*$/.test(text) ? { name: text } : null;
  }
  const name = text.slice(0, open);
  if (!/^[A-Za-z][\w-]*$/.test(name)) return null;
  if (!text.endsWith(')')) return null;
  const pattern = text.slice(open + 1, -1);
  if (pattern.trim().length === 0 || pattern.includes('(') || pattern.includes(')')) return null;
  return { name, pattern };
}

export function formatToolEntry(entry: ToolEntry): string {
  return entry.pattern === undefined ? entry.name : `${entry.name}(${entry.pattern})`;
}

/**
 * Add or remove an entry in a tool list, deduped; returns `undefined`
 * for an empty result so the TurnControls key can be dropped (D1).
 */
export function toggleToolEntry(
  list: string[] | undefined,
  entry: string,
  present: boolean,
): string[] | undefined {
  const current = list ?? [];
  const without = current.filter((e) => e !== entry);
  const next = present ? [...without, entry] : without;
  return next.length > 0 ? next : undefined;
}

/**
 * Fallback model choices, as CLI aliases, for when the CLI's own list
 * (`GET /models`, PR #42) cannot be loaded. "Custom…" in the UI accepts any
 * string the CLI's `--model` takes (full IDs included).
 */
export const KNOWN_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;

export function isKnownModel(model: string, models?: readonly ModelInfo[]): boolean {
  if (models !== undefined) return models.some((m) => m.value === model);
  return (KNOWN_MODELS as readonly string[]).includes(model);
}

/**
 * The CLI's own effort levels (PR #42), in `/effort`'s order. `auto` and an
 * unset field compose to the same argv (no `--effort`), so the bar shows
 * Auto selected for both and stores Auto as "unset".
 */
export const EFFORT_OPTIONS: ReadonlyArray<{
  value: ThinkingEffort;
  label: string;
  title: string;
}> = [
  {
    value: 'auto',
    label: 'Auto',
    title: "No --effort: the model's own default. Current models cannot turn thinking off.",
  },
  { value: 'low', label: 'Low', title: '--effort low' },
  { value: 'medium', label: 'Medium', title: '--effort medium' },
  { value: 'high', label: 'High', title: '--effort high' },
  { value: 'xhigh', label: 'XHigh', title: '--effort xhigh' },
  { value: 'max', label: 'Max', title: '--effort max' },
  {
    value: 'ultracode',
    label: 'Ultracode',
    title:
      "--effort ultracode: xhigh effort plus the CLI's multi-agent orchestration (workflows). Can spend a lot.",
  },
];

/** The CLI's entry for a picker value (`undefined` model = the `default` entry). */
export function modelInfoFor(
  models: readonly ModelInfo[] | undefined,
  model: string | undefined,
): ModelInfo | undefined {
  return models?.find((m) => m.value === (model ?? 'default'));
}

/**
 * Whether `level` is offered for this model. Without the CLI's entry (list
 * not loaded, custom id) every level stays offered. Ultracode runs at
 * xhigh, so it needs xhigh; a model without effort control offers Auto only.
 */
export function effortAllowed(level: ThinkingEffort, info: ModelInfo | undefined): boolean {
  if (level === 'auto' || info === undefined) return true;
  const levels = info.effort_levels;
  if (levels === undefined) return false;
  return levels.includes(level === 'ultracode' ? 'xhigh' : level);
}

/** Drop an effort the (new) model does not take, so the turn falls back to Auto. */
export function reconcileEffort(controls: TurnControls, info: ModelInfo | undefined): TurnControls {
  const effort = controls.thinking_effort;
  if (effort === undefined || effortAllowed(effort, info)) return controls;
  const { thinking_effort: _effort, ...rest } = controls;
  return rest;
}
