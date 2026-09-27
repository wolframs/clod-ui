/**
 * Read an entire JSONL transcript file into typed lines. The async, whole-file
 * companion to `TranscriptWatcher`'s line-by-line tailing.
 *
 * Discovery API mirrors `TranscriptWatcher`: the caller supplies
 * `(projectsDir, cwd, sessionId)`; the function resolves
 * `<projectsDir>/<encodeCwd(cwd)>/<sessionId>.jsonl` internally.
 *
 * Semantics:
 *   - Projects dir / conversation dir / file missing → resolves to `[]`.
 *   - File empty                                     → resolves to `[]`.
 *   - File present                                   → returns one
 *     `TranscriptLine` per `\n`-separated line, plus one final entry for any
 *     trailing partial line (real CC files always end with `\n`; this is
 *     robust to in-progress writes).
 *   - Parse errors                                   → carried in
 *     `line.parse_error`; never thrown.
 *
 * `byte_offset` mirrors the watcher's accounting: each line's offset is its
 * starting byte position in the file, computed via `Buffer.byteLength` so
 * multi-byte UTF-8 sequences land on the correct boundary.
 *
 * **Wire / route identity** — every `TranscriptLine` returned here goes
 * through the *same* `parseTranscriptLine` primitive that the watcher uses
 * to produce `transcript.updated` envelopes. The two surfaces yield
 * byte-identical shapes (down to the `parse_error` payload). See
 * `docs/INVARIANTS.md` I-9.
 *
 * Spec: `plans/landed/2026-05-02-clod-ui-pr20a-transcript-route-v1.md` §"The transcripts helper".
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeCwd } from './encode-cwd.ts';
import { parseTranscriptLine } from './parse-line.ts';
import type { TranscriptLine } from './types.ts';

export interface ReadAllLinesOptions {
  /** Root of `<CLAUDE_HOME>/projects`. */
  projectsDir: string;
  /** Conversation cwd; encodes into the projects-dir subpath. */
  cwd: string;
  /** Claude session id; identifies the JSONL file basename. */
  sessionId: string;
}

export async function readAllLines(opts: ReadAllLinesOptions): Promise<TranscriptLine[]> {
  const filePath = join(opts.projectsDir, encodeCwd(opts.cwd), `${opts.sessionId}.jsonl`);
  if (!existsSync(filePath)) return [];
  const buf = await readFile(filePath);
  if (buf.length === 0) return [];
  const text = buf.toString('utf8');
  const lines: TranscriptLine[] = [];
  let line_number = 0;
  let cursor = 0;
  while (true) {
    const newlineIdx = text.indexOf('\n', cursor);
    if (newlineIdx === -1) break;
    const lineText = text.slice(cursor, newlineIdx);
    const byte_offset = Buffer.byteLength(text.slice(0, cursor), 'utf8');
    lines.push(parseTranscriptLine(line_number, byte_offset, lineText));
    line_number++;
    cursor = newlineIdx + 1;
  }
  if (cursor < text.length) {
    const lineText = text.slice(cursor);
    const byte_offset = Buffer.byteLength(text.slice(0, cursor), 'utf8');
    lines.push(parseTranscriptLine(line_number, byte_offset, lineText));
  }
  return lines;
}
