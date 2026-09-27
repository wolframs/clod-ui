import type { ClodError } from '@clod-ui/contracts';

/**
 * Classify a CLI failure into a structured `ClodError`.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr5-cancel-ladder-and-taxonomy-v1.md §1
 *       plans/2026-04-23-clod-ui-architecture-v2.md Task 2.6 (error taxonomy)
 *
 * Pure. No I/O. Patterns are substring-case-insensitive unless otherwise noted.
 * Priority (highest first):
 *   auth_failed → rate_limited → tool_denied → model_unavailable → cli_crashed.
 * Fallback preserves `raw_stderr` + `exit_code` + `signal` so no information is lost.
 */

export interface ClassifyInput {
  raw_stderr?: string;
  exit_code?: number;
  signal?: string;
  /** The `subtype` field of a stream-JSON `result` event, when applicable. */
  cli_subtype?: string;
}

const AUTH_PATTERNS: RegExp[] = [
  /not authenticated/i,
  /please run[^.\n]*claude\s+login/i,
  /unauthori[sz]ed/i,
  /\bapi[\s_-]?key\b/i,
  /\bcredentials?\b/i,
  /authentication\s+failed/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[\s-]?limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota\s+exceeded/i,
];

const TOOL_DENIED_PATTERNS: RegExp[] = [
  /tool\s+\S+\s+(is\s+)?(not\s+allowed|denied|refused)/i,
  /permission\s+denied\s+for\s+tool/i,
  // Match "allowedtools" only at the start of a stderr line to avoid false-positives
  // on our own argv being echoed somewhere in error output.
  /^\s*allowed[\s_-]?tools\b/im,
];

const MODEL_UNAVAILABLE_PATTERNS: RegExp[] = [
  /model\s+\S+\s+(is\s+)?not\s+(available|found|supported)/i,
  /unknown\s+model/i,
  /invalid\s+model/i,
];

/**
 * Parse `retry_after_ms` from rate-limit stderr. Supports two common shapes:
 *   1. `Retry-After: 42` (HTTP-header-style, integer seconds)
 *   2. `try again in 12s` / `retry in 12 seconds`
 */
function parseRetryAfter(stderr: string): number | undefined {
  const headerMatch = /Retry-After\s*:\s*(\d+)/i.exec(stderr);
  if (headerMatch !== null) {
    return Number.parseInt(headerMatch[1] ?? '0', 10) * 1000;
  }
  const phraseMatch = /(?:try\s+again|retry)\s+in\s+(\d+)\s*s(?:ec(?:ond)?s?)?\b/i.exec(stderr);
  if (phraseMatch !== null) {
    return Number.parseInt(phraseMatch[1] ?? '0', 10) * 1000;
  }
  return undefined;
}

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

function shortDetail(stderr: string, fallback: string): string {
  const firstLine = stderr.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim().slice(0, 200) ?? fallback;
}

export function classifyCliFailure(input: ClassifyInput): ClodError {
  const stderr = input.raw_stderr ?? '';
  const subtype = input.cli_subtype;

  // Well-known cli_subtype values — prefer subtype-driven classification when
  // the stderr itself is ambiguous.
  if (subtype === 'error_max_turns') {
    return {
      kind: 'cli_crashed',
      retryable: false,
      detail: 'conversation exceeded max turns',
      ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(stderr ? { raw_stderr: stderr } : {}),
    };
  }

  // Pattern-based classification over stderr.
  if (stderr.length > 0) {
    // auth_failed wins over rate_limited: if auth is broken, retry won't help.
    if (matches(AUTH_PATTERNS, stderr)) {
      return {
        kind: 'auth_failed',
        retryable: false,
        detail: shortDetail(stderr, 'authentication failed'),
        raw_stderr: stderr,
      };
    }
    if (matches(RATE_LIMIT_PATTERNS, stderr)) {
      const retryAfter = parseRetryAfter(stderr);
      return {
        kind: 'rate_limited',
        retryable: true,
        ...(retryAfter !== undefined ? { retry_after_ms: retryAfter } : {}),
        detail: shortDetail(stderr, 'rate limited'),
        raw_stderr: stderr,
      };
    }
    if (matches(TOOL_DENIED_PATTERNS, stderr)) {
      return {
        kind: 'tool_denied',
        retryable: false,
        detail: shortDetail(stderr, 'tool denied'),
        raw_stderr: stderr,
      };
    }
    if (matches(MODEL_UNAVAILABLE_PATTERNS, stderr)) {
      return {
        kind: 'model_unavailable',
        retryable: false,
        detail: shortDetail(stderr, 'model unavailable'),
        raw_stderr: stderr,
      };
    }
  }

  // Unknown subtype — still cli_crashed but preserve the subtype name in detail.
  const detailFromSubtype =
    subtype !== undefined && subtype !== 'error_during_execution' && subtype !== 'success'
      ? `CLI reported subtype=${subtype}`
      : undefined;

  return {
    kind: 'cli_crashed',
    retryable: true,
    detail: detailFromSubtype ?? shortDetail(stderr, 'CLI crashed'),
    ...(input.exit_code !== undefined ? { exit_code: input.exit_code } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(stderr ? { raw_stderr: stderr } : {}),
  };
}
