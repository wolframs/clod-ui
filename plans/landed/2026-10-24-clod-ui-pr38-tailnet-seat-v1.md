# PR #38 — tailnet seat: same-origin guard, conversation cwd, binary override

_2026-10-24. Written and landed in one go by a Claude agent (Opus 5.5), on
the operator's ask: "set the clod-ui project up for connecting to you, and
serving it via tailscale". Not part of the S1–S14 queue; PR #37
(ci:nightly, S12) is still open with its work uncommitted in the tree and was
left untouched._

## What and why

The first real use of clod-ui is as a window onto one project's seat (an
agent workspace with its own CLAUDE.md and hooks), from the operator's phone
and other machines on their tailnet. Three small seams make that possible without touching the web
app:

1. **Same-origin guard** (`apps/engine/src/origin-guard.ts`), the first
   Phase 8 seam actually activated. Once the engine has a stable name
   (Tailscale Serve proxies `https://<host>.ts.net:<port>` to loopback), any
   page in a tailnet browser could send a "simple" cross-site POST
   (`text/plain`, no preflight) to `/conversations/:id/turns` and start a turn
   with the operator's tools, or open `/ws` and read the stream. Rule:
   non-safe methods and WS upgrades with an `Origin` must match `Host`, or be
   listed in `CLOD_UI_ALLOWED_ORIGINS`; no `Origin` = non-browser client =
   allowed. Applied in `startEngineServer` before routing, so it covers every
   route and the deep-tier E2E server alike.
2. **`CLOD_UI_CONVERSATION_CWD`** → `CreateAppOptions.conversationCwd` →
   `ProvisioningContext.defaultCwd`. New conversations run in that directory
   (its CLAUDE.md, hooks, MCP config); `scratch/` and `attachments/` stay per
   conversation; existing rows keep their cwd. Project skills discovery
   follows it.
3. **`CLOD_UI_CLAUDE_BINARY`** → `RealClaudeBackend({ claudeBinary })`, so a
   project's seat wrapper can add its own flags (operator prompt, permission
   mode). `ClaudeBackend.claudeBinary` (optional) lets the diagnostics ring
   record the argv that really ran; before this it always showed `claude`.

Not done here, deliberately: auth tokens, TLS helper, QR pairing (Tailscale
supplies identity and TLS for this deployment), and any UI for picking a cwd.

## Tests

- `apps/engine/tests/origin-guard.test.ts`: the rule as a 12-row table, plus
  the real server refusing a cross-site POST and WS handshake (403) while an
  Origin-less POST reaches the route.
- `provisioning.test.ts`: `defaultCwd` anchors a new conversation.
- `diagnostics.test.ts`: argv[0] is the backend's binary.

bun tier: 748 pass, 0 fail (with `tests/nightly/**` excluded: that is PR #37's
uncommitted work, and its tape replay times out). The vitest dom tier fails
8 of 21 files with `undefined is not an object (evaluating 'z.object')` at
HEAD too, before this change; not investigated here.

## Deployment

Where it runs, on which port and URL, and how to stop it live in the
operator's own machine notes, not in this repo. A seat wrapper is a script
passed as `CLOD_UI_CLAUDE_BINARY` that adds the project's flags and execs
`claude`. After changing `apps/web`, rebuild the dist (`bun run --filter @clod-ui/web
build`); the launcher only builds when it is missing.
