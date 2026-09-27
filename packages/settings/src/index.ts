/**
 * @clod-ui/settings — read/write `~/.claude/settings.json` with atomic IO,
 * `.bak` rotation, and a passthrough bucket for unknown keys.
 *
 * Spec: plans/2026-04-23-clod-ui-architecture-v2.md Task 3.6.
 * IMPL: plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md.
 */
export * from './types.ts';
export * from './errors.ts';
export * from './store.ts';
