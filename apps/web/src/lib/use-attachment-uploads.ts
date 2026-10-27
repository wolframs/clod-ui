/**
 * `useAttachmentUploads` — pending-attachment state for the Composer
 * (Phase 6a part 2, PR #34). Files upload immediately on selection;
 * chips track `uploading | ready | error`; only `ready` entries ride a
 * submit. Per-conversation reset via the adjust-on-prop pattern.
 */
import type { AttachmentMeta } from '@clod-ui/contracts';
import * as React from 'react';

import { useEngine } from './engine-context.tsx';

export interface UploadedAttachment {
  /** Client-side identity (final server name once ready). */
  name: string;
  status: 'uploading' | 'ready' | 'error';
  meta?: AttachmentMeta;
  size: number;
}

export interface UseAttachmentUploadsReturn {
  attachments: UploadedAttachment[];
  addFiles: (files: ArrayLike<File>) => void;
  remove: (name: string) => void;
  clear: () => void;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function useAttachmentUploads(opts: {
  conv_id: string | undefined;
}): UseAttachmentUploadsReturn {
  const { client } = useEngine();
  const { conv_id } = opts;

  const [attachments, setAttachments] = React.useState<UploadedAttachment[]>([]);

  // Reset per conversation, synchronously during render (PR #19.1 pattern).
  const trackedConvIdRef = React.useRef(conv_id);
  if (trackedConvIdRef.current !== conv_id) {
    trackedConvIdRef.current = conv_id;
    if (attachments.length > 0) setAttachments([]);
  }

  const addFiles = React.useCallback(
    (files: ArrayLike<File>) => {
      if (!conv_id) return;
      for (const file of Array.from(files)) {
        const localName = file.name;
        setAttachments((prev) => [
          ...prev,
          { name: localName, status: 'uploading', size: file.size },
        ]);
        void (async () => {
          try {
            const data_base64 = toBase64(await file.arrayBuffer());
            const meta = await client.uploadAttachment(conv_id, {
              name: localName,
              ...(file.type ? { content_type: file.type } : {}),
              data_base64,
            });
            setAttachments((prev) =>
              prev.map((a) =>
                a.name === localName && a.status === 'uploading'
                  ? { name: meta.name, status: 'ready', meta, size: meta.size }
                  : a,
              ),
            );
          } catch {
            setAttachments((prev) =>
              prev.map((a) =>
                a.name === localName && a.status === 'uploading' ? { ...a, status: 'error' } : a,
              ),
            );
          }
        })();
      }
    },
    [client, conv_id],
  );

  const remove = React.useCallback((name: string) => {
    setAttachments((prev) => prev.filter((a) => a.name !== name));
  }, []);

  const clear = React.useCallback(() => {
    setAttachments([]);
  }, []);

  return { attachments, addFiles, remove, clear };
}
