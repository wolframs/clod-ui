/**
 * Attachments routes (Phase 6a part 1, PR #33).
 *
 *   POST /conversations/:id/attachments   JSON { name, content_type?,
 *     data_base64 } → 201 AttachmentMeta; provisions the conversation
 *     on demand so upload-before-first-turn works.
 *   GET  /conversations/:id/attachments/:name  serves the stored file
 *     (image previews); resolution never escapes the attachments dir.
 *
 * Opt-in via persistence (I-1): absent → `404 { error: 'attachments
 * not configured' }`.
 */
import { join, resolve, sep } from 'node:path';

import type { Hono } from 'hono';

import { saveAttachment } from '../attachments.ts';
import { ensureProvisioned, type ProvisioningContext } from '../provisioning.ts';

export interface AttachmentsRouteDeps {
  persistence: ProvisioningContext | null;
}

export function registerAttachmentsRoutes(app: Hono, deps: AttachmentsRouteDeps): void {
  app.post('/conversations/:id/attachments', async (c) => {
    const { persistence } = deps;
    if (!persistence) return c.json({ error: 'attachments not configured' }, 404);
    const convId = c.req.param('id');

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const name = body['name'];
    const contentType = body['content_type'];
    const data = body['data_base64'];
    if (typeof name !== 'string' || name.length === 0) {
      return c.json({ error: 'name is required (string)' }, 400);
    }
    if (contentType !== undefined && typeof contentType !== 'string') {
      return c.json({ error: 'content_type must be a string' }, 400);
    }
    if (typeof data !== 'string') {
      return c.json({ error: 'data_base64 is required (string)' }, 400);
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(data, 'base64'));
    } catch {
      return c.json({ error: 'data_base64 is not valid base64' }, 400);
    }

    try {
      await ensureProvisioned(persistence, { convId });
    } catch (err) {
      return c.json({ error: { kind: 'provisioning_failed', detail: String(err) } }, 500);
    }
    const attachmentsDir = join(persistence.store.conversationDir(convId), 'attachments');
    const saved = await saveAttachment({ attachmentsDir, name, bytes });
    return c.json(
      {
        name: saved.name,
        path: saved.path,
        ...(contentType !== undefined && { content_type: contentType }),
        size: saved.size,
      },
      201,
    );
  });

  app.get('/conversations/:id/attachments/:name', async (c) => {
    const { persistence } = deps;
    if (!persistence) return c.json({ error: 'attachments not configured' }, 404);
    const convId = c.req.param('id');
    const name = c.req.param('name');

    const attachmentsDir = resolve(persistence.store.conversationDir(convId), 'attachments');
    const target = resolve(attachmentsDir, name);
    // Never escape the attachments dir (the static-route precedent).
    if (target !== attachmentsDir && !target.startsWith(attachmentsDir + sep)) {
      return c.json({ error: 'attachment not found' }, 404);
    }
    const file = Bun.file(target);
    if (!(await file.exists())) {
      return c.json({ error: 'attachment not found' }, 404);
    }
    return new Response(file);
  });
}
