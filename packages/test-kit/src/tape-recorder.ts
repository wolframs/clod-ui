import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { CliTape } from './tape-backend.ts';

export interface RecordTapeOptions {
  name: string;
  promptFile: string;
  cwd?: string;
  allowTools?: string[];
  model?: string;
  outDir?: string;
  /** Override the `claude` binary path for recording. */
  claudeBinary?: string;
}

/**
 * Spawns a real `claude -p` invocation, captures stdin/stdout/stderr with
 * per-event timing, and writes a CliTape JSON file. Not in CI — manual use
 * plus nightly-maintenance.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr1-foundation-v2.md Task 6.10.
 */
export async function recordTape(
  opts: RecordTapeOptions,
): Promise<{ path: string; tape: CliTape }> {
  const outDir = opts.outDir ?? resolve('tests/fixtures/cli-tapes');
  const outPath = resolve(outDir, `${opts.name}.tape.json`);

  const promptBytes = await Bun.file(opts.promptFile).arrayBuffer();
  const stdinBuf = new Uint8Array(promptBytes);

  const argv: string[] = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json'];
  if (opts.model) argv.push('--model', opts.model);
  if (opts.allowTools && opts.allowTools.length > 0) {
    argv.push('--allowedTools', opts.allowTools.join(','));
  }

  const envRedacted: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'TERM']) {
    const v = process.env[key];
    if (v != null) envRedacted[key] = v;
  }

  const binary = opts.claudeBinary ?? 'claude';
  const startedAt = Date.now();
  const child = spawn(binary, argv, {
    cwd: opts.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  const events: Array<{ ts_ms: number; line: string }> = [];
  const stderr: Array<{ ts_ms: number; line: string }> = [];

  const stdoutBuf = new LineAccumulator((line) => {
    events.push({ ts_ms: Date.now() - startedAt, line });
  });
  const stderrBuf = new LineAccumulator((line) => {
    stderr.push({ ts_ms: Date.now() - startedAt, line });
  });

  child.stdout.on('data', (chunk: Buffer) => stdoutBuf.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrBuf.push(chunk));

  child.stdin.write(stdinBuf);
  child.stdin.end();

  const exitCode = await new Promise<number>((resolvePromise) => {
    child.on('close', (code) => resolvePromise(code ?? 0));
  });
  stdoutBuf.flush();
  stderrBuf.flush();

  const tape: CliTape = {
    cc_version: await detectClaudeVersion(binary),
    recorded_at: startedAt,
    argv,
    env_redacted: envRedacted,
    stdin_b64: Buffer.from(stdinBuf).toString('base64'),
    events,
    stderr,
    exit_code: exitCode,
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(tape, null, 2), 'utf8');
  return { path: outPath, tape };
}

async function detectClaudeVersion(binary: string): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn(binary, ['--version']);
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('close', () => resolvePromise(out.trim() || 'unknown'));
    child.on('error', () => resolvePromise('unknown'));
  });
}

class LineAccumulator {
  private buf = '';
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Buffer): void {
    this.buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.length > 0) this.onLine(line);
    }
  }
  flush(): void {
    if (this.buf.length > 0) {
      this.onLine(this.buf);
      this.buf = '';
    }
  }
}
