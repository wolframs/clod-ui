#!/usr/bin/env bun
/**
 * CI entrypoint.
 *
 * Usage:
 *   bun run scripts/ci.ts <fast|deep|nightly>
 *
 * Policy (per PR-1 plan §9.1):
 *   - runFast: full local gate — install, lint, typecheck, format:check,
 *     all unit tests via `bun test`. Exits non-zero on any failure.
 *   - runDeep: runFast + placeholder for L5 Playwright + L7 chaos + L8 perf.
 *     Exits 0 today; accepted gap until those layers land.
 *   - runNightly: runDeep + placeholder for L1 tape diff + L6 real-CLI smoke.
 *     Exits 0 today; accepted gap.
 *
 * Every entry point first runs `assertBunVersion()` which compares
 * `.bun-version` against `Bun.version` and fails with a clear message on
 * drift. Skippable only via `CLOD_UI_BUN_GUARD=off` for emergency local
 * debug — never in CI.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');

type Cmd = { name: string; argv: string[] };

function log(msg: string): void {
  console.log(`[ci] ${msg}`);
}

function logErr(msg: string): void {
  console.error(`[ci] ${msg}`);
}

function assertBunVersion(): void {
  if (process.env['CLOD_UI_BUN_GUARD'] === 'off') {
    logErr('WARNING: CLOD_UI_BUN_GUARD=off — version guard bypassed. Do not use in CI.');
    return;
  }
  const pinnedPath = resolve(REPO_ROOT, '.bun-version');
  let pinned: string;
  try {
    pinned = readFileSync(pinnedPath, 'utf8').trim();
  } catch (err) {
    logErr(`FATAL: cannot read .bun-version at ${pinnedPath}: ${String(err)}`);
    process.exit(2);
  }
  const actual = Bun.version;
  if (pinned !== actual) {
    logErr('FATAL: Bun version mismatch.');
    logErr(`  .bun-version pins: ${pinned}`);
    logErr(`  Bun.version is:    ${actual}`);
    logErr('  Install the pinned version or set CLOD_UI_BUN_GUARD=off for emergency local debug.');
    process.exit(2);
  }

  // Belt-and-suspenders: also verify package.json#packageManager matches.
  const pkgRaw = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw) as { packageManager?: string };
  const expected = `bun@${pinned}`;
  if (pkg.packageManager !== expected) {
    logErr(
      `FATAL: package.json#packageManager (${String(pkg.packageManager)}) does not match .bun-version (${expected}).`,
    );
    process.exit(2);
  }
}

function run(cmd: Cmd): void {
  log(`→ ${cmd.name}: ${cmd.argv.join(' ')}`);
  const res = spawnSync(cmd.argv[0]!, cmd.argv.slice(1), {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: process.env,
  });
  if (res.status !== 0) {
    logErr(`✗ ${cmd.name} failed (status ${String(res.status)}, signal ${String(res.signal)})`);
    process.exit(res.status ?? 1);
  }
  log(`✓ ${cmd.name}`);
}

/**
 * Link-check: grep the README for repo-relative markdown links and verify
 * each referenced path exists on disk. Fast, no network.
 */
function linkCheckReadme(): void {
  const readmePath = resolve(REPO_ROOT, 'README.md');
  let body: string;
  try {
    body = readFileSync(readmePath, 'utf8');
  } catch {
    log('README.md not present yet — skipping link check.');
    return;
  }
  const mdLink = /\[[^\]]+\]\(([^)]+)\)/g;
  const missing: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mdLink.exec(body)) !== null) {
    const href = match[1]!;
    if (/^https?:/.test(href) || href.startsWith('#') || href.startsWith('mailto:')) continue;
    const rel = href.split('#')[0]!.split('?')[0]!;
    if (rel === '') continue;
    const target = resolve(REPO_ROOT, rel);
    try {
      statSync(target);
    } catch {
      missing.push(href);
    }
  }
  if (missing.length > 0) {
    logErr(`FATAL: README.md references ${missing.length} missing path(s):`);
    for (const m of missing) logErr(`  - ${m}`);
    process.exit(3);
  }
  log('✓ README link-check (all repo-relative paths resolve)');
}

function runFast(): void {
  run({ name: 'bun install', argv: ['bun', 'install', '--frozen-lockfile'] });
  run({ name: 'lint', argv: ['bun', 'run', 'lint'] });
  run({ name: 'typecheck', argv: ['bun', 'run', 'typecheck'] });
  run({ name: 'format:check', argv: ['bun', 'run', 'format:check'] });
  run({ name: 'test', argv: ['bun', 'test', '--path-ignore-patterns=apps/web/tests/dom/**'] });
  run({ name: 'web:test', argv: ['bun', 'run', 'web:test'] });
  linkCheckReadme();
}

function runDeep(): void {
  runFast();
  log('TODO: L5 Playwright + L7 chaos + L8 perf land in later PRs. Accepted gap per plan §9.1.');
}

function runNightly(): void {
  runDeep();
  log('TODO: L1 tape diff + L6 real-CLI smoke land in later PRs. Accepted gap per plan §9.1.');
}

function main(): void {
  assertBunVersion();
  const mode = process.argv[2];
  switch (mode) {
    case 'fast':
      runFast();
      break;
    case 'deep':
      runDeep();
      break;
    case 'nightly':
      runNightly();
      break;
    default:
      logErr(`usage: bun run scripts/ci.ts <fast|deep|nightly>; got: ${String(mode)}`);
      process.exit(64);
  }
}

main();
