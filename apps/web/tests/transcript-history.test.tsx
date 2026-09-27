/**
 * `TranscriptHistory` — renderToString-tier tests.
 *
 * The component is pure-presentational; all state lives in the hook
 * (`useTranscript`). These tests assert on `data-test` + `data-*` markers per
 * INVARIANTS I-3 — never on Tailwind class fragments.
 *
 * Async lifecycle is tested in `apps/web/tests/dom/use-transcript.test.tsx`;
 * here we exercise every render branch synchronously through
 * `react-dom/server`.
 */
import type { ChatMessage } from '@clod-ui/contracts';
import { ClientError } from '@clod-ui/contracts/client';
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { TranscriptHistory } from '@/components/transcript-history';
import type { TranscriptState } from '@/lib/use-transcript';

function mkMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-default',
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    source: { line_number: 0, byte_offset: 0 },
    ...overrides,
  };
}

describe('TranscriptHistory: top-level variants', () => {
  test('idle: renders idle marker + idle state attribute', () => {
    const state: TranscriptState = { status: 'idle' };
    const html = renderToString(<TranscriptHistory state={state} />);

    expect(html).toContain('data-test="transcript-history"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('Select a conversation');
  });

  test('loading: renders aria-busy + loading marker', () => {
    const state: TranscriptState = { status: 'loading' };
    const html = renderToString(<TranscriptHistory state={state} />);

    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading history');
  });

  test('not_configured: shows the unavailable copy', () => {
    const state: TranscriptState = { status: 'not_configured' };
    const html = renderToString(<TranscriptHistory state={state} />);

    expect(html).toContain('data-state="not_configured"');
    expect(html).toContain('Transcripts not configured');
    expect(html).toContain('--projects-dir');
  });

  test('empty (ok with zero messages): shows "No history yet"', () => {
    const state: TranscriptState = { status: 'ok', messages: [] };
    const html = renderToString(<TranscriptHistory state={state} />);

    expect(html).toContain('data-state="empty"');
    expect(html).toContain('No history yet');
  });

  test('error: visible truncated message + full message in title attr', () => {
    const long = 'X'.repeat(250);
    const state: TranscriptState = {
      status: 'error',
      error: new ClientError({
        kind: 'http',
        path: '/conversations/abc/transcript',
        status: 500,
        message: long,
      }),
    };
    const html = renderToString(<TranscriptHistory state={state} />);

    expect(html).toContain('data-state="error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-test="transcript-history-error"');
    expect(html).toContain(`title="${long}"`); // full in title
    expect(html).toContain(`${'X'.repeat(199)}\u2026`); // truncated visible
    // note: full 200-char message is in title attr, so we can't `not.toContain` it
  });
});

describe('TranscriptHistory: ok state with messages', () => {
  test('renders message count attribute on the ordered list', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [mkMessage({ id: 'm1' }), mkMessage({ id: 'm2', role: 'assistant' })],
    };
    const html = renderToString(<TranscriptHistory state={state} />);
    expect(html).toContain('data-state="ok"');
    expect(html).toContain('data-message-count="2"');
  });

  test('each message renders with role + id markers', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [
        mkMessage({ id: 'user-msg', role: 'user' }),
        mkMessage({ id: 'asst-msg', role: 'assistant' }),
      ],
    };
    const html = renderToString(<TranscriptHistory state={state} />);

    expect(html).toContain('data-test="chat-message"');
    expect(html).toContain('data-role="user"');
    expect(html).toContain('data-message-id="user-msg"');
    expect(html).toContain('data-role="assistant"');
    expect(html).toContain('data-message-id="asst-msg"');
  });

  test('header carries source line/byte provenance', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [
        mkMessage({
          id: 'src',
          source: { line_number: 42, byte_offset: 1024 },
        }),
      ],
    };
    const html = renderToString(<TranscriptHistory state={state} />);
    // React inserts <!-- --> markers between adjacent text segments rendered
    // through template literals (e.g. "L{var} · B{var}"); use a permissive
    // regex that crosses those markers without anchoring on them.
    expect(html).toContain('line / byte offset in JSONL');
    expect(html).toMatch(/L[^<]*<!--\s*-->42/);
    expect(html).toMatch(/B[^<]*<!--\s*-->1024/);
  });
});

