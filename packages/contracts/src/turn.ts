import { z } from 'zod';

/**
 * Per-turn control vocabulary shared by the turn POST body, the backend's
 * `TurnRequest`, and the web UI's controls.
 *
 * Spec: plans/2026-06-10-clod-ui-pr24-turn-controls-v1.md §D2.
 *
 * `'off'` and an absent field are argv-identical — both compose to no
 * `--effort` flag (see `THINKING_EFFORT_MAP` in `@clod-ui/backend`). The
 * UI therefore never sends `'off'`; it stays in the enum for wire
 * compatibility with callers that want to be explicit.
 */
/**
 * Vocabulary pinned by CLI 2.1.175 evidence (PR #37): `--effort` accepts
 * low | medium | high | xhigh | max. `'xhigh'` carries the CLI's own
 * level name — no invented synonym. Note the CLI *warns and ignores*
 * invalid values; our 400-on-unknown (PR #24 D3) is deliberately
 * stricter.
 */
export const ThinkingEffortSchema = z.enum([
  'off',
  'think',
  'think_hard',
  'think_harder',
  'xhigh',
  'ultrathink',
]);

export type ThinkingEffort = z.infer<typeof ThinkingEffortSchema>;

export const THINKING_EFFORT_VALUES = ThinkingEffortSchema.options;
