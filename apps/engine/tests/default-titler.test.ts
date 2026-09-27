/**
 * Unit tests for `DefaultTitler` (PR #11).
 *
 * Spec: plans/landed/2026-04-26-clod-ui-pr11-default-titler-v1.md §Tests
 *
 * All tests use the `invokeForTest` seam — no actual subprocess spawns,
 * which makes them deterministic and fast. The integration of *any* Titler
 * with the engine is already covered by `auto-titling.test.ts` from PR #10;
 * this file pins DefaultTitler-specific behavior (prompt shape, output
 * cleaning, fallback delegation, argv composition).
 */
import { describe, expect, test } from 'bun:test';

import { cleanTitle, DefaultTitler } from '../src/default-titler.ts';
import type { Titler, TitlerInput } from '../src/titler.ts';

const FIXED_TS = 1_700_000_000_000;

const BASIC_INPUT: TitlerInput = {
  conv_id: 'c',
  user_message: 'Help me refactor the login form.',
  assistant_text: 'Sure, here is what I propose...',
  ts: FIXED_TS,
};

class CapturingFallback implements Titler {
  public calls: TitlerInput[] = [];
  constructor(private readonly fixed: string = 'fallback-derived') {}
  async suggestTitle(input: TitlerInput): Promise<string> {
    this.calls.push(input);
    return this.fixed;
  }
}

