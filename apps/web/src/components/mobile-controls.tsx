/**
 * `<MobileControls />` — turn controls on a phone: one line under the
 * composer, the full `<TurnControlsBar />` in a bottom sheet. The sheet is a
 * portal so that Enter in its fields cannot submit the composer's form.
 *
 * Spec: plans/2026-11-01-clod-ui-pr44-mobile-v1.md §7.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';

import {
  EFFORT_OPTIONS,
  effectiveExtraArgv,
  effectiveSystemPrompt,
  modelInfoFor,
  type TurnControls,
} from '../lib/turn-controls.ts';
import { useBackDismiss } from '../lib/use-back-dismiss.ts';

import { TurnControlsBar, type TurnControlsBarProps } from './turn-controls-bar.tsx';

/** `Opus 5.5 · High`. */
export function controlsSummary(
  value: TurnControls,
  models: TurnControlsBarProps['models'],
): string {
  const model =
    value.model === undefined
      ? 'Default'
      : (modelInfoFor(models, value.model)?.display_name ?? value.model);
  const effort = EFFORT_OPTIONS.find((o) => o.value === (value.thinking_effort ?? 'auto'));
  return `${model} · ${effort?.label ?? value.thinking_effort ?? 'Auto'}`;
}

/** Anything beyond model and effort is set for this conversation. */
export function hasExtraControls(value: TurnControls): boolean {
  return (
    effectiveSystemPrompt(value) !== undefined ||
    effectiveExtraArgv(value) !== undefined ||
    value.allowed_tools !== undefined ||
    value.disallowed_tools !== undefined
  );
}

// The bar's own sizes are a desktop's; the sheet makes them touchable.
const SHEET_SIZES =
  'gap-x-3 gap-y-3 text-sm [&_button]:px-3 [&_button]:py-2 [&_button]:text-sm ' +
  '[&_input]:py-2 [&_input]:text-base [&_label]:w-full [&_select]:min-w-0 ' +
  '[&_select]:flex-1 [&_select]:py-2 [&_select]:text-base [&_textarea]:text-base';

export function MobileControls(props: TurnControlsBarProps): React.ReactElement {
  const { value, models } = props;
  const [open, setOpen] = React.useState(false);
  useBackDismiss(open, () => setOpen(false));

  return (
    <div className="flex items-center justify-end">
      <button
        data-test="mobile-controls-open"
        data-active={hasExtraControls(value) ? 'true' : 'false'}
        type="button"
        onClick={() => setOpen(true)}
        className="flex max-w-full items-center gap-1.5 rounded-full px-3 py-2 text-[13px] text-muted-foreground active:bg-accent"
      >
        {hasExtraControls(value) ? (
          <span aria-hidden className="text-[0.5rem] leading-none text-primary">
            ●
          </span>
        ) : null}
        <span className="truncate">{controlsSummary(value, models)}</span>
        <span aria-hidden className="text-[0.6rem] leading-none">
          ▾
        </span>
      </button>
      {open
        ? createPortal(
            <div
              data-test="mobile-controls-sheet"
              role="dialog"
              aria-label="Turn controls"
              onClick={() => setOpen(false)}
              className="fixed inset-x-0 bottom-[var(--tab-overhang)] top-0 z-50 flex items-end bg-background/70 backdrop-blur-sm"
            >
              <div
                onClick={(ev) => ev.stopPropagation()}
                className="max-h-[calc(85dvh-var(--tab-overhang))] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-card p-4 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-lg"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-foreground">This conversation</h2>
                  <button
                    data-test="mobile-controls-close"
                    type="button"
                    onClick={() => setOpen(false)}
                    className="rounded px-3 py-2 text-sm text-muted-foreground active:bg-accent"
                  >
                    Done
                  </button>
                </div>
                <TurnControlsBar {...props} className={SHEET_SIZES} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
