/**
 * Settings error taxonomy.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md §"Validation".
 */

export type SettingsCorruptReason = 'parse' | 'schema';

/**
 * Raised when an existing on-disk `settings.json` cannot be loaded —
 * either it's not parseable JSON, or it contains a documented key with
 * the wrong type. The on-disk file is never touched in this error path.
 */
export class SettingsCorruptError extends Error {
  override readonly name = 'SettingsCorruptError';
  readonly reason: SettingsCorruptReason;
  readonly issues?: unknown;

  constructor(args: { reason: SettingsCorruptReason; detail: string; issues?: unknown }) {
    super(`settings corrupt (${args.reason}): ${args.detail}`);
    this.reason = args.reason;
    if (args.issues !== undefined) this.issues = args.issues;
  }
}

/**
 * Raised when a caller-supplied `ClaudeSettings` fails Zod validation
 * (e.g. unknown documented key, malformed theme value). The on-disk file
 * is not touched.
 */
export class SettingsValidationError extends Error {
  override readonly name = 'SettingsValidationError';
  readonly issues: unknown;

  constructor(args: { detail: string; issues: unknown }) {
    super(`settings validation failed: ${args.detail}`);
    this.issues = args.issues;
  }
}