describe('DefaultTitler — happy paths (clean Haiku replies)', () => {
  test('clean reply returned verbatim', async () => {
    const fallback = new CapturingFallback();
    const titler = new DefaultTitler({
      invokeForTest: async () => 'Refactor the login form',
      fallback,
    });
    const out = await titler.suggestTitle(BASIC_INPUT);
    expect(out).toBe('Refactor the login form');
    expect(fallback.calls).toHaveLength(0);
  });

  test('strips surrounding double quotes', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => '"Refactor the login form"',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor the login form');
  });

  test('strips surrounding single quotes', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => "'Refactor login flow'",
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('strips surrounding backticks', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => '`Refactor login flow`',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('strips surrounding curly quotes', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => '\u201cRefactor login flow\u201d',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('strips a leading Title: echo', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => 'Title: Refactor login flow',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('Title: echo is case-insensitive', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => 'TITLE: Refactor login flow',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('strips a trailing period', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => 'Refactor login flow.',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('strips trailing punctuation cluster', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => 'Refactor login flow...',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('strips bold markdown emphasis', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => '**Refactor login flow**',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('strips italic markdown emphasis', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => '*Refactor login flow*',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('strips underscore-bold markdown', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => '__Refactor login flow__',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('strips extra whitespace and trims', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => '   Refactor login flow   ',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('takes only the first non-empty line', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => '\n\nRefactor login flow\nIgnored explanation\nMore stuff',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });

  test('combined cleaning: quotes + Title: + period', async () => {
    const titler = new DefaultTitler({
      invokeForTest: async () => 'Title: "Refactor login flow."',
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Refactor login flow');
  });
});

describe('DefaultTitler — fallback delegations', () => {
  test('empty stdout → fallback invoked', async () => {
    const fallback = new CapturingFallback('fallback-empty');
    const titler = new DefaultTitler({
      invokeForTest: async () => '',
      fallback,
    });
    const out = await titler.suggestTitle(BASIC_INPUT);
    expect(out).toBe('fallback-empty');
    expect(fallback.calls).toHaveLength(1);
    expect(fallback.calls[0]).toBe(BASIC_INPUT);
  });

  test('whitespace-only stdout → fallback invoked', async () => {
    const fallback = new CapturingFallback('fallback-whitespace');
    const titler = new DefaultTitler({
      invokeForTest: async () => '   \n\t  \n',
      fallback,
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('fallback-whitespace');
    expect(fallback.calls).toHaveLength(1);
  });

  test('single-word reply is accepted (>=1 in [1, 12])', async () => {
    const fallback = new CapturingFallback('NOT-USED');
    const titler = new DefaultTitler({
      invokeForTest: async () => 'Foo',
      fallback,
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('Foo');
    expect(fallback.calls).toHaveLength(0);
  });

  test('20-word reply (overshoots band) → fallback invoked', async () => {
    const fallback = new CapturingFallback('fallback-overshoot');
    const overshoot = Array(20).fill('word').join(' ');
    const titler = new DefaultTitler({
      invokeForTest: async () => overshoot,
      fallback,
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('fallback-overshoot');
    expect(fallback.calls).toHaveLength(1);
  });

  test('invokeForTest throws → fallback invoked', async () => {
    const fallback = new CapturingFallback('fallback-thrown');
    const titler = new DefaultTitler({
      invokeForTest: async () => {
        throw new Error('boom');
      },
      fallback,
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('fallback-thrown');
    expect(fallback.calls).toHaveLength(1);
  });

  test('invokeForTest rejects with timeout-shaped error → fallback invoked', async () => {
    const fallback = new CapturingFallback('fallback-timeout');
    const titler = new DefaultTitler({
      invokeForTest: async () => {
        throw new Error('default-titler: timed out');
      },
      fallback,
    });
    expect(await titler.suggestTitle(BASIC_INPUT)).toBe('fallback-timeout');
    expect(fallback.calls).toHaveLength(1);
  });

  test('contract: suggestTitle always returns a non-empty string', async () => {
    // Worst case: invoke throws AND user_message is empty AND assistant_text
    // is empty. The default fallback (FallbackTitler) date-stamps. The result
    // must still be non-empty.
    const titler = new DefaultTitler({
      invokeForTest: async () => {
        throw new Error('boom');
      },
    });
    const out = await titler.suggestTitle({
      conv_id: 'c',
      user_message: '',
      assistant_text: '',
      ts: FIXED_TS,
    });
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('DefaultTitler — argv composition', () => {
  test('default options produce expected argv shape', async () => {
    let captured: { argv: string[] } | undefined;
    const titler = new DefaultTitler({
      invokeForTest: async (args) => {
        captured = { argv: args.argv };
        return 'Foo bar baz';
      },
    });
    await titler.suggestTitle(BASIC_INPUT);
    expect(captured).toBeDefined();
    expect(captured!.argv[0]).toBe('claude');
    expect(captured!.argv).toContain('-p');
    expect(captured!.argv).toContain('--model');
    expect(captured!.argv).toContain('haiku');
    expect(captured!.argv).toContain('--output-format');
    expect(captured!.argv).toContain('text');
  });

  test('custom binary + model surface in argv', async () => {
    let captured: { argv: string[] } | undefined;
    const titler = new DefaultTitler({
      claudeBinary: '/usr/local/bin/claude-pinned',
      model: 'claude-haiku-4-5-20251001',
      invokeForTest: async (args) => {
        captured = { argv: args.argv };
        return 'Foo bar baz';
      },
    });
    await titler.suggestTitle(BASIC_INPUT);
    expect(captured!.argv[0]).toBe('/usr/local/bin/claude-pinned');
    expect(captured!.argv).toContain('claude-haiku-4-5-20251001');
  });

  test('budget passes through to invokeForTest', async () => {
    let captured: { timeoutMs: number } | undefined;
    const titler = new DefaultTitler({
      timeoutMs: 1234,
      invokeForTest: async (args) => {
        captured = { timeoutMs: args.timeoutMs };
        return 'Foo bar baz';
      },
    });
    await titler.suggestTitle(BASIC_INPUT);
    expect(captured!.timeoutMs).toBe(1234);
  });
});

describe('DefaultTitler — prompt composition', () => {
  test('prompt contains user_message, assistant_text, and Title: anchor', async () => {
    let captured: { prompt: string } | undefined;
    const titler = new DefaultTitler({
      invokeForTest: async (args) => {
        captured = { prompt: args.prompt };
        return 'Foo bar baz';
      },
    });
    await titler.suggestTitle({
      conv_id: 'c',
      user_message: 'Refactor the login form.',
      assistant_text: 'Here is the plan...',
      ts: FIXED_TS,
    });
    expect(captured!.prompt).toContain('Refactor the login form.');
    expect(captured!.prompt).toContain('Here is the plan...');
    expect(captured!.prompt).toMatch(/Title:\s*$/);
    // Sanity: instruction is up top, not spliced after the inputs.
    expect(captured!.prompt.indexOf('4-6 word title')).toBeLessThan(
      captured!.prompt.indexOf('Refactor the login form.'),
    );
  });

  test('oversized user_message is truncated with ` …` marker', async () => {
    let captured: { prompt: string } | undefined;
    const titler = new DefaultTitler({
      maxUserMessageChars: 50,
      invokeForTest: async (args) => {
        captured = { prompt: args.prompt };
        return 'Foo bar baz';
      },
    });
    const longMessage = 'a'.repeat(200);
    await titler.suggestTitle({
      conv_id: 'c',
      user_message: longMessage,
      assistant_text: 'short',
      ts: FIXED_TS,
    });
    // The 50-char prefix appears, but the full 200-char message does not.
    expect(captured!.prompt).toContain('a'.repeat(50));
    expect(captured!.prompt).not.toContain('a'.repeat(51));
    expect(captured!.prompt).toContain('a'.repeat(50) + ' …');
  });

  test('oversized assistant_text is truncated independently', async () => {
    let captured: { prompt: string } | undefined;
    const titler = new DefaultTitler({
      maxAssistantChars: 30,
      invokeForTest: async (args) => {
        captured = { prompt: args.prompt };
        return 'Foo bar baz';
      },
    });
    const longAssistant = 'b'.repeat(200);
    await titler.suggestTitle({
      conv_id: 'c',
      user_message: 'short',
      assistant_text: longAssistant,
      ts: FIXED_TS,
    });
    expect(captured!.prompt).toContain('b'.repeat(30) + ' …');
    expect(captured!.prompt).not.toContain('b'.repeat(31));
  });

  test('inputs at exact char budget are not truncated', async () => {
    let captured: { prompt: string } | undefined;
    const titler = new DefaultTitler({
      maxUserMessageChars: 10,
      invokeForTest: async (args) => {
        captured = { prompt: args.prompt };
        return 'Foo bar baz';
      },
    });
    await titler.suggestTitle({
      conv_id: 'c',
      user_message: '0123456789', // exactly 10 chars
      assistant_text: 'x',
      ts: FIXED_TS,
    });
    expect(captured!.prompt).toContain('0123456789');
    expect(captured!.prompt).not.toContain('0123456789 …');
  });
});

describe('cleanTitle — pure function table', () => {
  // The class-level tests above already exercise cleanTitle via the public
  // `suggestTitle` surface, but a focused table makes the contract explicit
  // for future maintainers.
  const cases: Array<[string, string | null, string]> = [
    ['Refactor login flow', 'Refactor login flow', 'plain pass-through'],
    ['"quoted"', 'quoted', 'single-word quoted is cleaned and accepted (>=1 word)'],
    ['', null, 'empty input'],
    ['   \n\t   ', null, 'whitespace only'],
    ['Title: hello world', 'hello world', 'Title: prefix stripped'],
    ['**bold three words**', 'bold three words', 'bold markdown stripped'],
    ['hello world.', 'hello world', 'trailing period'],
    ['hello world,', 'hello world', 'trailing comma'],
    ['"hello world"', 'hello world', 'two-word quoted accepted'],
    [Array(15).fill('word').join(' '), null, '15 words → outside MAX_WORDS band'],
    ['line one\nline two ignored', 'line one', 'multi-line takes first'],
  ];
  for (const [input, expected, label] of cases) {
    test(`cleanTitle: ${label}`, () => {
      expect(cleanTitle(input)).toBe(expected);
    });
  }
});
