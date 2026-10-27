import { z } from 'zod';

/**
 * Per-turn effort vocabulary shared by the turn POST body, the backend's
 * `TurnRequest`, and the web UI's controls.
 *
 * PR #42: exactly the CLI's own `/effort` levels (CLI 2.1.310). `'auto'`
 * sends no `--effort` (the model's default); every other level passes
 * through as `--effort <level>`. `'ultracode'` is accepted by `--effort`
 * although `--help` does not list it: effort `xhigh` plus the CLI's
 * multi-agent orchestration mode. The CLI warns and ignores unknown values;
 * our 400-on-unknown (PR #24 D3) is deliberately stricter.
 *
 * Spec: plans/landed/2026-10-27-clod-ui-pr42-models-and-effort-v1.md §1.
 */
export const ThinkingEffortSchema = z.enum([
  'auto',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode',
]);

export type ThinkingEffort = z.infer<typeof ThinkingEffortSchema>;

export const THINKING_EFFORT_VALUES = ThinkingEffortSchema.options;

/**
 * Pre-PR #42 names, still accepted on the wire so a tab running an older
 * bundle keeps working. Each maps to the `--effort` it used to compose.
 */
export const LEGACY_THINKING_EFFORT: Readonly<Record<string, ThinkingEffort>> = {
  off: 'auto',
  think: 'low',
  think_hard: 'medium',
  think_harder: 'high',
  ultrathink: 'max',
};

/** A current level, or a legacy alias mapped to one; undefined otherwise. */
export function normalizeThinkingEffort(raw: unknown): ThinkingEffort | undefined {
  const parsed = ThinkingEffortSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return typeof raw === 'string' ? LEGACY_THINKING_EFFORT[raw] : undefined;
}
