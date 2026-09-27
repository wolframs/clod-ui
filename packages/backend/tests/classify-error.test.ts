import { describe, expect, test } from 'bun:test';

import { classifyCliFailure } from '../src/classify-error.ts';

describe('classifyCliFailure — per-kind coverage', () => {
  test('auth_failed from "not authenticated"', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Error: not authenticated. Please run `claude login`.\n',
      exit_code: 1,
    });
    expect(err.kind).toBe('auth_failed');
    expect(err.retryable).toBe(false);
    expect(err.raw_stderr).toContain('not authenticated');
  });

  test('auth_failed from "please run claude login"', () => {
    const err = classifyCliFailure({
      raw_stderr: 'You must first authenticate. Please run: claude login\n',
    });
    expect(err.kind).toBe('auth_failed');
  });

  test('auth_failed from "unauthorized"', () => {
    const err = classifyCliFailure({
      raw_stderr: 'HTTP 401 Unauthorized\n',
    });
    expect(err.kind).toBe('auth_failed');
  });

  test('auth_failed from "api key"', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Invalid API key provided\n',
    });
    expect(err.kind).toBe('auth_failed');
  });

  test('rate_limited with Retry-After header', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Rate limit exceeded.\nRetry-After: 42\n',
      exit_code: 1,
    });
    expect(err.kind).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    if (err.kind === 'rate_limited') {
      expect(err.retry_after_ms).toBe(42000);
    }
  });

  test('rate_limited with phrase "try again in Xs"', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Rate limit. Please try again in 12s.\n',
    });
    expect(err.kind).toBe('rate_limited');
    if (err.kind === 'rate_limited') {
      expect(err.retry_after_ms).toBe(12000);
    }
  });

  test('rate_limited via 429 status', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Request failed with status 429\n',
    });
    expect(err.kind).toBe('rate_limited');
    // Without explicit retry-after, field is omitted.
    if (err.kind === 'rate_limited') {
      expect(err.retry_after_ms).toBeUndefined();
    }
  });

  test('rate_limited with too many requests', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Too Many Requests\n',
    });
    expect(err.kind).toBe('rate_limited');
  });

  test('tool_denied — "tool X is not allowed"', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Error: tool Bash is not allowed in this conversation.\n',
    });
    expect(err.kind).toBe('tool_denied');
    expect(err.retryable).toBe(false);
  });

  test('tool_denied — permission denied for tool', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Permission denied for tool Read\n',
    });
    expect(err.kind).toBe('tool_denied');
  });

  test('tool_denied — allowedTools at start of line only', () => {
    const hit = classifyCliFailure({
      raw_stderr: 'allowedTools: Bash is missing from the flag list\n',
    });
    expect(hit.kind).toBe('tool_denied');

    // False-positive guard: mid-line "allowedTools" should NOT trigger.
    const miss = classifyCliFailure({
      raw_stderr: 'The argv was: --allowedTools Bash Read\nSome other error\n',
    });
    expect(miss.kind).toBe('cli_crashed');
  });

  test('model_unavailable — "model X is not available"', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Error: model claude-4-omega is not available\n',
    });
    expect(err.kind).toBe('model_unavailable');
    expect(err.retryable).toBe(false);
  });

  test('model_unavailable — "unknown model"', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Unknown model specified: fake-model\n',
    });
    expect(err.kind).toBe('model_unavailable');
  });

  test('cli_crashed fallback preserves raw_stderr + exit_code', () => {
    const err = classifyCliFailure({
      raw_stderr: 'segfault at 0xdeadbeef\n',
      exit_code: 139,
      signal: 'SIGSEGV',
    });
    expect(err.kind).toBe('cli_crashed');
    expect(err.retryable).toBe(true);
    if (err.kind === 'cli_crashed') {
      expect(err.exit_code).toBe(139);
      expect(err.signal).toBe('SIGSEGV');
      expect(err.raw_stderr).toContain('segfault');
    }
  });

  test('cli_crashed with empty stderr — no raw_stderr field', () => {
    const err = classifyCliFailure({ exit_code: 2 });
    expect(err.kind).toBe('cli_crashed');
    if (err.kind === 'cli_crashed') {
      expect(err.exit_code).toBe(2);
      expect(err.raw_stderr).toBeUndefined();
    }
  });
});

describe('classifyCliFailure — priority ordering', () => {
  test('auth_failed wins over rate_limited when both match', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Rate limit exceeded. Also not authenticated.\n',
    });
    expect(err.kind).toBe('auth_failed');
  });

  test('auth_failed wins over cli_crashed', () => {
    const err = classifyCliFailure({
      raw_stderr: 'panic: unauthorized access\n',
      exit_code: 1,
    });
    expect(err.kind).toBe('auth_failed');
  });

  test('rate_limited wins over cli_crashed', () => {
    const err = classifyCliFailure({
      raw_stderr: '429 Too Many Requests, retry in 5 seconds\n',
      exit_code: 1,
    });
    expect(err.kind).toBe('rate_limited');
  });

  test('tool_denied wins over cli_crashed', () => {
    const err = classifyCliFailure({
      raw_stderr: 'Error: tool Bash is not allowed.\nexit code 1\n',
    });
    expect(err.kind).toBe('tool_denied');
  });
});

describe('classifyCliFailure — cli_subtype handling', () => {
  test('error_max_turns → cli_crashed non-retryable', () => {
    const err = classifyCliFailure({ cli_subtype: 'error_max_turns', exit_code: 0 });
    expect(err.kind).toBe('cli_crashed');
    expect(err.retryable).toBe(false);
    expect(err.detail).toContain('max turns');
  });

  test('error_during_execution → stderr-driven classification', () => {
    const err = classifyCliFailure({
      cli_subtype: 'error_during_execution',
      raw_stderr: 'rate limit exceeded\n',
    });
    expect(err.kind).toBe('rate_limited');
  });

  test('unknown subtype → cli_crashed with subtype in detail', () => {
    const err = classifyCliFailure({ cli_subtype: 'error_mystery_thing', exit_code: 1 });
    expect(err.kind).toBe('cli_crashed');
    expect(err.detail).toContain('error_mystery_thing');
  });
});

describe('classifyCliFailure — edge cases', () => {
  test('no input → cli_crashed retryable with default detail', () => {
    const err = classifyCliFailure({});
    expect(err.kind).toBe('cli_crashed');
    expect(err.retryable).toBe(true);
    expect(err.detail).toBe('CLI crashed');
  });

  test('signal-only (no exit_code, no stderr) → cli_crashed with signal', () => {
    const err = classifyCliFailure({ signal: 'SIGTERM' });
    expect(err.kind).toBe('cli_crashed');
    if (err.kind === 'cli_crashed') {
      expect(err.signal).toBe('SIGTERM');
    }
  });

  test('multi-line stderr — detail is first non-empty line, truncated', () => {
    const err = classifyCliFailure({
      raw_stderr: '\n\npanic: very long first line ' + 'x'.repeat(500) + '\nsecond line\n',
    });
    expect(err.kind).toBe('cli_crashed');
    expect((err.detail ?? '').length).toBeLessThanOrEqual(200);
    expect(err.detail).toMatch(/^panic:/);
  });
});
