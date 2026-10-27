/**
 * Tests for the pure `TurnView` component and its sub-components. All
 * variants are static + synchronous (no state, no effects), so
 * `renderToString` from `react-dom/server` is the right reach. Click
 * handlers / collapsibles aren't part of this slice (PR #18d).
 *
 * Assertions target the `data-test` + `data-state` markers (I-3) so
 * Tailwind classes can be refactored freely without breaking tests.
 */
import type { ClodError } from '@clod-ui/contracts';
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import {
  AssistantMessage,
  ThinkingBlock,
  ToolCard,
  TurnStatusPill,
  TurnView,
  UsageBadge,
  cacheHitPercent,
} from '../src/components/turn-view.tsx';
import { INITIAL_TURN_STATE, type ToolCall } from '../src/lib/turn-reducer.ts';

const TURN_ID = 'turn-001';
const SESSION_ID = 'sess-abcdef0123';

const baseStreaming = {
  status: 'streaming' as const,
  turn_id: TURN_ID,
  session_id: SESSION_ID,
  assistant_text: '',
  assistant_complete: false,
  thinking_text: '',
  thinking_complete: false,
  tools: [],
};

describe('TurnView', () => {
  test('idle variant: empty hint + data-state="idle"', () => {
    const html = renderToString(<TurnView state={INITIAL_TURN_STATE} />);
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('data-turn-id=""');
    expect(html).toContain('Waiting for the next turn');
  });

  test('streaming variant: status pill streaming + assistant streaming attribute', () => {
    const html = renderToString(<TurnView state={{ ...baseStreaming, assistant_text: 'Hello' }} />);
    expect(html).toContain('data-state="streaming"');
    expect(html).toContain(`data-turn-id="${TURN_ID}"`);
    // Status pill present, streaming.
    expect(html).toMatch(/data-test="turn-status-pill"[^>]*data-state="streaming"/);
    // Assistant message present, streaming.
    expect(html).toMatch(/data-test="assistant-message"[^>]*data-streaming="true"/);
    expect(html).toContain('Hello');
    // Streaming cursor is visible.
    expect(html).toContain('data-test="streaming-cursor"');
    // Session id (truncated) shows up.
    expect(html).toContain(SESSION_ID.slice(0, 8));
  });

  test('completed variant: assistant complete + usage badge with tokens', () => {
    const html = renderToString(
      <TurnView
        state={{
          ...baseStreaming,
          status: 'completed',
          assistant_text: 'Done.',
          assistant_complete: true,
          usage: { input_tokens: 12, output_tokens: 34 },
        }}
      />,
    );
    expect(html).toContain('data-state="completed"');
    expect(html).toMatch(/data-test="turn-status-pill"[^>]*data-state="completed"/);
    expect(html).toMatch(/data-test="assistant-message"[^>]*data-streaming="false"/);
    // No streaming cursor in a completed turn.
    expect(html).not.toContain('data-test="streaming-cursor"');
    // Usage badge with both directions populated.
    expect(html).toContain('data-test="usage-badge"');
    expect(html).toContain('↑ 12');
    expect(html).toContain('↓ 34');
  });

  test('cancelled variant: status pill carries data-escalation', () => {
    const html = renderToString(
      <TurnView
        state={{
          ...baseStreaming,
          status: 'cancelled',
          assistant_text: 'partial',
          escalation: 'sigterm',
        }}
      />,
    );
    expect(html).toContain('data-state="cancelled"');
    expect(html).toMatch(
      /data-test="turn-status-pill"[^>]*data-state="cancelled"[^>]*data-escalation="sigterm"/,
    );
    // Escalation tag visible alongside the label.
    expect(html).toContain('sigterm');
  });

  test('errored variant: ErrorPanel renders with kind and detail', () => {
    const error: ClodError = {
      kind: 'rate_limited',
      retryable: true,
      detail: 'too many requests in window',
      retry_after_ms: 5000,
    };
    const html = renderToString(
      <TurnView
        state={{
          ...baseStreaming,
          status: 'errored',
          assistant_text: 'I was about to say…',
          error,
        }}
      />,
    );
    expect(html).toContain('data-state="errored"');
    expect(html).toMatch(/data-test="error-panel"[^>]*data-error-kind="rate_limited"/);
    expect(html).toContain('rate_limited');
    expect(html).toContain('retryable');
    expect(html).toContain('too many requests in window');
  });

  test('thinking and tools: rendered when present, omitted when empty', () => {
    const tool: ToolCall = {
      tool_use_id: 'tool-1',
      name: 'Bash',
      input: { command: 'ls' },
      status: 'pending',
    };
    const html = renderToString(
      <TurnView
        state={{
          ...baseStreaming,
          assistant_text: '',
          thinking_text: 'Let me check the directory.',
          tools: [tool],
        }}
      />,
    );
    expect(html).toContain('data-test="thinking-block"');
    expect(html).toContain('Let me check the directory.');
    expect(html).toContain('data-test="tool-card-list"');
    expect(html).toMatch(/data-test="tool-card"[^>]*data-tool-name="Bash"/);
  });
});

