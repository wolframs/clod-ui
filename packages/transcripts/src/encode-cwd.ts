/**
 * Claude Code stores per-session JSONL transcripts at
 *
 *   <CLAUDE_HOME>/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * where `encoded-cwd` is the absolute path with `/` replaced by `-`. This
 * is a pure mapping; CC does not percent-encode anything else. We mirror
 * that exactly so writer (CC) and reader (us) agree on the path.
 *
 * Spec: `plans/landed/2026-04-23-clod-ui-pr7-transcript-watcher-v1.md` §"encodeCwd".
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}
