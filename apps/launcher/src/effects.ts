/**
 * Real-world adapters for the launcher core's injected effects.
 *
 * Everything here touches the OS: spawning Bun children, reading stdout,
 * hitting /health over loopback, opening the default browser. The
 * sequencing logic lives in `run.ts`; tests cover it with fakes and never
 * execute this module's spawns.
 *
 * Spec: plans/2026-06-10-clod-ui-pr21-launcher-v1.md.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { EngineHandle, LauncherDeps } from './run.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');

function write(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Echo the engine's stdout to ours line-by-line while feeding each line
 * to the core's listen-line parser.
 */
async function forwardStdoutLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  // Explicit reader loop: the DOM lib types don't give ReadableStream an
  // async iterator (Bun supports it at runtime, tsc rejects it).
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      write(line);
      onLine(line);
    }
  }
  if (buffer.length > 0) {
    write(buffer);
    onLine(buffer);
  }
}

/** Platform-appropriate "open this URL in the default browser" argv. */
function openCommand(url: string): string[] {
  switch (process.platform) {
    case 'darwin':
      return ['open', url];
    case 'win32':
      return ['cmd', '/c', 'start', '', url];
    default:
      return ['xdg-open', url];
  }
}

export function realDeps(): LauncherDeps {
  return {
    webDistExists: () => existsSync(join(WEB_DIST, 'index.html')),

    buildWeb: () => {
      const proc = Bun.spawn(['bun', 'run', '--filter', '@clod-ui/web', 'build'], {
        cwd: REPO_ROOT,
        stdout: 'inherit',
        stderr: 'inherit',
      });
      return proc.exited;
    },

    spawnEngine: (onLine, opts): EngineHandle => {
      const proc = Bun.spawn(['bun', join(REPO_ROOT, 'apps', 'engine', 'src', 'index.ts')], {
        cwd: REPO_ROOT,
        // Same-origin production model: the engine serves the built SPA.
        // Restart path pins the first boot's port so the tab's origin survives.
        env: {
          ...process.env,
          CLOD_UI_STATIC_DIR: WEB_DIST,
          ...(opts?.port !== undefined ? { CLOD_UI_ENGINE_PORT: String(opts.port) } : {}),
        },
        stdout: 'pipe',
        stderr: 'inherit',
      });
      void forwardStdoutLines(proc.stdout, onLine);
      return {
        // Bun resolves `exited` with null exitCode on signal death; the
        // core wants a number, and a signal-killed engine is non-zero.
        exited: proc.exited.then((code) => code ?? 1),
        kill: (signal) => proc.kill(signal),
      };
    },

    fetchHealth: async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      return res.status;
    },

    openBrowser: (url) => {
      if (process.env['CLOD_UI_NO_BROWSER']) {
        write(`[launcher] CLOD_UI_NO_BROWSER set — open ${url} yourself`);
        return;
      }
      Bun.spawn(openCommand(url), { stdout: 'ignore', stderr: 'ignore' });
    },

    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),

    log: write,

    onSignal: (handler) => {
      process.on('SIGINT', () => handler('SIGINT'));
      process.on('SIGTERM', () => handler('SIGTERM'));
    },
  };
}
