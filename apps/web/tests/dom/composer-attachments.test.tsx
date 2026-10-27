/**
 * Composer attachment interactions (PR #34) — file input change fires
 * onAttachFiles; chip remove fires onRemoveAttachment.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from '../../src/components/composer.tsx';

const baseProps = {
  convId: 'c-1',
  turnState: { status: 'idle' } as const,
  submitState: { status: 'idle' } as const,
  lastSubmittedTurnId: undefined,
  onSubmit: () => {},
  onCancel: () => {},
};

describe('Composer attachments', () => {
  it('file input change forwards the FileList', () => {
    const onAttachFiles = vi.fn();
    const { container } = render(
      <Composer {...baseProps} attachments={[]} onAttachFiles={onAttachFiles} />,
    );
    const input = container.querySelector('[data-test="composer-file-input"]') as HTMLInputElement;
    const file = new File([Uint8Array.from([1])], 'x.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAttachFiles).toHaveBeenCalledTimes(1);
  });

  it('chips render with status markers; remove fires', () => {
    const onRemoveAttachment = vi.fn();
    render(
      <Composer
        {...baseProps}
        attachments={[
          { name: 'a.png', status: 'ready', size: 42 },
          { name: 'b.png', status: 'error', size: 7 },
        ]}
        onAttachFiles={() => {}}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );
    expect(screen.getByText('a.png · 42 B')).toBeTruthy();
    expect(screen.getByText('b.png · failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('a.png');
  });
});
