import { describe, expect, test } from 'bun:test';

import { compose, THINKING_EFFORT_MAP } from '../src/compose.ts';
import type { TurnRequest } from '../src/types.ts';

/**
 * Flag-composer matrix. Each row is a small `TurnRequest` delta on top of
 * `base()`, paired with what the argv *must contain* (or must not contain).
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr3-flag-composer-v1.md §2.
 *       plans/2026-04-23-clod-ui-test-strategy-v1.md T2.1.
 */

function base(): TurnRequest {
  return {
    turn_id: 't1',
    conv_id: 'c1',
    user_message: 'hello',
    cwd: '/tmp/conv1',
  };
}

describe('compose — prefix invariants', () => {
  test('argv always starts with the required print + stream-json prefix', () => {
    const { argv } = compose(base());
    expect(argv.slice(0, 7)).toEqual([
      'claude',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  test('claudeBinary option replaces argv[0]', () => {
    const { argv } = compose(base(), { claudeBinary: '/opt/claude/bin/claude' });
    expect(argv[0]).toBe('/opt/claude/bin/claude');
  });

  test('bare request yields no resume/model/effort/system-prompt flags', () => {
    const { argv } = compose(base());
    for (const flag of [
      '--resume',
      '--model',
      '--effort',
      '--system-prompt',
      '--append-system-prompt',
      '--allowedTools',
      '--disallowedTools',
    ]) {
      expect(argv).not.toContain(flag);
    }
  });

  test('bare request always includes --add-dir <cwd>', () => {
    const { argv, cwd } = compose(base());
    expect(cwd).toBe('/tmp/conv1');
    const idx = argv.indexOf('--add-dir');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe('/tmp/conv1');
  });
});

describe('compose — resume', () => {
  test('resume_session_id emits --resume <id>', () => {
    const { argv } = compose({ ...base(), resume_session_id: 'sess-abc' });
    const idx = argv.indexOf('--resume');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe('sess-abc');
  });
});

describe('compose — model', () => {
  test('model emits --model <name>', () => {
    const { argv } = compose({ ...base(), model: 'sonnet' });
    const idx = argv.indexOf('--model');
    expect(argv[idx + 1]).toBe('sonnet');
  });
});

describe('compose — thinking effort', () => {
  const rows: Array<[NonNullable<TurnRequest['thinking_effort']>, string | null]> = [
    ['off', null],
    ['think', 'low'],
    ['think_hard', 'medium'],
    ['think_harder', 'high'],
    ['ultrathink', 'max'],
  ];
  for (const [input, expected] of rows) {
    test(`thinking_effort: ${input} → ${expected ?? 'no flag'}`, () => {
      const { argv } = compose({ ...base(), thinking_effort: input });
      if (expected === null) {
        expect(argv).not.toContain('--effort');
      } else {
        const idx = argv.indexOf('--effort');
        expect(idx).toBeGreaterThan(-1);
        expect(argv[idx + 1]).toBe(expected);
      }
    });
  }

  test('THINKING_EFFORT_MAP is exported and exhaustive', () => {
    expect(THINKING_EFFORT_MAP).toEqual({
      off: null,
      think: 'low',
      think_hard: 'medium',
      think_harder: 'high',
      ultrathink: 'max',
    });
  });
});

describe('compose — system prompt mode', () => {
  test('append mode → --append-system-prompt <text>', () => {
    const { argv } = compose({
      ...base(),
      system_prompt: { mode: 'append', text: 'be helpful' },
    });
    const idx = argv.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe('be helpful');
    expect(argv).not.toContain('--system-prompt');
  });

  test('override mode → --system-prompt <text>', () => {
    const { argv } = compose({
      ...base(),
      system_prompt: { mode: 'override', text: 'you are Clod' },
    });
    const idx = argv.indexOf('--system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(argv[idx + 1]).toBe('you are Clod');
    expect(argv).not.toContain('--append-system-prompt');
  });
});

describe('compose — tool allowlists', () => {
  test('allowed_tools single value', () => {
    const { argv } = compose({ ...base(), allowed_tools: ['Read'] });
    const idx = argv.indexOf('--allowedTools');
    expect(argv[idx + 1]).toBe('Read');
  });

  test('allowed_tools multiple values', () => {
    const { argv } = compose({ ...base(), allowed_tools: ['Read', 'Edit', 'Bash(git:*)'] });
    const idx = argv.indexOf('--allowedTools');
    expect(argv.slice(idx + 1, idx + 4)).toEqual(['Read', 'Edit', 'Bash(git:*)']);
  });

  test('disallowed_tools', () => {
    const { argv } = compose({ ...base(), disallowed_tools: ['Bash'] });
    const idx = argv.indexOf('--disallowedTools');
    expect(argv[idx + 1]).toBe('Bash');
  });

  test('both allowed and disallowed coexist', () => {
    const { argv } = compose({
      ...base(),
      allowed_tools: ['Read'],
      disallowed_tools: ['Bash'],
    });
    expect(argv).toContain('--allowedTools');
    expect(argv).toContain('--disallowedTools');
  });

  test('empty arrays omit the flag entirely', () => {
    const { argv } = compose({ ...base(), allowed_tools: [], disallowed_tools: [] });
    expect(argv).not.toContain('--allowedTools');
    expect(argv).not.toContain('--disallowedTools');
  });
});

describe('compose — attachments and --add-dir', () => {
  test('image attachment adds its dirname to --add-dir', () => {
    const { argv } = compose({
      ...base(),
      attachments: [{ path: '/home/u/pics/cat.png', content_type: 'image/png' }],
    });
    const dirs = argv.reduce<string[]>((acc, tok, i) => {
      if (argv[i - 1] === '--add-dir') acc.push(tok);
      return acc;
    }, []);
    expect(dirs).toContain('/tmp/conv1');
    expect(dirs).toContain('/home/u/pics');
  });

  test('duplicate dirs are deduped', () => {
    const { argv } = compose({
      ...base(),
      attachments: [
        { path: '/home/u/pics/a.png', content_type: 'image/png' },
        { path: '/home/u/pics/b.png', content_type: 'image/png' },
      ],
    });
    const pics = argv.filter((tok, i) => tok === '/home/u/pics' && argv[i - 1] === '--add-dir');
    expect(pics.length).toBe(1);
  });
});

describe('compose — skills (deferred)', () => {
  test('skills populate pendingSkills and emit no argv flag today', () => {
    const result = compose({ ...base(), skills: ['skill-a', 'skill-b'] });
    expect(result.pendingSkills).toEqual(['skill-a', 'skill-b']);
    // No skill-related flag is exposed by `claude --help` today; composer
    // deliberately adds none. A future SkillsBackend (Phase 5.6) may inject here.
    expect(result.argv.some((t) => /^--skill/.test(t))).toBe(false);
  });

  test('empty skills omits pendingSkills entirely', () => {
    const result = compose({ ...base(), skills: [] });
    expect(result.pendingSkills).toBeUndefined();
  });
});

describe('compose — extraArgv (raw-flags escape hatch)', () => {
  test('extraArgv is appended verbatim at the end', () => {
    const { argv } = compose(base(), { extraArgv: ['--fork-session', '--strict-mcp-config'] });
    expect(argv.slice(-2)).toEqual(['--fork-session', '--strict-mcp-config']);
  });

  test('extraArgv can override a composed flag by trailing duplication', () => {
    const { argv } = compose({ ...base(), model: 'sonnet' }, { extraArgv: ['--model', 'opus'] });
    // Both present; CLI's own arg parser resolves to the last occurrence.
    const modelIdx = argv.lastIndexOf('--model');
    expect(argv[modelIdx + 1]).toBe('opus');
  });
});

describe('compose — stdin stream-JSON payload', () => {
  function decode(bytes: Uint8Array): unknown {
    const text = new TextDecoder().decode(bytes).trimEnd();
    return JSON.parse(text);
  }

  test('ends with exactly one newline', () => {
    const { stdin } = compose({ ...base(), user_message: 'hello' });
    const text = new TextDecoder().decode(stdin);
    expect(text.endsWith('\n')).toBe(true);
    // Exactly one newline character total:
    expect(text.match(/\n/g)?.length ?? 0).toBe(1);
  });

  test('encodes a minimal text-only user message', () => {
    const { stdin } = compose({ ...base(), user_message: 'hello world' });
    expect(decode(stdin)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello world' }],
      },
    });
  });

  test('appends image content blocks for image attachments', () => {
    const { stdin } = compose({
      ...base(),
      user_message: 'look',
      attachments: [
        { path: '/tmp/a.png', content_type: 'image/png' },
        { path: '/tmp/notes.txt', content_type: 'text/plain' }, // non-image, excluded from stdin
      ],
    });
    expect(decode(stdin)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'path', path: '/tmp/a.png' } },
        ],
      },
    });
  });
});

describe('compose — T1.02 end-to-end shape', () => {
  test('resume + model + system_prompt(append) + allowed_tools together', () => {
    const { argv } = compose({
      ...base(),
      resume_session_id: 'sess-x',
      model: 'sonnet',
      system_prompt: { mode: 'append', text: 'extra' },
      allowed_tools: ['Read'],
    });
    // Spot-check ordering relationships the test strategy cares about:
    expect(argv.indexOf('--resume')).toBeGreaterThan(-1);
    expect(argv[argv.indexOf('--resume') + 1]).toBe('sess-x');
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('extra');
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read');
  });
});