describe('AssistantMessage', () => {
  test('streaming: cursor visible; data-streaming="true"', () => {
    const html = renderToString(<AssistantMessage text="Hello" complete={false} />);
    expect(html).toMatch(/data-test="assistant-message"[^>]*data-streaming="true"/);
    expect(html).toContain('Hello');
    expect(html).toContain('data-test="streaming-cursor"');
  });

  test('complete: no cursor; data-streaming="false"', () => {
    const html = renderToString(<AssistantMessage text="Done." complete={true} />);
    expect(html).toMatch(/data-test="assistant-message"[^>]*data-streaming="false"/);
    expect(html).toContain('Done.');
    expect(html).not.toContain('data-test="streaming-cursor"');
  });

  test('empty text while streaming still shows the cursor', () => {
    const html = renderToString(<AssistantMessage text="" complete={false} />);
    expect(html).toContain('data-test="streaming-cursor"');
  });
});

describe('ThinkingBlock', () => {
  test('empty text → renders nothing', () => {
    const html = renderToString(<ThinkingBlock text="" complete={false} />);
    expect(html).toBe('');
  });

  test('non-empty + streaming → data-streaming="true" + cursor', () => {
    const html = renderToString(<ThinkingBlock text="hmm" complete={false} />);
    expect(html).toMatch(/data-test="thinking-block"[^>]*data-streaming="true"/);
    expect(html).toContain('hmm');
    expect(html).toContain('data-test="streaming-cursor"');
  });

  test('non-empty + complete → data-streaming="false", no cursor', () => {
    const html = renderToString(<ThinkingBlock text="finished thought" complete={true} />);
    expect(html).toMatch(/data-test="thinking-block"[^>]*data-streaming="false"/);
    expect(html).toContain('finished thought');
    expect(html).not.toContain('data-test="streaming-cursor"');
  });
});

describe('ToolCard', () => {
  const baseTool = { tool_use_id: 'tool-x', name: 'Read', input: { path: '/etc/hosts' } };

  test('pending: indicator running, no result, no error', () => {
    const html = renderToString(<ToolCard tool={{ ...baseTool, status: 'pending' }} />);
    expect(html).toMatch(/data-test="tool-card"[^>]*data-tool-status="pending"/);
    expect(html).toMatch(/data-test="tool-status-indicator"[^>]*data-tool-status="pending"/);
    expect(html).toContain('running');
    expect(html).toContain('Read');
    expect(html).toContain('/etc/hosts');
    expect(html).not.toContain('data-test="tool-card-result"');
    expect(html).not.toContain('data-test="tool-card-error"');
  });

  test('success: result section renders json-stringified content', () => {
    const html = renderToString(
      <ToolCard
        tool={{
          ...baseTool,
          status: 'success',
          result: { lines: ['127.0.0.1 localhost'] },
        }}
      />,
    );
    expect(html).toMatch(/data-test="tool-card"[^>]*data-tool-status="success"/);
    expect(html).toContain('data-test="tool-card-result"');
    expect(html).toContain('127.0.0.1 localhost');
    expect(html).not.toContain('data-test="tool-card-error"');
  });

  test('success with string result: rendered verbatim, not double-stringified', () => {
    const html = renderToString(
      <ToolCard tool={{ ...baseTool, status: 'success', result: 'plain string' }} />,
    );
    // The string should appear without surrounding JSON quotes.
    expect(html).toContain('>plain string<');
  });

  test('error: error section renders message; no result section', () => {
    const html = renderToString(
      <ToolCard
        tool={{
          ...baseTool,
          status: 'error',
          error_message: 'Permission denied',
        }}
      />,
    );
    expect(html).toMatch(/data-test="tool-card"[^>]*data-tool-status="error"/);
    expect(html).toContain('data-test="tool-card-error"');
    expect(html).toContain('Permission denied');
    expect(html).not.toContain('data-test="tool-card-result"');
  });

  test('error without message: shows fallback (no message)', () => {
    const html = renderToString(<ToolCard tool={{ ...baseTool, status: 'error' }} />);
    expect(html).toContain('(no message)');
  });
});

