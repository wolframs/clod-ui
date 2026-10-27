/**
 * @clod-ui/engine — Bun + Hono HTTP server.
 *
 * `createApp()` is the composition root. It wires:
 *
 *   - `GET /health`              (always-on, see routes/health.ts)
 *   - `POST .../turns`           (always-on, see routes/turns.ts)
 *   - `POST .../cancel`          (always-on, see routes/cancel.ts)
 *   - `GET /conversations`       (opt-in via persistence)
 *   - `GET/PUT/PATCH /settings`  (opt-in via opts.settings)
 *
 * Three subsystems gate optional behavior:
 *   - `persistence` (store + db) → provisioning, session-id capture,
 *     conversation listing, manifest folds for auto-title state.
 *   - `transcripts` (projectsDir) → per-conv `TranscriptWatcher` started
 *     on first system.init; broadcasts `transcript.updated`.
 *   - `titler`                   → auto-titling worker; broadcasts
 *     `conversation.titled` after every turn terminator.
 *
 * Binds `127.0.0.1` on an ephemeral port (or CLOD_UI_ENGINE_PORT if set)
 * and logs the chosen port on startup.
 *
 * Refactor history: this module used to be ~760 lines combining route
 * handlers, parse helpers, and lifecycle. PR #16.5 split it into route
 * modules under `routes/`, helpers (`parse-turn-body.ts`, `wire.ts`,
 * `maybe-title.ts`), and kept this file as the orchestrator.
 *
 * Spec: docs/INVARIANTS.md (engine surface invariants).
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { RealClaudeBackend } from '@clod-ui/backend';
import type { ClaudeBackend } from '@clod-ui/backend';
import {
  REPLAY_START_KIND,
  REPLAY_START_SENTINEL_ID as CONTRACT_REPLAY_START_SENTINEL_ID,
} from '@clod-ui/contracts';
import type { EventEnvelope, ReplayStartPayload } from '@clod-ui/contracts';
import { ManifestStore } from '@clod-ui/manifest';
import { SettingsStore } from '@clod-ui/settings';
import type { TranscriptWatcher } from '@clod-ui/transcripts';
import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';

import { openDb } from './db/index.ts';
import { DefaultTitler } from './default-titler.ts';
import { DiagnosticsRing } from './diagnostics.ts';
import { checkRequestOrigin, parseAllowedOrigins } from './origin-guard.ts';
import { ReplayBuffer } from './replay-buffer.ts';
import { registerAttachmentsRoutes } from './routes/attachments.ts';
import { registerCancelRoutes } from './routes/cancel.ts';
import { registerConversationsRoutes } from './routes/conversations.ts';
import { registerDiagnosticsRoutes } from './routes/diagnostics.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerSkillsRoutes } from './routes/skills.ts';
import { registerStaticRoutes } from './routes/static.ts';
import { registerTranscriptRoutes } from './routes/transcript.ts';
import { registerTurnRoutes } from './routes/turns.ts';
import { DEFAULT_GRACE_MS, runSweeper } from './sweeper.ts';
import type { Titler } from './titler.ts';
import { EnvelopeIdSource } from './wire.ts';

/**
 * Sentinel envelope id for `replay.start` control envelopes.
 *
 * Re-exported from `@clod-ui/contracts` for back-compat with existing
 * engine-side imports. The single source of truth lives in
 * `packages/contracts/src/replay.ts`.
 */
export const REPLAY_START_SENTINEL_ID = CONTRACT_REPLAY_START_SENTINEL_ID;

const ENGINE_VERSION = '0.0.0';
const STARTED_AT = Date.now();

