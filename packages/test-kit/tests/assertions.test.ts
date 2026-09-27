import type { EventEnvelope } from '@clod-ui/contracts';
import { describe, expect, test } from 'bun:test';

import {
  ArgvMismatchError,
  SequenceAssertionError,
  expectArgvMatches,
  expectEventSequence,
  expectFileTreeMatches,
  expectManifestFold,
} from '../src/index.ts';

const mkEnv = (kind: string, conv = 'c1'): EventEnvelope => ({
  v: 1,
  id: `00000000-0000-4000-8000-${kind.padEnd(12, '0').slice(0, 12)}`,
  ts: 0,
  kind,
  conv_id: '00000000-0000-4000-8000-00000000000c',
  payload: { _: conv },
});

describe('expectEventSequence', () => {
  test('ordered happy path', () => {
    expect(() =>
      expectEventSequence(
        [mkEnv('a'), mkEnv('b'), mkEnv('c')],
        [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }],
        { mode: 'ordered' },
      ),
    ).not.toThrow();
  });

  test('ordered failure', () => {
    expect(() =>
      expectEventSequence([mkEnv('a'), mkEnv('x')], [{ kind: 'a' }, { kind: 'b' }], {
        mode: 'ordered',
      }),
    ).toThrow(SequenceAssertionError);
  });

  test('partial matches subset in order', () => {
    expect(() =>
      expectEventSequence(
        [mkEnv('a'), mkEnv('noise'), mkEnv('b'), mkEnv('c')],
        [{ kind: 'a' }, { kind: 'c' }],
        { mode: 'partial' },
      ),
    ).not.toThrow();
  });

  test('unordered matches regardless of order', () => {
    expect(() =>
      expectEventSequence(
        [mkEnv('c'), mkEnv('a'), mkEnv('b')],
        [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }],
        { mode: 'unordered' },
      ),
    ).not.toThrow();
  });
});

describe('expectArgvMatches', () => {
  test('happy path', () => {
    expect(() =>
      expectArgvMatches(['-p', '--model', 'haiku'], ['-p', '--model', 'haiku']),
    ).not.toThrow();
  });

  test('allowExtra filters additional flag+value', () => {
    expect(() =>
      expectArgvMatches(
        ['-p', '--model', 'haiku', '--verbose', 'yes'],
        ['-p', '--model', 'haiku'],
        {
          allowExtra: ['--verbose'],
        },
      ),
    ).not.toThrow();
  });

  test('mismatch throws', () => {
    expect(() => expectArgvMatches(['-p'], ['-p', '--model', 'haiku'])).toThrow(ArgvMismatchError);
  });
});

describe('expectManifestFold', () => {
  test('identity fold passes', () => {
    const events = [mkEnv('conversation.created')];
    expect(() => expectManifestFold(events, events)).not.toThrow();
  });

  test('mismatch throws', () => {
    expect(() => expectManifestFold([mkEnv('a')], [mkEnv('b')])).toThrow();
  });
});

describe('expectFileTreeMatches', () => {
  const pkgRoot = new URL('..', import.meta.url).pathname;

  test('matches existing tree', () => {
    // Use the test-kit package dir itself as a stable tree.
    expect(() =>
      expectFileTreeMatches(pkgRoot, {
        src: { 'index.ts': true },
      }),
    ).not.toThrow();
  });

  test('missing entry throws', () => {
    expect(() => expectFileTreeMatches(pkgRoot, { 'does-not-exist-xyz': true })).toThrow();
  });
});
