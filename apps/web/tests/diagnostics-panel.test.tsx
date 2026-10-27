/**
 * Variant tests for `<DiagnosticsPanel />` (PR #32) — marker assertions
 * (I-3). The copy-repro interaction is dom-tested.
 */
import type { TurnDiagnostics } from '@clod-ui/contracts';
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { DiagnosticsPanel } from '../src/components/diagnostics-panel.tsx';
import type { DiagnosticsState } from '../src/lib/use-diagnostics.ts';

const noop = (): void => {};

function html(state: DiagnosticsState, open = true): string {
  return renderToString(<DiagnosticsPanel open={open} state={state} onClose={noop} />);
}

const TURN: TurnDiagnostics = {
  turn_id: 't-1',
  conv_id: 'c-1',
  started_at: 100,
  argv: ['claude', '--append-system-prompt', '[redacted 19 chars]'],
  env_keys: ['PATH'],
  stdin_bytes: 42,
  cwd: '/tmp/c',
  events: [
    { ts: 110, kind: 'system.init', event: { kind: 'system.init', session_id: 's' } },
    { ts: 130, kind: 'turn.result', event: { kind: 'turn.result' } },
  ],
  outcome: { kind: 'result' },
};

describe('DiagnosticsPanel', () => {
  test('closed renders nothing', () => {
    expect(html({ status: 'loading' }, false)).toBe('');
  });

  test('loading / not_configured / error / empty variants', () => {
    expect(html({ status: 'loading' })).toContain('data-state="loading"');
    expect(html({ status: 'not_configured' })).toContain('data-state="not_configured"');
    expect(html({ status: 'error', error: { message: 'down' } as never })).toContain(
      'data-state="error"',
    );
    expect(html({ status: 'ok', turns: [] })).toContain('data-state="empty"');
  });

  test('ok variant: row with outcome marker, redacted argv, timeline, copy button', () => {
    const out = html({ status: 'ok', turns: [TURN] });
    expect(out).toContain('data-state="ok"');
    expect(out).toContain('data-test="diagnostics-row"');
    expect(out).toContain('data-turn-id="t-1" data-outcome="result"');
    expect(out).toContain('[redacted 19 chars]');
    expect(out).toContain('data-test="diagnostics-timeline"');
    expect(out).toContain('+10ms system.init');
    expect(out).toContain('+30ms turn.result');
    expect(out).toContain('data-test="diagnostics-copy-repro"');
  });

  test('in-flight turn (no outcome) is marked', () => {
    const inflight = { ...TURN, turn_id: 't-2' };
    delete (inflight as Partial<TurnDiagnostics>).outcome;
    const out = html({ status: 'ok', turns: [inflight] });
    expect(out).toContain('data-turn-id="t-2" data-outcome="in_flight"');
  });
});
