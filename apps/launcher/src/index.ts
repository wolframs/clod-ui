/**
 * @clod-ui/launcher — one command → working app (Phase 7.3).
 *
 * `bun run start` lands here. Builds the web SPA if its dist is missing,
 * spawns the engine with CLOD_UI_STATIC_DIR pointed at it (same-origin
 * production model), polls /health, opens the default browser at the
 * engine URL, and forwards SIGINT/SIGTERM via an escalation ladder.
 *
 * Sequencing lives in run.ts (fully fake-driven in tests); OS adapters
 * live in effects.ts; this file just composes them.
 *
 * // TODO(pidfile) — the architecture plan says "same pidfile hygiene as
 * the engine", but the engine has none yet (Phase 7.1/7.2 unlanded).
 * The convention should land engine-first; the launcher mirrors it then.
 *
 * Spec: plans/2026-06-10-clod-ui-pr21-launcher-v1.md.
 */
import { realDeps } from './effects.ts';
import { runLauncher } from './run.ts';

const exitCode = await runLauncher(realDeps());
process.exit(exitCode);
