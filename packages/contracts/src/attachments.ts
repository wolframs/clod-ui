import { z } from 'zod';

/**
 * Attachments intake wire shape (Phase 6a part 1, PR #33).
 *
 * Upload is JSON + base64 (localhost single-user — simplicity over
 * streaming; `TODO(attachments-multipart)` engine-side). File-by-
 * reference holds where it matters: the CLI receives a *path*; bytes
 * never enter its stdin.
 */
export const AttachmentMetaSchema = z.object({
  /** Final (sanitized, collision-suffixed) file name. */
  name: z.string(),
  /** Absolute path on disk — what `TurnRequest.attachments[].path` takes. */
  path: z.string(),
  content_type: z.string().optional(),
  size: z.number(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

export interface AttachmentUploadBody {
  name: string;
  content_type?: string;
  data_base64: string;
}

/** Serving URL for an uploaded attachment (image previews, PR #34). */
export function attachmentUrl(conv_id: string, name: string): string {
  return `/conversations/${encodeURIComponent(conv_id)}/attachments/${encodeURIComponent(name)}`;
}
