import { describe, expect, test } from 'bun:test';

import { parseTurnBody } from '../src/parse-turn-body.ts';

const BASE = { turn_id: 't-1', user_message: 'hello', cwd: '/tmp/c' };

describe('parseTurnBody', () => {
  test('accepts a valid thinking_effort and carries it on the TurnRequest', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, thinking_effort: 'think_hard' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.thinking_effort).toBe('think_hard');
  });

  test('absent thinking_effort stays absent', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect('thinking_effort' in parsed.value).toBe(false);
  });

  test('rejects an unknown thinking_effort with a typed error (D3)', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, thinking_effort: 'banana' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('thinking_effort must be one of');
  });

  test('rejects a non-string thinking_effort', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, thinking_effort: 3 });
    expect(parsed.ok).toBe(false);
  });

  test('model string passes through untouched', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, model: 'sonnet' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.model).toBe('sonnet');
  });

  test('system_prompt append mode carries through on the TurnRequest', () => {
    const sp = { mode: 'append', text: 'be terse' };
    const parsed = parseTurnBody('conv-1', { ...BASE, system_prompt: sp });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.system_prompt).toEqual({ mode: 'append', text: 'be terse' });
  });

  test('system_prompt override mode carries through on the TurnRequest', () => {
    const sp = { mode: 'override', text: 'you are a pirate' };
    const parsed = parseTurnBody('conv-1', { ...BASE, system_prompt: sp });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.system_prompt?.mode).toBe('override');
  });

  test('absent system_prompt stays absent', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect('system_prompt' in parsed.value).toBe(false);
  });

  test('rejects an unknown system_prompt.mode with a typed error (PR #25 D1)', () => {
    const sp = { mode: 'replace', text: 'x' };
    const parsed = parseTurnBody('conv-1', { ...BASE, system_prompt: sp });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('system_prompt.mode must be one of');
  });

  test('rejects a non-string system_prompt.text', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, system_prompt: { mode: 'append', text: 7 } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('system_prompt.text');
  });

  test('rejects a non-object system_prompt', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, system_prompt: 'be terse' });
    expect(parsed.ok).toBe(false);
  });

  test('extra_argv array of strings passes through verbatim', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, extra_argv: ['--fork-session', '-d'] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.extra_argv).toEqual(['--fork-session', '-d']);
  });

  test('empty extra_argv stays absent (argv-identical)', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, extra_argv: [] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect('extra_argv' in parsed.value).toBe(false);
  });

  test('absent extra_argv stays absent', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect('extra_argv' in parsed.value).toBe(false);
  });

  test('rejects a non-array extra_argv (PR #28 D2)', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, extra_argv: '--model opus' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('extra_argv must be an array of strings');
  });

  test('rejects an extra_argv containing a non-string element', () => {
    const parsed = parseTurnBody('conv-1', { ...BASE, extra_argv: ['--effort', 3] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('extra_argv must be an array of strings');
  });

  test('attachments array of { path, content_type? } passes through (PR #33 D4)', () => {
    const atts = [{ path: '/a/b.png', content_type: 'image/png' }, { path: '/c/d.txt' }];
    const parsed = parseTurnBody('conv-1', { ...BASE, attachments: atts });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.attachments).toEqual(atts);
  });

  test('empty attachments stays absent; malformed entries are a 400', () => {
    const empty = parseTurnBody('conv-1', { ...BASE, attachments: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect('attachments' in empty.value).toBe(false);

    for (const bad of [['/string'], [{ content_type: 'image/png' }], 'nope', [{ path: 7 }]]) {
      const parsed = parseTurnBody('conv-1', { ...BASE, attachments: bad });
      expect(parsed.ok).toBe(false);
    }
  });
});