describe('TranscriptHistory: content blocks', () => {
  test('text block renders verbatim with whitespace-pre-wrap', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [
        mkMessage({
          content: [{ type: 'text', text: 'line one\nline two' }],
        }),
      ],
    };
    const html = renderToString(<TranscriptHistory state={state} />);
    expect(html).toContain('data-block-type="text"');
    expect(html).toContain('line one\nline two');
  });

  test('thinking block carries thinking type + label', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [
        mkMessage({
          role: 'assistant',
          content: [{ type: 'thinking', text: 'pondering' }],
        }),
      ],
    };
    const html = renderToString(<TranscriptHistory state={state} />);
    expect(html).toContain('data-block-type="thinking"');
    expect(html).toContain('aria-label="Internal reasoning"');
    expect(html).toContain('pondering');
  });

  test('tool_use without matching tool_result: data-has-result=false + no-result label', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [
        mkMessage({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              tool_use_id: 'tu1',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        }),
      ],
    };
    const html = renderToString(<TranscriptHistory state={state} />);
    expect(html).toContain('data-block-type="tool_use"');
    expect(html).toContain('data-tool-id="tu1"');
    expect(html).toContain('data-tool-name="Bash"');
    expect(html).toContain('data-has-result="false"');
    expect(html).toContain('no result');
  });

  test('tool_use folded with matching tool_result (success): ok label + result section', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [
        mkMessage({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              tool_use_id: 'tu2',
              name: 'Read',
              input: { file_path: '/tmp/x' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tu2',
              content: 'file contents',
              is_error: false,
            },
          ],
        }),
      ],
    };
    const html = renderToString(<TranscriptHistory state={state} />);
    expect(html).toContain('data-tool-id="tu2"');
    expect(html).toContain('data-has-result="true"');
    expect(html).toContain('data-test="tool-result-section"');
    expect(html).toContain('file contents');
    expect(html).toContain('>ok<');
  });

  test('tool_use folded with matching tool_result (error): error label + destructive marker', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [
        mkMessage({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              tool_use_id: 'tu3',
              name: 'Bash',
              input: { command: 'false' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tu3',
              content: 'command failed',
              is_error: true,
            },
          ],
        }),
      ],
    };
    const html = renderToString(<TranscriptHistory state={state} />);
    expect(html).toContain('data-tool-id="tu3"');
    expect(html).toContain('data-has-result="true"');
    expect(html).toContain('>error<');
    expect(html).toContain('command failed');
  });

  test('orphan tool_result (no matching tool_use in same message): standalone with stray marker', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [
        mkMessage({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'orphan-id',
              content: 'orphan content',
              is_error: false,
            },
          ],
        }),
      ],
    };
    const html = renderToString(<TranscriptHistory state={state} />);
    expect(html).toContain('data-block-type="tool_result"');
    expect(html).toContain('data-tool-id="orphan-id"');
    expect(html).toContain('data-stray="true"');
    expect(html).toContain('orphan tool_result');
    expect(html).toContain('orphan content');
  });

  test('tool_use input is JSON-stringified (object) but string result is rendered verbatim', () => {
    const state: TranscriptState = {
      status: 'ok',
      messages: [
        mkMessage({
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              tool_use_id: 'tu4',
              name: 'Echo',
              input: { value: 'hello' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tu4',
              content: 'just a string',
              is_error: false,
            },
          ],
        }),
      ],
    };
    const html = renderToString(<TranscriptHistory state={state} />);
    // Object input gets JSON-stringified (HTML-escaped quotes)
    expect(html).toContain('&quot;value&quot;');
    expect(html).toContain('&quot;hello&quot;');
    // String result is verbatim (no surrounding quotes)
    expect(html).toContain('just a string');
    expect(html).not.toContain('&quot;just a string&quot;');
  });
});
