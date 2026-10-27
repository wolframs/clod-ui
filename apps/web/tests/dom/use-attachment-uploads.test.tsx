/**
 * `useAttachmentUploads` — upload lifecycle tests (PR #34). Stubbed
 * client; File built from a Blob (arrayBuffer is the only API used).
 */
import type { Client } from '@clod-ui/contracts/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { EngineProvider } from '../../src/lib/engine-context.tsx';
import { useAttachmentUploads } from '../../src/lib/use-attachment-uploads.ts';

function makeWrapper(client: Partial<Client>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <EngineProvider client={client as Client}>{children}</EngineProvider>;
  };
}

function makeFile(name: string, bytes: number[], type = 'image/png'): File {
  return new File([Uint8Array.from(bytes)], name, { type });
}

describe('useAttachmentUploads', () => {
  it('uploads on addFiles: base64 body, ready chip with server meta', async () => {
    const meta = {
      name: 'a.png',
      path: '/x/attachments/a.png',
      content_type: 'image/png',
      size: 3,
    };
    const client = { uploadAttachment: vi.fn().mockResolvedValue(meta) };
    const { result } = renderHook(() => useAttachmentUploads({ conv_id: 'c-1' }), {
      wrapper: makeWrapper(client),
    });

    act(() => result.current.addFiles([makeFile('a.png', [65, 66, 67])]));
    expect(result.current.attachments[0]?.status).toBe('uploading');
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe('ready'));
    expect(client.uploadAttachment).toHaveBeenCalledWith('c-1', {
      name: 'a.png',
      content_type: 'image/png',
      data_base64: 'QUJD',
    });
    expect(result.current.attachments[0]?.meta).toEqual(meta);
  });

  it('failed uploads mark the chip error; remove drops it', async () => {
    const client = { uploadAttachment: vi.fn().mockRejectedValue(new Error('boom')) };
    const { result } = renderHook(() => useAttachmentUploads({ conv_id: 'c-1' }), {
      wrapper: makeWrapper(client),
    });
    act(() => result.current.addFiles([makeFile('b.png', [1])]));
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe('error'));
    act(() => result.current.remove('b.png'));
    expect(result.current.attachments).toEqual([]);
  });

  it('conversation switch resets pending attachments', async () => {
    const meta = { name: 'a.png', path: '/x/a.png', size: 1 };
    const client = { uploadAttachment: vi.fn().mockResolvedValue(meta) };
    const { result, rerender } = renderHook(({ conv }) => useAttachmentUploads({ conv_id: conv }), {
      wrapper: makeWrapper(client),
      initialProps: { conv: 'c-1' },
    });
    act(() => result.current.addFiles([makeFile('a.png', [1])]));
    await waitFor(() => expect(result.current.attachments.length).toBe(1));
    rerender({ conv: 'c-2' });
    expect(result.current.attachments).toEqual([]);
  });
});
