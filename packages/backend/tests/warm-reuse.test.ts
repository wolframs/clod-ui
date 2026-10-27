import { describe, expect, test } from 'bun:test';

import { splitArgv, warmReusable } from '../src/warm-reuse.ts';

/** Spec: plans/landed/2026-10-27-clod-ui-pr39-warm-sessions-v1.md §2. */

const base = ['claude', '-p', '--input-format', 'stream-json', '--model', 'opus'];
const warm = {
  argv: [...base, '--add-dir', '/c', '--add-dir', '/c/attachments'],
  cwd: '/c',
  sessionId: 's1',
};

describe('warmReusable', () => {
  const rows: Array<[string, Parameters<typeof warmReusable>[1], boolean]> = [
    [
      'same argv + resume of the warm session',
      { argv: [...base, '--resume', 's1', '--add-dir', '/c'], cwd: '/c', resume_session_id: 's1' },
      true,
    ],
    [
      'add-dirs a subset of the warm ones',
      {
        argv: [...base, '--resume', 's1', '--add-dir', '/c/attachments'],
        cwd: '/c',
        resume_session_id: 's1',
      },
      true,
    ],
    [
      'no resume id (fresh session asked for)',
      { argv: [...base, '--add-dir', '/c'], cwd: '/c' },
      false,
    ],
    [
      'resume of another session',
      { argv: [...base, '--add-dir', '/c'], cwd: '/c', resume_session_id: 's2' },
      false,
    ],
    [
      'different cwd',
      { argv: [...base, '--add-dir', '/c'], cwd: '/d', resume_session_id: 's1' },
      false,
    ],
    [
      'model changed',
      {
        argv: [...base.slice(0, -1), 'haiku', '--add-dir', '/c'],
        cwd: '/c',
        resume_session_id: 's1',
      },
      false,
    ],
    [
      'extra flag',
      {
        argv: [...base, '--add-dir', '/c', '--effort', 'high'],
        cwd: '/c',
        resume_session_id: 's1',
      },
      false,
    ],
    [
      'add-dir the warm process lacks',
      { argv: [...base, '--add-dir', '/elsewhere'], cwd: '/c', resume_session_id: 's1' },
      false,
    ],
    // PR #43: session controls beyond the composed --resume force a spawn.
    [
      'raw flags resume another session (--resume s2 after --resume s1)',
      {
        argv: [...base, '--resume', 's1', '--add-dir', '/c', '--resume', 's2'],
        cwd: '/c',
        resume_session_id: 's1',
      },
      false,
    ],
    [
      'raw --fork-session',
      {
        argv: [...base, '--resume', 's1', '--add-dir', '/c', '--fork-session'],
        cwd: '/c',
        resume_session_id: 's1',
      },
      false,
    ],
    ...['--continue', '-c', '--resume=s2', '--session-id', '--no-session-persistence'].map(
      (flag): [string, Parameters<typeof warmReusable>[1], boolean] => [
        `raw ${flag}`,
        { argv: [...base, '--resume', 's1', flag], cwd: '/c', resume_session_id: 's1' },
        false,
      ],
    ),
    [
      'resume id set but argv has no --resume (not a composed request)',
      { argv: [...base, '--add-dir', '/c'], cwd: '/c', resume_session_id: 's1' },
      false,
    ],
  ];
  for (const [name, next, expected] of rows) {
    test(name, () => expect(warmReusable(warm, next)).toBe(expected));
  }

  test('a warm process with no session yet never reuses', () => {
    const { sessionId: _s, ...noSession } = warm;
    expect(warmReusable(noSession, { argv: warm.argv, cwd: '/c', resume_session_id: 's1' })).toBe(
      false,
    );
  });
});

describe('splitArgv', () => {
  test('sets aside --resume and --add-dir pairs, keeps order of the rest', () => {
    expect(splitArgv(['a', '--resume', 'x', '-p', '--add-dir', '/d', '--model', 'm'])).toEqual({
      rest: ['a', '-p', '--model', 'm'],
      addDirs: new Set(['/d']),
    });
  });
});
