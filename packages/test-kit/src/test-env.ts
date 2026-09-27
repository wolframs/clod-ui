import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeClock } from './clock.ts';

export interface TestEnvOptions {
  name?: string;
}

/**
 * Hermetic per-test environment: unique temp dirs, an ephemeral-but-released
 * port, a per-env FakeClock, and a teardown that wipes dirs and reaps any
 * processes started under the env's process group.
 *
 * PR #1 ships the harness surface. Process-group reaping is best-effort via
 * POSIX `kill -- -<pgid>`; Phase 2 will wire real subprocess bookkeeping.
 *
 * Spec: plans/2026-04-23-clod-ui-test-strategy-v1.md T0.3.
 */
export class TestEnv {
  readonly id: string;
  readonly root: string;
  readonly appDataDir: string;
  readonly fakeClaudeHome: string;
  readonly port: number;
  readonly clock: FakeClock;
  /** Root process-group id this env tracks; here it's just the current process. */
  readonly pgid: number;

  private disposed = false;

  private constructor(args: {
    id: string;
    root: string;
    appDataDir: string;
    fakeClaudeHome: string;
    port: number;
    clock: FakeClock;
    pgid: number;
  }) {
    this.id = args.id;
    this.root = args.root;
    this.appDataDir = args.appDataDir;
    this.fakeClaudeHome = args.fakeClaudeHome;
    this.port = args.port;
    this.clock = args.clock;
    this.pgid = args.pgid;
  }

  static async create(opts: TestEnvOptions = {}): Promise<TestEnv> {
    const id =
      (opts.name ? `${opts.name}-` : '') +
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const root = join(tmpdir(), 'clod-ui-test', id);
    const appDataDir = join(root, 'app-data');
    const fakeClaudeHome = join(root, 'fake-claude-home');
    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(fakeClaudeHome, { recursive: true });

    const port = await allocEphemeralPort();
    const clock = new FakeClock();
    const pgid = process.pid;

    return new TestEnv({ id, root, appDataDir, fakeClaudeHome, port, clock, pgid });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Best-effort process-group sweep. We only send to children of our own
    // process group; guarded to avoid signalling the parent session.
    try {
      if (this.pgid !== process.pid) {
        process.kill(-this.pgid, 'SIGKILL');
      }
    } catch {
      // ignore: no children is the happy path
    }
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function allocEphemeralPort(): Promise<number> {
  // Bun.listen on port 0 lets the OS pick; we close immediately and hand the
  // number back. Racy in theory, fine in practice for our test shapes.
  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const port = server.port ?? 0;
  await server.stop(true);
  return port;
}