/** Hook for a host (Bun.serve fetch handler) to inject per-connection broadcast. */
export interface CreateAppOptions {
  backend: ClaudeBackend;
  /** Called whenever a new envelope is produced. Wired by the host to live sockets. */
  onBroadcast?: (envelope: EventEnvelope) => void;
  engineVersion?: string;
  /** Optional: enables persistence. When omitted, engine runs memory-only. */
  store?: ManifestStore;
  /** Optional: SQLite handle paired with `store`. Both must be present together. */
  db?: Database;
  /**
   * Optional (PR #38, env `CLOD_UI_CONVERSATION_CWD`): cwd for new
   * conversations. Requires persistence; omitted = each conversation gets
   * its own provisioned directory.
   */
  conversationCwd?: string;
  /**
   * Optional: enables the per-conversation transcript watcher. Requires
   * persistence to be enabled too — without `store` + `db`, the engine cannot
   * recover the conversation's cwd at watcher-start time. When omitted, no
   * watcher is started and no `transcript.updated` envelopes are emitted.
   */
  transcripts?: {
    /** Root of `<CLAUDE_HOME>/projects` — Claude Code's per-cwd JSONL store. */
    projectsDir: string;
    /** Optional override of the watcher's poll interval (ms). */
    pollIntervalMs?: number;
    /** Optional override of the watcher's debounce window (ms). */
    debounceMs?: number;
  };
  /**
   * Optional: enables the user-settings routes (`GET/PUT/PATCH /settings`).
   * When omitted, those routes return 404 — memory-only callers (PR #4/#5
   * in-process tests) are unaffected.
   *
   * Spec: plans/landed/2026-04-23-clod-ui-pr8-settings-roundtrip-v1.md §3.
   */
  settings?: {
    store: SettingsStore;
  };
  /**
   * Optional: enables the skills-discovery route (`GET /skills`).
   * Display-only by design (PR #31) — see skills-discovery.ts.
   */
  skills?: {
    dirs: Array<{ scope: 'user' | 'project'; path: string }>;
  };
  /**
   * Optional: enables the per-turn diagnostics ring + `GET /diagnostics`
   * (PR #32). Wire-only (I-8) — never persisted.
   */
  diagnostics?: {
    capacity?: number;
  };
  /**
   * Optional: one attachments-orphan sweep pass at boot (PR #35).
   * Requires persistence. Dry-run unless `dryRun: false` — deletion is
   * a double opt-in. See sweeper.ts for the reference semantics.
   */
  sweeper?: {
    dryRun?: boolean;
    graceMs?: number;
  };
  /**
   * Optional: enables auto-titling. Requires persistence — without `store` +
   * `db`, the engine cannot read/write the manifest event. When omitted, no
   * auto-titling fires and no `conversation.titled` envelopes are emitted.
   *
   * Spec: plans/landed/2026-04-25-clod-ui-pr10-auto-titling-v1.md §Engine wiring.
   */
  titler?: Titler;
  /**
   * Optional: tunes the WS replay buffer. The buffer retains the most
   * recent N envelopes so reconnecting clients can resume mid-stream
   * via `?since=<env_id>`. Default capacity 1024.
   *
   * Spec: plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §3.
   */
  replay?: {
    capacity?: number;
  };
  /**
   * Optional: serves the built web SPA from `dir` as a GET catch-all
   * registered after every API route. Wired by the launcher via
   * `CLOD_UI_STATIC_DIR` so engine + web UI share one origin.
   *
   * Spec: plans/2026-06-10-clod-ui-pr21-launcher-v1.md §2.
   */
  static?: {
    dir: string;
  };
}

export interface AppContext {
  app: Hono;
  /** Replace the broadcast sink (e.g. after Bun.serve is constructed). */
  setBroadcast: (fn: (envelope: EventEnvelope) => void) => void;
  /** Cancel all in-flight turns; used by SIGINT/SIGTERM handlers. */
  cancelAll: () => Promise<void>;
  /**
   * For WS upgrade hosts: compute the replay payload for a connecting
   * client. Returns the per-connection `replay.start` envelope (always
   * present) plus the missed envelopes (empty for a fresh subscriber).
   * The host sends these to the new socket *before* adding it to the
   * live broadcast set, so the client's stream is continuous.
   *
   * Spec: plans/landed/2026-04-30-clod-ui-pr17-reconnect-and-resume-v1.md §4.
   */
  computeReplay: (sinceId: string | null) => {
    start: EventEnvelope;
    envelopes: EventEnvelope[];
  };
}

