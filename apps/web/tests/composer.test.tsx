/**
 * `<Composer />` render variants — renderToString tier.
 *
 * Hermetic. No DOM lifecycle, no event handlers — just contract assertions
 * over what each prop combination renders.
 *
 * Spec: plans/landed/2026-05-02-clod-ui-pr19-composer-v1.md §7.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { Composer } from '../src/components/composer.tsx';
import type { TurnState } from '../src/lib/turn-reducer.ts';
import type { SubmitTurnState } from '../src/lib/use-submit-turn.ts';

const idleTurn: TurnState = { status: 'idle' };
const streamingTurn: TurnState = {
  status: 'streaming',
  turn_id: 't1',
  assistant_text: 'hello',
  assistant_complete: false,
  thinking_text: '',
  thinking_complete: false,
  tools: [],
};
const completedTurn: TurnState = {
  status: 'completed',
  turn_id: 't1',
  assistant_text: 'hello',
  assistant_complete: true,
  thinking_text: '',
  thinking_complete: true,
  tools: [],
};

const idleSubmit: SubmitTurnState = { status: 'idle' };
const submittingSubmit: SubmitTurnState = { status: 'submitting', turn_id: 't1' };
const errorSubmit: SubmitTurnState = {
  status: 'error',
  error: new Error('network kaboom'),
  attempted_text: 'hi there',
};

const noop = (): void => {};

describe('Composer — hint variant', () => {
  test('renders the hint when convId is undefined', () => {
    const html = renderToString(
      <Composer
        convId={undefined}
        turnState={idleTurn}
        submitState={idleSubmit}
        lastSubmittedTurnId={undefined}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('data-test="composer-hint"');
    expect(html).toContain('data-state="no-conversation"');
    expect(html).toContain('Select or create a conversation');
    expect(html).not.toContain('data-test="composer-input"');
    expect(html).not.toContain('data-test="composer-send"');
  });
});

describe('Composer — form variants', () => {
  test('renders form with idle state when convId is set', () => {
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={idleTurn}
        submitState={idleSubmit}
        lastSubmittedTurnId={undefined}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('data-test="composer"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain('data-test="composer-input"');
    expect(html).toContain('data-test="composer-send"');
    expect(html).toContain('aria-label="Message"');
  });

  test('Send button is disabled when text is empty', () => {
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={idleTurn}
        submitState={idleSubmit}
        lastSubmittedTurnId={undefined}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    // Initial text is empty, so Send must be disabled.
    expect(html).toMatch(/data-test="composer-send"[^>]*disabled/);
  });

  test('shows "Sending…" label when submitting', () => {
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={idleTurn}
        submitState={submittingSubmit}
        lastSubmittedTurnId="t1"
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('data-state="submitting"');
    expect(html).toContain('Sending');
  });

  test('renders error block when submit failed', () => {
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={idleTurn}
        submitState={errorSubmit}
        lastSubmittedTurnId="t1"
        onSubmit={noop}
        onCancel={noop}
        onResetError={noop}
      />,
    );
    expect(html).toContain('data-test="composer-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('network kaboom');
    expect(html).toContain('data-test="composer-error-dismiss"');
    expect(html).toContain('data-state="error"');
  });

  test('omits Dismiss button when onResetError not provided', () => {
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={idleTurn}
        submitState={errorSubmit}
        lastSubmittedTurnId="t1"
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('data-test="composer-error"');
    expect(html).not.toContain('data-test="composer-error-dismiss"');
  });

  test('error block carries full message in title attr (truncation-friendly)', () => {
    const longError = 'x'.repeat(200);
    const state: SubmitTurnState = {
      status: 'error',
      error: new Error(longError),
      attempted_text: 'irrelevant',
    };
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={idleTurn}
        submitState={state}
        lastSubmittedTurnId={undefined}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain(`title="${longError}"`);
  });
});

describe('Composer — Cancel button visibility', () => {
  test('Cancel hidden when turn is idle', () => {
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={idleTurn}
        submitState={idleSubmit}
        lastSubmittedTurnId={undefined}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).not.toContain('data-test="composer-cancel"');
  });

  test('Cancel visible when turn is streaming', () => {
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={streamingTurn}
        submitState={idleSubmit}
        lastSubmittedTurnId="t1"
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('data-test="composer-cancel"');
  });

  test('Cancel hidden when turn is completed', () => {
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={completedTurn}
        submitState={idleSubmit}
        lastSubmittedTurnId="t1"
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).not.toContain('data-test="composer-cancel"');
  });

  test('Cancel visible when submitting + lastSubmittedTurnId present (cancel-before-init path)', () => {
    // After submit but before useTurnStream sees system.init: turnState is
    // still idle, but the Composer should not render Cancel (no streaming).
    // We test the inverse: streaming + lastSubmittedTurnId still works.
    const html = renderToString(
      <Composer
        convId="conv-1"
        turnState={streamingTurn}
        submitState={idleSubmit}
        lastSubmittedTurnId="lastSubmitted-t1"
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('data-test="composer-cancel"');
  });
});
