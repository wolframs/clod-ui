/**
 * Re-export from `@clod-ui/contracts` so this package has a single source of
 * truth for the `ClaudeSettings` shape. Older imports (`@clod-ui/settings`
 * type-only) keep working unchanged.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md §1.
 */
export {
  ClaudeSettingsSchema,
  ClaudeThemeSchema,
  DOCUMENTED_SETTINGS_KEYS,
} from '@clod-ui/contracts';
export type { ClaudeSettings, ClaudeTheme } from '@clod-ui/contracts';
