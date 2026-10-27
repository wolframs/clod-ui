/**
 * Attachment storage (Phase 6a part 1, PR #33) — sanitize, collide,
 * write into `<conversation dir>/attachments/`.
 *
 * Names reduce to `[A-Za-z0-9._-]`; path separators are stripped by
 * taking the basename and leading dots are removed, so a stored name
 * can never traverse out of the attachments dir or hide itself.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function sanitizeAttachmentName(name: string): string {
  const base = name.split('/').pop()?.split('\\').pop() ?? '';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return safe.length > 0 ? safe : 'attachment';
}

/** First free name: `x.png`, then `x-2.png`, `x-3.png`, … */
export function withCollisionSuffix(taken: (name: string) => boolean, name: string): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

export async function saveAttachment(opts: {
  attachmentsDir: string;
  name: string;
  bytes: Uint8Array;
}): Promise<{ name: string; path: string; size: number }> {
  mkdirSync(opts.attachmentsDir, { recursive: true });
  const finalName = withCollisionSuffix(
    (candidate) => existsSync(join(opts.attachmentsDir, candidate)),
    sanitizeAttachmentName(opts.name),
  );
  const path = join(opts.attachmentsDir, finalName);
  await writeFile(path, opts.bytes);
  return { name: finalName, path, size: opts.bytes.byteLength };
}
