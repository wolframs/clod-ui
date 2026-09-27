/**
 * Manifest corruption taxonomy. Distinct kinds let callers decide whether to
 * surface as a `transcript_corrupt`-flavored ClodError, refuse to open the
 * conversation, or attempt repair.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr6-sqlite-manifest-v1.md §1.
 */
export type ManifestCorruptReason = 'parse' | 'seq' | 'hash' | 'truncated';

export class ManifestCorruptError extends Error {
  readonly line: number;
  readonly reason: ManifestCorruptReason;
  readonly path?: string;

  constructor(args: {
    line: number;
    reason: ManifestCorruptReason;
    path?: string;
    detail?: string;
  }) {
    const detail = args.detail ? `: ${args.detail}` : '';
    super(`manifest corrupt at line ${args.line} (${args.reason})${detail}`);
    this.name = 'ManifestCorruptError';
    this.line = args.line;
    this.reason = args.reason;
    if (args.path !== undefined) this.path = args.path;
  }
}