export function createApp(opts: CreateAppOptions): AppContext {
  const { backend } = opts;
  const engineVersion = opts.engineVersion ?? ENGINE_VERSION;
  const envelopeIds = new EnvelopeIdSource();
  /** turn_id → conv_id, for shutdown cancel-all + bookkeeping. */
  const activeTurns = new Map<string, string>();
  /** conv_id → turn_id currently in flight on that conversation. */
  const activeTurnByConv = new Map<string, string>();
  /** conv_id → live transcript watcher. One per conversation. */
  const watchers = new Map<string, TranscriptWatcher>();
  // Replay buffer — retains recent envelopes for ?since=<id> resume.
  // Sits between the per-route broadcasters and the live broadcast sink so
  // every wrapped envelope is buffered before reaching live sockets.
  const replayBuffer = new ReplayBuffer(
    opts.replay?.capacity !== undefined ? { capacity: opts.replay.capacity } : {},
  );
  let liveSink: (envelope: EventEnvelope) => void = opts.onBroadcast ?? (() => {});
  // The wrapped broadcast that routes call: buffer first, then forward.
  const broadcast: (envelope: EventEnvelope) => void = (envelope) => {
    replayBuffer.push(envelope);
    liveSink(envelope);
  };

  // Validate option combinations up front (I-1: opt-in subsystems compose
  // through configuration, never silently degrade).
  if ((opts.store !== undefined) !== (opts.db !== undefined)) {
    throw new Error('createApp: store and db must be supplied together');
  }
  if (opts.conversationCwd !== undefined && opts.store === undefined) {
    throw new Error('createApp: conversationCwd requires persistence (store + db)');
  }
  const persistence =
    opts.store !== undefined && opts.db !== undefined
      ? {
          store: opts.store,
          db: opts.db,
          ...(opts.conversationCwd !== undefined && { defaultCwd: opts.conversationCwd }),
        }
      : null;
  const transcripts = opts.transcripts ?? null;
  if (transcripts && !persistence) {
    throw new Error(
      'createApp: transcripts requires persistence (store + db) to resolve conversation cwds',
    );
  }
  const titler = opts.titler ?? null;
  if (titler && !persistence) {
    throw new Error(
      'createApp: titler requires persistence (store + db) to read/write conversation state',
    );
  }
  const settingsStore = opts.settings?.store ?? null;
  const diagnosticsRing = opts.diagnostics
    ? new DiagnosticsRing(
        opts.diagnostics.capacity !== undefined ? { capacity: opts.diagnostics.capacity } : {},
      )
    : null;

  const app = new Hono();

  // Always-on routes.
  registerHealthRoutes(app, { backend, engineVersion, startedAt: STARTED_AT });
  registerTurnRoutes(app, {
    backend,
    envelopeIds,
    getBroadcast: () => broadcast,
    activeTurns,
    activeTurnByConv,
    watchers,
    persistence,
    transcripts,
    titler,
    diagnostics: diagnosticsRing,
  });
  registerCancelRoutes(app, { backend });

  // Opt-in routes.
  registerConversationsRoutes(app, { persistence });
  registerAttachmentsRoutes(app, { persistence });
  registerTranscriptRoutes(app, { persistence, transcripts });
  registerSettingsRoutes(app, { store: settingsStore });
  registerSkillsRoutes(app, { skills: opts.skills ?? null });
  registerDiagnosticsRoutes(app, { ring: diagnosticsRing });
  // Static SPA fallback must stay last — API routes win by registration order.
  registerStaticRoutes(app, { staticDir: opts.static?.dir ?? null });

  // Attachments orphan sweeper (PR #35): one fire-and-forget boot pass.
  if (opts.sweeper && persistence) {
    void runSweeper({
      store: persistence.store,
      db: persistence.db,
      projectsDir: transcripts?.projectsDir ?? null,
      dryRun: opts.sweeper.dryRun ?? true,
      graceMs: opts.sweeper.graceMs ?? DEFAULT_GRACE_MS,
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[sweeper] pass failed', err);
    });
  }

  return {
    app,
    setBroadcast: (fn) => {
      liveSink = fn;
    },
    cancelAll: async () => {
      for (const turnId of activeTurns.keys()) {
        try {
          await backend.cancel(turnId);
        } catch {
          // best-effort during shutdown
        }
      }
      for (const watcher of watchers.values()) {
        try {
          await watcher.stop();
        } catch {
          // best-effort during shutdown
        }
      }
      watchers.clear();
    },
    computeReplay: (sinceId) => {
      const result = replayBuffer.since(sinceId);
      const payload: ReplayStartPayload = {
        kind: REPLAY_START_KIND,
        since: sinceId,
        replayed_count: result.envelopes.length,
        gap: result.gap,
      };
      const start: EventEnvelope = {
        v: 1,
        id: REPLAY_START_SENTINEL_ID,
        ts: Date.now(),
        kind: REPLAY_START_KIND,
        payload,
      };
      return { start, envelopes: result.envelopes };
    },
  };
}

// ---- default app + entrypoint ---------------------------------------------

