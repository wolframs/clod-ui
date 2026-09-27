/**
 * T1.12 — Health and readiness.
 *
 * Contract: `GET /health` returns a `HealthResponse` whose `cli` field
 * reflects the CC CLI's real state. In practice three values surface:
 *   - `ok`      — `claude --version` succeeded and stdout parsed a version.
 *   - `missing` — binary not on PATH (or absolute path doesn't exist).
 *   - `crashed` — spawn failed, probe timed out, or stdout was unparseable.
 *
 * Design decision (PR #5): `unauthenticated` is NOT surfaced at `/health`.
 * Authentication state is not probeable without a real turn (any ping costs
 * an API call and risks rate limits); instead, auth failures emerge from
 * the first real turn as `turn.error{kind: 'auth_failed', retryable: false}`.
 * The `unauthenticated` enum value is kept in the `HealthCliStatus` schema
 * as a reserved label for future use but deliberately never reported.
 *
 * Covered here: the two realistic states an engine instance actually enters
 * at startup based on environment — `missing` (no claude on PATH) and `ok`
 * (synthetic shim on PATH). The `crashed` branch is unit-tested separately
 * in `packages/backend/tests/real.test.ts` (probe timeout, non-zero exit,
 * unparseable stdout); replicating it as a spine test would duplicate
 * coverage without new contract value.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { HealthResponse } from '@clod-ui/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

const ENGINE_ENTRY = resolve(import.meta.dir, '../../apps/engine/src/index.ts');

interface SpawnedEngine {
  url: string;
  stop(): Promise<void>;
}

/**
 * Spawn `apps/engine` as a Bun subprocess with the given env. Waits for the
 * `[engine] listening on http://127.0.0.1:<port>` log line, returns a handle
 * whose `stop()` SIGTERMs the child and awaits exit.
 */
async function spawnEngine(env: Record<string, string>): Promise<SpawnedEngine> {
  // `bun run …` normally resolves `bun` via PATH, but our tests deliberately
  // munge PATH to hide `claude`. Use the current process's own bun path so we
  // don't hide bun from itself.
  const bunBin = process.argv[0] ?? 'bun';
  const proc = Bun.spawn([bunBin, 'run', ENGINE_ENTRY], {
    env: { CLOD_UI_ENGINE_PORT: '0', ...env, CLOD_UI_BUN_GUARD: 'off' },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  const deadline = Date.now() + 10_000;
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let port: number | undefined;
  while (Date.now() < deadline && port === undefined) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
    if (m && m[1]) port = Number(m[1]);
  }
  // Release the lock so we don't hold the stream; we don't need further output.
  reader.releaseLock();

  if (port === undefined) {
    proc.kill('SIGKILL');
    throw new Error(`engine failed to bind within 10s; log so far:\n${buf}`);
  }

  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      proc.kill('SIGTERM');
      const exited = await Promise.race([
        proc.exited,
        new Promise<number>((r) => setTimeout(() => r(-1), 2_000)),
      ]);
      if (exited === -1) proc.kill('SIGKILL');
    },
  };
}

let shimDir: string;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), 'clod-ui-t1.12-'));
});

afterAll(() => {
  rmSync(shimDir, { recursive: true, force: true });
});

const started: SpawnedEngine[] = [];
afterEach(async () => {
  while (started.length > 0) {
    const s = started.pop();
    if (s) await s.stop();
  }
});

async function track<T extends SpawnedEngine>(p: Promise<T>): Promise<T> {
  const e = await p;
  started.push(e);
  return e;
}

async function pollHealth(
  url: string,
  predicate: (r: HealthResponse) => boolean,
): Promise<HealthResponse> {
  const deadline = Date.now() + 5_000;
  let last: HealthResponse | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        last = (await res.json()) as HealthResponse;
        if (predicate(last)) return last;
      }
    } catch {
      // engine may still be starting; retry
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`/health did not satisfy predicate within 5s; last=${JSON.stringify(last)}`);
}

describe('T1.12 health and readiness', () => {
  test('missing CLI yields cli:"missing" with no version', async () => {
    // PATH deliberately excludes any directory that could contain `claude`.
    const emptyDir = join(shimDir, 'empty-path');
    mkdirSync(emptyDir, { recursive: true });
    const engine = await track(spawnEngine({ PATH: emptyDir }));
    const body = await pollHealth(engine.url, (r) => r.cli === 'missing');
    expect(body.cli).toBe('missing');
    expect(body.version).toBeUndefined();
    expect(body.engine_version).toBe('0.0.0');
    expect(typeof body.started_at).toBe('number');
  });

  test('ok CLI yields cli:"ok" with version string', async () => {
    // Put a synthetic `claude` shim on PATH. It prints a version, exits 0.
    const binDir = join(shimDir, 'ok-bin');
    mkdirSync(binDir, { recursive: true });
    const shimPath = join(binDir, 'claude');
    writeFileSync(shimPath, `#!/usr/bin/env bash\nprintf %s '99.0.0 (Claude Code)\\n'\nexit 0\n`);
    chmodSync(shimPath, 0o755);
    const engine = await track(spawnEngine({ PATH: `${binDir}:/usr/bin:/bin` }));
    const body = await pollHealth(engine.url, (r) => r.cli === 'ok');
    expect(body.cli).toBe('ok');
    expect(body.version).toBe('99.0.0');
    expect(body.engine_version).toBe('0.0.0');
  });
});
