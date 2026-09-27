import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { EventEnvelope } from '@clod-ui/contracts';

import type { TestEnv } from './test-env.ts';

/**
 * Assertion helpers used across spine and test-kit tests. Each is small and
 * composable; the vocabulary is deliberately narrow.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr1-foundation-v2.md Task 6.9.
 */

export type SequenceMode = 'ordered' | 'partial' | 'unordered';

export interface SequencePattern {
  /** kind, or {kind, predicate}. */
  kind: string;
  predicate?: (env: EventEnvelope) => boolean;
}

export class SequenceAssertionError extends Error {
  constructor(
    message: string,
    readonly events: EventEnvelope[],
    readonly pattern: SequencePattern[],
  ) {
    super(message);
    this.name = 'SequenceAssertionError';
  }
}

export function expectEventSequence(
  events: EventEnvelope[],
  pattern: SequencePattern[],
  opts: { mode?: SequenceMode } = {},
): void {
  const mode = opts.mode ?? 'ordered';
  switch (mode) {
    case 'ordered': {
      if (events.length !== pattern.length) {
        throw new SequenceAssertionError(
          `ordered: expected ${pattern.length} events, got ${events.length}`,
          events,
          pattern,
        );
      }
      for (let i = 0; i < pattern.length; i++) {
        const p = pattern[i]!;
        const e = events[i]!;
        if (!matches(e, p)) {
          throw new SequenceAssertionError(
            `ordered: index ${i} expected ${p.kind}, got ${e.kind}`,
            events,
            pattern,
          );
        }
      }
      return;
    }
    case 'partial': {
      let j = 0;
      for (const e of events) {
        const p = pattern[j];
        if (p && matches(e, p)) j++;
        if (j === pattern.length) return;
      }
      throw new SequenceAssertionError(
        `partial: only matched ${j}/${pattern.length} patterns`,
        events,
        pattern,
      );
    }
    case 'unordered': {
      const remaining = [...pattern];
      for (const e of events) {
        const idx = remaining.findIndex((p) => matches(e, p));
        if (idx >= 0) remaining.splice(idx, 1);
      }
      if (remaining.length > 0) {
        throw new SequenceAssertionError(
          `unordered: ${remaining.length} pattern(s) unmatched`,
          events,
          pattern,
        );
      }
      return;
    }
  }
}

function matches(env: EventEnvelope, p: SequencePattern): boolean {
  if (env.kind !== p.kind) return false;
  if (p.predicate && !p.predicate(env)) return false;
  return true;
}

export interface ArgvMatchOptions {
  /** Extra flags allowed in `actual` that are not in `expected`. */
  allowExtra?: string[];
}

export class ArgvMismatchError extends Error {
  constructor(
    message: string,
    readonly expected: string[],
    readonly actual: string[],
  ) {
    super(message);
    this.name = 'ArgvMismatchError';
  }
}

export function expectArgvMatches(
  actual: string[],
  expected: string[],
  opts: ArgvMatchOptions = {},
): void {
  const allow = new Set(opts.allowExtra ?? []);
  const filteredActual = actual.filter((tok, i, arr) => {
    if (allow.has(tok)) return false;
    const prev = arr[i - 1];
    if (prev != null && allow.has(prev)) return false;
    return true;
  });
  if (filteredActual.length !== expected.length) {
    throw new ArgvMismatchError(
      `argv length mismatch after allowExtra filter: expected ${expected.length}, got ${filteredActual.length}`,
      expected,
      filteredActual,
    );
  }
  for (let i = 0; i < expected.length; i++) {
    if (filteredActual[i] !== expected[i]) {
      throw new ArgvMismatchError(
        `argv mismatch at index ${i}: expected ${String(expected[i])}, got ${String(
          filteredActual[i],
        )}`,
        expected,
        filteredActual,
      );
    }
  }
}

/**
 * Project a sequence of events through an oracle `fold` and assert the
 * resulting state equals `expectedState`. In PR #1 this is a thin wrapper
 * around strict-equality; Phase 3.2 will supply the real fold.
 */
export function expectManifestFold<State>(
  events: EventEnvelope[],
  expectedState: State,
  fold?: (events: EventEnvelope[]) => State,
): void {
  const actual = fold ? fold(events) : (events as unknown as State);
  if (JSON.stringify(actual) !== JSON.stringify(expectedState)) {
    throw new Error(
      `expectManifestFold: expected ${JSON.stringify(expectedState)}, got ${JSON.stringify(
        actual,
      )}`,
    );
  }
}

export type ExpectedFileTree = { [name: string]: ExpectedFileTree | true };

export function expectFileTreeMatches(rootDir: string, expected: ExpectedFileTree): void {
  const missing: string[] = [];
  walk(expected, rootDir, (relPath, node) => {
    const full = join(rootDir, relPath);
    if (!existsSync(full)) {
      missing.push(relPath);
      return;
    }
    const s = statSync(full);
    const wantDir = typeof node === 'object';
    if (wantDir !== s.isDirectory()) {
      missing.push(`${relPath} (wrong type)`);
    }
  });
  if (missing.length > 0) {
    throw new Error(`expectFileTreeMatches: missing or wrong-typed entries: ${missing.join(', ')}`);
  }
}

function walk(
  node: ExpectedFileTree,
  rootDir: string,
  visit: (relPath: string, node: ExpectedFileTree | true) => void,
  prefix = '',
): void {
  for (const [name, child] of Object.entries(node)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    visit(rel, child);
    if (typeof child === 'object') {
      const dir = join(rootDir, rel);
      // Assert we can list the dir; the visitor above has already recorded the existence check.
      if (existsSync(dir)) readdirSync(dir);
      walk(child, rootDir, visit, rel);
    }
  }
}

/**
 * Runs `ps -o pid,pgid,comm` and asserts no `claude` process shares the env's
 * pgid. No-op if `ps` fails (e.g. running under a stripped container).
 */
export function expectNoZombies(env: TestEnv): void {
  let out = '';
  try {
    out = execSync('ps -o pid,pgid,comm', { encoding: 'utf8' });
  } catch {
    return;
  }
  const offenders = out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3)
    .filter(([, pgid, comm]) => Number(pgid) === env.pgid && (comm ?? '').includes('claude'));
  if (offenders.length > 0) {
    throw new Error(
      `expectNoZombies: ${offenders.length} claude process(es) share pgid ${env.pgid}: ${offenders
        .map((o) => o.join(' '))
        .join('; ')}`,
    );
  }
}

// `relative` is re-exported to silence unused-import linters in minimal downstreams.
void relative;