// CLOD_UI_CLAUDE_BINARY (PR #38): run turns through a wrapper (e.g. a
// project's seat script that appends its operator prompt) instead of the
// bare `claude` on PATH.
const claudeBinaryEnv = process.env['CLOD_UI_CLAUDE_BINARY'];
// CLOD_UI_WARM_IDLE_MS (PR #39): how long a conversation's CLI process waits
// for its next turn before it is retired. Default 1h, the prompt-cache TTL
// the CLI requests; 0 = one process per turn (the pre-PR #39 behaviour).
const warmIdleEnv = Number(process.env['CLOD_UI_WARM_IDLE_MS'] ?? 3_600_000);
// CLOD_UI_WARM_MAX (PR #40): cap on warm processes, default 4.
const warmMaxEnv = Number(process.env['CLOD_UI_WARM_MAX'] ?? 4);
const defaultBackend = new RealClaudeBackend({
  ...(claudeBinaryEnv ? { claudeBinary: claudeBinaryEnv } : {}),
  warmIdleMs: Number.isFinite(warmIdleEnv) && warmIdleEnv > 0 ? warmIdleEnv : 0,
  warmMax: Number.isInteger(warmMaxEnv) && warmMaxEnv > 0 ? warmMaxEnv : 4,
});

/** Resolve the app-data root from env/HOME. Used by the production entrypoint only. */
function resolveAppDataDir(): string | null {
  const explicit = process.env['CLOD_UI_APP_DATA_DIR'];
  if (explicit) return explicit;
  const home = process.env['HOME'];
  if (home) return join(home, '.local', 'share', 'clod-ui');
  return null;
}

/** Resolve `<CLAUDE_HOME>/projects` for the transcript watcher. */
function resolveProjectsDir(): string | null {
  const claudeHome = process.env['CLAUDE_HOME'];
  if (claudeHome) return join(claudeHome, 'projects');
  const home = process.env['HOME'] ?? homedir();
  if (home) return join(home, '.claude', 'projects');
  return null;
}

/** Resolve the skills roots for `GET /skills` (PR #31). */
function resolveSkillsDirs(
  projectDir: string = process.cwd(),
): Array<{ scope: 'user' | 'project'; path: string }> {
  const claudeHome =
    process.env['CLAUDE_HOME'] ?? join(process.env['HOME'] ?? homedir(), '.claude');
  return [
    { scope: 'user', path: join(claudeHome, 'skills') },
    { scope: 'project', path: join(projectDir, '.claude', 'skills') },
  ];
}

/** Resolve `<CLAUDE_HOME>/settings.json` for the user-settings routes. */
function resolveSettingsPath(): string | null {
  const claudeHome = process.env['CLAUDE_HOME'];
  if (claudeHome) return join(claudeHome, 'settings.json');
  const home = process.env['HOME'] ?? homedir();
  if (home) return join(home, '.claude', 'settings.json');
  return null;
}

/**
 * Serve an `AppContext` over HTTP + WS on 127.0.0.1 (PR #36): wires the
 * broadcast sink to live sockets and the `?since=` replay handshake.
 * Shared by the production entrypoint below and the deep-tier E2E
 * server (`tests/e2e/serve-deep.ts`) so the WS plumbing cannot drift.
 */
