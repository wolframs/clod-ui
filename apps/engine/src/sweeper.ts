/**
 * Attachments orphan sweeper (Phase 6b, PR #35).
 *
 * Reference semantics (D1, deliberately the most conservative practical
 * test): a file is referenced iff its name appears anywhere in the
 * conversation's transcript JSONL text. Referenced OR recent (grace
 * window, D2) ⇒ keep. The plan is pure; the shell does I-5
 * double-checks before every unlink — re-stat + re-read, any
 * discrepancy spares the file. Dry-run is the default everywhere.
 */
import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { ManifestStore } from '@clod-ui/manifest';
import { encodeCwd } from '@clod-ui/transcripts';
import type { Database } from 'bun:sqlite';

import { listConversations } from './db/index.ts';

export const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000;

export interface SweepDecision {
  name: string;
  action: 'keep' | 'delete';
  reason: 'referenced' | 'recent' | 'orphan';
}

/** Pure: same inputs, same plan. Fixture trees are tables over this. */
export function planSweep(input: {
  files: Array<{ name: string; mtime_ms: number }>;
  transcriptText: string;
  now_ms: number;
  graceMs: number;
}): SweepDecision[] {
  return input.files.map((file) => {
    if (input.transcriptText.includes(file.name)) {
      return { name: file.name, action: 'keep', reason: 'referenced' };
    }
    if (input.now_ms - file.mtime_ms < input.graceMs) {
      return { name: file.name, action: 'keep', reason: 'recent' };
    }
    return { name: file.name, action: 'delete', reason: 'orphan' };
  });
}

export type SweepOutcome =
  | 'kept_referenced'
  | 'kept_recent'
  | 'deleted'
  | 'would_delete'
  | 'spared_changed';

export interface SweepResult {
  name: string;
  outcome: SweepOutcome;
}

async function readTranscripts(paths: string[]): Promise<string> {
  let text = '';
  for (const p of paths) {
    try {
      text += await readFile(p, 'utf8');
    } catch {
      // missing transcript contributes nothing — grace window still guards
    }
  }
  return text;
}

/**
 * One conversation's sweep. Never throws; every per-file failure spares
 * the file.
 */
export async function sweepConversation(opts: {
  attachmentsDir: string;
  transcriptPaths: string[];
  dryRun: boolean;
  graceMs: number;
  now?: () => number;
}): Promise<SweepResult[]> {
  const now = opts.now ?? Date.now;
  let names: string[];
  try {
    names = await readdir(opts.attachmentsDir);
  } catch {
    return []; // no attachments dir → nothing to do
  }

  const files: Array<{ name: string; mtime_ms: number }> = [];
  for (const name of names) {
    try {
      const info = await stat(join(opts.attachmentsDir, name));
      if (info.isFile()) files.push({ name, mtime_ms: info.mtimeMs });
    } catch {
      // raced away — nothing to sweep
    }
  }

  const transcriptText = await readTranscripts(opts.transcriptPaths);
  const plan = planSweep({ files, transcriptText, now_ms: now(), graceMs: opts.graceMs });

  const results: SweepResult[] = [];
  for (const decision of plan) {
    if (decision.action === 'keep') {
      results.push({
        name: decision.name,
        outcome: decision.reason === 'referenced' ? 'kept_referenced' : 'kept_recent',
      });
      continue;
    }
    if (opts.dryRun) {
      results.push({ name: decision.name, outcome: 'would_delete' });
      continue;
    }
    // I-5 double-check (D4): re-stat + re-read; any change spares the file.
    try {
      const planned = files.find((f) => f.name === decision.name);
      const fresh = await stat(join(opts.attachmentsDir, decision.name));
      const freshText = await readTranscripts(opts.transcriptPaths);
      const stillOrphan =
        planned !== undefined &&
        fresh.mtimeMs === planned.mtime_ms &&
        !freshText.includes(decision.name) &&
        now() - fresh.mtimeMs >= opts.graceMs;
      if (!stillOrphan) {
        results.push({ name: decision.name, outcome: 'spared_changed' });
        continue;
      }
      await unlink(join(opts.attachmentsDir, decision.name));
      results.push({ name: decision.name, outcome: 'deleted' });
    } catch {
      results.push({ name: decision.name, outcome: 'spared_changed' });
    }
  }
  return results;
}

/**
 * Boot-time pass over every provisioned conversation. Fire-and-forget:
 * the caller `void`s this; failures log and never propagate.
 */
export async function runSweeper(opts: {
  store: ManifestStore;
  db: Database;
  projectsDir: string | null;
  dryRun: boolean;
  graceMs: number;
}): Promise<void> {
  let totals = { kept: 0, deleted: 0, would: 0, spared: 0 };
  for (const row of listConversations(opts.db)) {
    const attachmentsDir = join(opts.store.conversationDir(row.id), 'attachments');
    const transcriptPaths: string[] = [];
    if (opts.projectsDir) {
      const dir = join(opts.projectsDir, encodeCwd(row.cwd));
      transcriptPaths.push(join(dir, `${row.claude_session_id ?? row.id}.jsonl`));
    }
    const results = await sweepConversation({
      attachmentsDir,
      transcriptPaths,
      dryRun: opts.dryRun,
      graceMs: opts.graceMs,
    });
    for (const r of results) {
      if (r.outcome === 'deleted') totals = { ...totals, deleted: totals.deleted + 1 };
      else if (r.outcome === 'would_delete') totals = { ...totals, would: totals.would + 1 };
      else if (r.outcome === 'spared_changed') totals = { ...totals, spared: totals.spared + 1 };
      else totals = { ...totals, kept: totals.kept + 1 };
      if (r.outcome === 'deleted' || r.outcome === 'would_delete') {
        // eslint-disable-next-line no-console
        console.warn(`[sweeper] ${row.id}/${r.name}: ${r.outcome}`);
      }
    }
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[sweeper] pass complete (dryRun=${opts.dryRun}): kept=${totals.kept} deleted=${totals.deleted} would_delete=${totals.would} spared=${totals.spared}`,
  );
}