describe('TurnStatusPill', () => {
  test('streaming: data-state matches; visible label', () => {
    const html = renderToString(<TurnStatusPill status="streaming" />);
    expect(html).toMatch(/data-test="turn-status-pill"[^>]*data-state="streaming"/);
    expect(html).toContain('streaming');
  });

  test('cancelled with escalation: data-escalation populated', () => {
    const html = renderToString(<TurnStatusPill status="cancelled" escalation="sigkill" />);
    expect(html).toMatch(
      /data-test="turn-status-pill"[^>]*data-state="cancelled"[^>]*data-escalation="sigkill"/,
    );
    expect(html).toContain('sigkill');
  });

  test('cancelled without escalation: no data-escalation attribute', () => {
    const html = renderToString(<TurnStatusPill status="cancelled" />);
    expect(html).not.toContain('data-escalation=');
  });
});

describe('UsageBadge', () => {
  test('both tokens present: renders both arrows with values', () => {
    const html = renderToString(<UsageBadge usage={{ input_tokens: 100, output_tokens: 250 }} />);
    expect(html).toContain('data-test="usage-badge"');
    expect(html).toContain('↑ 100');
    expect(html).toContain('↓ 250');
  });

  test('only input present: input shown, output dashed', () => {
    const html = renderToString(<UsageBadge usage={{ input_tokens: 50 }} />);
    expect(html).toContain('↑ 50');
    expect(html).toContain('↓ —');
  });

  test('only output present: output shown, input dashed', () => {
    const html = renderToString(<UsageBadge usage={{ output_tokens: 75 }} />);
    expect(html).toContain('↑ —');
    expect(html).toContain('↓ 75');
  });

  test('empty usage object: renders the dash placeholder', () => {
    const html = renderToString(<UsageBadge usage={{}} />);
    expect(html).toContain('data-test="usage-badge"');
    // Single em-dash placeholder (not the directional ones).
    expect(html).toContain('>—<');
  });

  test('cache fields (PR #39): hit share, read and written, compact counts', () => {
    // Turn 2 of a real session: everything before it read back.
    const html = renderToString(
      <UsageBadge
        usage={{
          input_tokens: 2,
          output_tokens: 412,
          cache_read_input_tokens: 57141,
          cache_creation_input_tokens: 3095,
        }}
      />,
    );
    expect(html).toContain('data-test="usage-cache"');
    expect(html).toContain('cache 94% · 57.1k read · 3.1k written');
    expect(html).toContain('↑ 2');
  });

  test('no cache fields: no cache segment', () => {
    const html = renderToString(<UsageBadge usage={{ input_tokens: 100, output_tokens: 250 }} />);
    expect(html).not.toContain('data-test="usage-cache"');
  });
});

describe('cacheHitPercent', () => {
  test('floors read / (read + written + uncached input)', () => {
    expect(cacheHitPercent({ input_tokens: 2, cache_read_input_tokens: 98 })).toBe(98);
    expect(cacheHitPercent({ cache_creation_input_tokens: 56021, input_tokens: 2 })).toBe(0);
    expect(cacheHitPercent({ input_tokens: 5 })).toBeUndefined();
    expect(
      cacheHitPercent({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ).toBeUndefined();
  });
});