export function startEngineServer(
  context: AppContext,
  opts: {
    port: number;
    /** Extra origins accepted by the same-origin guard (PR #38). */
    allowedOrigins?: readonly string[];
  },
): { server: ReturnType<typeof Bun.serve>; dropSockets: () => number } {
  const sockets = new Set<WebSocket>();
  context.setBroadcast((envelope) => {
    const data = JSON.stringify(envelope);
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        /* socket will be culled on close */
      }
    }
  });

  const server = Bun.serve<{ sinceId: string | null }, never>({
    hostname: '127.0.0.1',
    port: opts.port,
    fetch: (req, srv) => {
      const url = new URL(req.url);
      // Same-origin guard (PR #38): cross-site writes and WS handshakes are
      // refused before routing — see origin-guard.ts for the threat.
      if (!checkRequestOrigin(req, url.pathname === '/ws', opts.allowedOrigins ?? [])) {
        return new Response(JSON.stringify({ error: 'cross-origin request refused' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/ws') {
        const sinceId = url.searchParams.get('since');
        const upgraded = srv.upgrade(req, { data: { sinceId } });
        if (upgraded) return undefined;
        return new Response('upgrade failed', { status: 400 });
      }
      return context.app.fetch(req);
    },
    websocket: {
      open: (ws) => {
        // Replay-and-resume: send any buffered envelopes the client missed
        // before adding the socket to the live broadcast set, so the
        // client's stream is continuous.
        const sinceId = ws.data?.sinceId ?? null;
        const replay = context.computeReplay(sinceId);
        try {
          ws.send(JSON.stringify(replay.start));
          for (const env of replay.envelopes) {
            ws.send(JSON.stringify(env));
          }
        } catch {
          /* socket will be culled on close */
        }
        sockets.add(ws as unknown as WebSocket);
      },
      close: (ws) => {
        sockets.delete(ws as unknown as WebSocket);
      },
      message: () => {
        /* no framed client→server protocol yet */
      },
    },
  });

  return {
    server,
    /** Test-tier affordance (PR #36): force-close every live WS. */
    dropSockets: () => {
      const n = sockets.size;
      for (const ws of sockets) {
        try {
          ws.close(1012, 'test drop');
        } catch {
          /* already gone */
        }
      }
      sockets.clear();
      return n;
    },
  };
}

// Memory-only at import time. The production entrypoint (`import.meta.main`)
// upgrades to persistent mode by creating a new context with `store` + `db`.
// Tests that need persistence call `createApp` directly with their own store
// and db rooted at a temp dir.
const defaultContext = createApp({ backend: defaultBackend });
export const app = defaultContext.app;

// Only start the server when run directly (not when imported by tests).
if (import.meta.main) {
  defaultBackend.start();

  const appDataDir = resolveAppDataDir();
  // First boot on a fresh machine: SQLite cannot create its file inside a
  // directory that doesn't exist yet.
  if (appDataDir) mkdirSync(appDataDir, { recursive: true });
  const store = appDataDir ? new ManifestStore(appDataDir) : undefined;
  const db = appDataDir ? openDb({ path: join(appDataDir, 'engine.sqlite') }) : undefined;
  const projectsDir = store && db ? resolveProjectsDir() : null;
  const settingsPath = resolveSettingsPath();
  const settingsStore = settingsPath ? new SettingsStore({ path: settingsPath }) : undefined;
  // Static SPA serving — set by the launcher (PR #21) to apps/web/dist so
  // the engine origin serves the web UI (same-origin production model).
  const staticDir = process.env['CLOD_UI_STATIC_DIR'];
  const liveOpts: CreateAppOptions = { backend: defaultBackend };
  if (store && db) {
    liveOpts.store = store;
    liveOpts.db = db;
    const conversationCwd = process.env['CLOD_UI_CONVERSATION_CWD'];
    if (conversationCwd) liveOpts.conversationCwd = conversationCwd;
    if (projectsDir) liveOpts.transcripts = { projectsDir };
    // Auto-titling defaults to DefaultTitler (`claude -p` against Haiku,
    // with FallbackTitler delegation on every failure path).
    liveOpts.titler = new DefaultTitler();
  }
  if (settingsStore) liveOpts.settings = { store: settingsStore };
  // Project skills follow the conversations' cwd when one is configured.
  liveOpts.skills = { dirs: resolveSkillsDirs(liveOpts.conversationCwd) };
  // Diagnostics: always on in production — localhost-only engine, the
  // ring holds the operator's own (redacted) traffic.
  liveOpts.diagnostics = {};
  // Sweeper (PR #35): off unless CLOD_UI_SWEEPER is set; 'delete' is the
  // only value that actually unlinks — everything else means dry-run.
  const sweeperEnv = process.env['CLOD_UI_SWEEPER'];
  if (sweeperEnv && store && db) {
    liveOpts.sweeper = { dryRun: sweeperEnv !== 'delete' };
  }
  if (staticDir) liveOpts.static = { dir: staticDir };
  const liveContext = createApp(liveOpts);

  const portEnv = process.env['CLOD_UI_ENGINE_PORT'];
  const port = portEnv ? Number(portEnv) : 0;
  const { server } = startEngineServer(liveContext, {
    port,
    allowedOrigins: parseAllowedOrigins(process.env['CLOD_UI_ALLOWED_ORIGINS']),
  });
  // eslint-disable-next-line no-console
  console.log(`[engine] listening on http://127.0.0.1:${server.port}`);
  if (appDataDir) {
    // eslint-disable-next-line no-console
    console.log(`[engine] app-data: ${appDataDir}`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`[engine] ${signal} — shutting down`);
    await liveContext.cancelAll();
    server.stop();
    await defaultBackend.stop();
    db?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
