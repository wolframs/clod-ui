/**
 * Interaction tests for `<SettingsPanel />` (PR #30) — the round-trip the
 * goal pins: edit → Save → diff preview → Confirm → PUT with the unknown
 * bucket preserved. Drives the real `useSettings` hook over a fake client.
 */
import type { ClaudeSettings } from '@clod-ui/contracts';
import { type Client } from '@clod-ui/contracts/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SettingsPanel } from '../../src/components/settings-panel.tsx';
import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useSettings } from '../../src/lib/use-settings.ts';

const DOC: ClaudeSettings = {
  theme: 'dark',
  allowedTools: ['Read'],
  unknown: { customKey: { nested: true } },
};

function Harness(): React.ReactElement {
  const settings = useSettings();
  return (
    <SettingsPanel
      open
      state={settings.state}
      onClose={() => {}}
      onSave={(next) => void settings.save(next)}
    />
  );
}

function renderPanel(client: Partial<Client>) {
  return render(
    <EngineProvider client={client as Client}>
      <Harness />
    </EngineProvider>,
  );
}

describe('SettingsPanel round-trip', () => {
  it('edit theme → Save shows the diff → Confirm PUTs with unknown preserved', async () => {
    const written: ClaudeSettings = { ...DOC, theme: 'light' };
    const client = {
      getSettings: vi.fn().mockResolvedValue(DOC),
      putSettings: vi.fn().mockResolvedValue(written),
    };
    renderPanel(client);

    await waitFor(() => expect(screen.getByLabelText('Theme')).toBeTruthy());
    // No edits yet → Save disabled.
    expect((screen.getByText('Save…') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });
    const save = screen.getByText('Save…') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    // Diff preview: exactly one row, for theme.
    const rows = screen.getAllByText(/dark → light/);
    expect(rows.length).toBe(1);

    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(client.putSettings).toHaveBeenCalledTimes(1));
    expect(client.putSettings).toHaveBeenCalledWith({
      theme: 'light',
      allowedTools: ['Read'],
      unknown: DOC.unknown,
    });

    // Post-save: hook state carries the response; panel back on the form
    // view with a fresh draft (Save disabled again).
    await waitFor(() =>
      expect((screen.getByText('Save…') as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it('Back returns from the diff view without writing', async () => {
    const client = {
      getSettings: vi.fn().mockResolvedValue(DOC),
      putSettings: vi.fn(),
    };
    renderPanel(client);
    await waitFor(() => expect(screen.getByLabelText('Theme')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByText('Save…'));
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByLabelText('Model')).toBeTruthy();
    expect(client.putSettings).not.toHaveBeenCalled();
  });
});
