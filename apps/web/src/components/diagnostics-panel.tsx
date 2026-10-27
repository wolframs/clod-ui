/**
 * `<DiagnosticsPanel />` — hidden-by-default per-turn diagnostics
 * (Phase 5.7). Rows are native <details> disclosures (no state hooks);
 * "Copy repro" exports `{ request, events }` JSON that test-kit's
 * ScriptedBackend accepts as `{ events }` (round-trip pinned engine-side).
 * argv arrives pre-redacted — record-time redaction, PR #32 D1.
 */
import type { TurnDiagnostics } from '@clod-ui/contracts';
import * as React from 'react';

import type { DiagnosticsState } from '../lib/use-diagnostics.ts';

export interface DiagnosticsPanelProps {
  open: boolean;
  state: DiagnosticsState;
  onClose: () => void;
}

function reproJson(turn: TurnDiagnostics): string {
  return JSON.stringify(
    {
      request: {
        turn_id: turn.turn_id,
        conv_id: turn.conv_id,
        cwd: turn.cwd,
        stdin_bytes: turn.stdin_bytes,
        argv: turn.argv,
        ...(turn.process !== undefined ? { process: turn.process } : {}),
      },
      events: turn.events.map((e) => e.event),
    },
    null,
    2,
  );
}

function copyRepro(turn: TurnDiagnostics): void {
  const text = reproJson(turn);
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    // Clipboard unavailable (permissions, bare DOM) — non-fatal.
  }
}

export function DiagnosticsPanel(props: DiagnosticsPanelProps): React.ReactElement | null {
  const { open, state, onClose } = props;
  if (!open) return null;

  const dataState = state.status === 'ok' && state.turns.length === 0 ? 'empty' : state.status;

  return (
    <div
      data-test="diagnostics-panel"
      data-state={dataState}
      role="dialog"
      aria-label="Diagnostics"
      onClick={onClose}
      className="absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
    >
      <div
        onClick={(ev) => ev.stopPropagation()}
        className="flex max-h-[80%] w-[34rem] flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Turn diagnostics</h2>
          <button
            data-test="diagnostics-close"
            type="button"
            onClick={onClose}
            className="rounded px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Close
          </button>
        </div>

        {state.status === 'loading' && (
          <p className="text-xs text-muted-foreground">Loading diagnostics…</p>
        )}
        {state.status === 'not_configured' && (
          <p className="text-xs text-muted-foreground">
            Diagnostics are not configured on this engine.
          </p>
        )}
        {state.status === 'error' && (
          <p role="alert" className="text-xs text-destructive">
            Failed to load diagnostics: {state.error.message}
          </p>
        )}
        {state.status === 'ok' && state.turns.length === 0 && (
          <p className="text-xs text-muted-foreground">No turns recorded yet.</p>
        )}

        {state.status === 'ok' &&
          state.turns.map((turn) => (
            <details
              key={turn.turn_id}
              data-test="diagnostics-row"
              data-turn-id={turn.turn_id}
              data-outcome={turn.outcome?.kind ?? 'in_flight'}
              className="rounded-md border border-border text-xs"
            >
              <summary className="cursor-pointer px-3 py-2 text-foreground">
                <span className="font-mono">{turn.turn_id}</span>
                <span className="ml-2 text-muted-foreground">
                  {`${turn.outcome?.kind ?? 'in flight'} · ${turn.events.length} events`}
                </span>
              </summary>
              <div className="flex flex-col gap-2 border-t border-border p-3">
                <div data-test="diagnostics-argv" className="flex flex-col gap-0.5">
                  <span className="font-medium text-foreground">argv</span>
                  <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[10px] text-foreground">
                    {turn.argv.join('\n')}
                  </pre>
                </div>
                <div className="text-muted-foreground">
                  {`${turn.process !== undefined ? `process: ${turn.process} · ` : ''}env keys: ${turn.env_keys.join(', ') || '(none)'} · stdin: ${turn.stdin_bytes} bytes · cwd: ${turn.cwd}`}
                </div>
                <div data-test="diagnostics-timeline" className="flex flex-col gap-0.5">
                  <span className="font-medium text-foreground">timeline</span>
                  <ol className="flex flex-col gap-0.5 font-mono text-[10px] text-muted-foreground">
                    {turn.events.map((e, i) => (
                      <li key={i}>{`+${e.ts - turn.started_at}ms ${e.kind}`}</li>
                    ))}
                  </ol>
                </div>
                <button
                  data-test="diagnostics-copy-repro"
                  type="button"
                  onClick={() => copyRepro(turn)}
                  className="self-start rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground hover:bg-accent"
                >
                  Copy repro
                </button>
              </div>
            </details>
          ))}
      </div>
    </div>
  );
}
