import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { DEFAULT_GRACE_MS, planSweep, sweepConversation } from '../src/sweeper.ts';

const NOW = 1_750_000_000_000;
const OLD = NOW - DEFAULT_GRACE_MS * 2;

describe('planSweep (pure)', () => {
  test('referenced > recent > orphan, as a table', () => {
    const plan = planSweep({
      files: [
        { name: 'cited.png', mtime_ms: OLD },
        { name: 'new.png', mtime_ms: NOW - 1000 },
        { name: 'orphan.png', mtime_ms: OLD },
      ],
      transcriptText: 'tool read of cited.png here',
      now_ms: NOW,
      graceMs: DEFAULT_GRACE_MS,
    });
    expect(plan).toEqual([
      { name: 'cited.png', action: 'keep', reason: 'referenced' },
      { name: 'new.png', action: 'keep', reason: 'recent' },
      { name: 'orphan.png', action: 'delete', reason: 'orphan' },
    ]);
  });

  test('substring matching is deliberately over-inclusive (conservative)', () => {
    // 'a.png' is a substring of 'mega.png' — kept. Wrong-direction errors
    // (deleting something live) are the ones D1 forbids; keeping extra is fine.
    const plan = planSweep({
      files: [{ name: 'a.png', mtime_ms: OLD }],
      transcriptText: 'transcript mentions mega.png only',
      now_ms: NOW,
      graceMs: DEFAULT_GRACE_MS,
    });
    expect(plan[0]).toEqual({ name: 'a.png', action: 'keep', reason: 'referenced' });
  });

  test('empty transcript references nothing; empty file list plans nothing', () => {
    expect(
      planSweep({ files: [], transcriptText: 'x', now_ms: NOW, graceMs: DEFAULT_GRACE_MS }),
    ).toEqual([]);
    const plan = planSweep({
      files: [{ name: 'a.png', mtime_ms: OLD }],
      transcriptText: '',
      now_ms: NOW,
      graceMs: DEFAULT_GRACE_MS,
    });
    expect(plan[0]?.action).toBe('delete');
  });
});

describe('sweepConversation (shell)', () => {
  let root: string;
  let attachmentsDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clod-ui-sweeper-'));
    attachmentsDir = join(root, 'attachments');
    mkdirSync(attachmentsDir);
    transcriptPath = join(root, 'session.jsonl');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeOldFile(name: string): string {
    const p = join(attachmentsDir, name);
    writeFileSync(p, 'bytes');
    utimesSync(p, new Date(OLD), new Date(OLD));
    return p;
  }

  test('dry-run deletes nothing and reports would_delete', async () => {
    makeOldFile('orphan.png');
    const results = await sweepConversation({
      attachmentsDir,
      transcriptPaths: [transcriptPath],
      dryRun: true,
      graceMs: DEFAULT_GRACE_MS,
    });
    expect(results).toEqual([{ name: 'orphan.png', outcome: 'would_delete' }]);
    expect(existsSync(join(attachmentsDir, 'orphan.png'))).toBe(true);
  });

  test('delete mode removes orphans only; referenced and recent survive', async () => {
    makeOldFile('orphan.png');
    makeOldFile('referenced.png');
    writeFileSync(join(attachmentsDir, 'fresh.png'), 'bytes'); // mtime ≈ now
    writeFileSync(transcriptPath, '{"type":"user","text":"see referenced.png"}\n');

    const results = await sweepConversation({
      attachmentsDir,
      transcriptPaths: [transcriptPath],
      dryRun: false,
      graceMs: DEFAULT_GRACE_MS,
    });
    const byName = Object.fromEntries(results.map((r) => [r.name, r.outcome]));
    expect(byName['orphan.png']).toBe('deleted');
    expect(byName['referenced.png']).toBe('kept_referenced');
    expect(byName['fresh.png']).toBe('kept_recent');
    expect(existsSync(join(attachmentsDir, 'orphan.png'))).toBe(false);
    expect(existsSync(join(attachmentsDir, 'referenced.png'))).toBe(true);
    expect(existsSync(join(attachmentsDir, 'fresh.png'))).toBe(true);
  });

  test('double-check spares a file that becomes referenced between plan and act', async () => {
    const target = makeOldFile('racy.png');
    // `now()` call #1 happens after the plan-time transcript read and
    // before the double-check re-read — writing the reference there is a
    // deterministic stand-in for a turn landing mid-sweep (I-5, D4).
    let calls = 0;
    const racingNow = (): number => {
      calls++;
      if (calls === 1) {
        writeFileSync(transcriptPath, '{"type":"user","text":"now reading racy.png"}\n');
      }
      return NOW;
    };
    const results = await sweepConversation({
      attachmentsDir,
      transcriptPaths: [transcriptPath],
      dryRun: false,
      graceMs: DEFAULT_GRACE_MS,
      now: racingNow,
    });
    expect(results).toEqual([{ name: 'racy.png', outcome: 'spared_changed' }]);
    expect(existsSync(target)).toBe(true);
  });

  test('missing attachments dir is a clean no-op', async () => {
    const results = await sweepConversation({
      attachmentsDir: join(root, 'does-not-exist'),
      transcriptPaths: [],
      dryRun: false,
      graceMs: DEFAULT_GRACE_MS,
    });
    expect(results).toEqual([]);
  });
});
