/**
 * Same-origin guard for state-changing requests and WS upgrades
 * (PR #38, the first Phase 8 seam to be activated).
 *
 * Why: once the engine is reachable on a stable name (Tailscale Serve
 * proxies `https://<host>.ts.net:<port>` to the loopback port), any web
 * page open in a tailnet device's browser could fire a "simple" cross-site
 * POST (text/plain body, no preflight) at `/conversations/:id/turns` and
 * start a turn with the operator's tools, or open `/ws` and read the event
 * stream. Browsers always send `Origin` on cross-origin POSTs and on WS
 * handshakes, so comparing it to `Host` closes both without a token.
 *
 * Rules (pure, table-tested):
 *   - Safe methods (GET/HEAD/OPTIONS) that are not WS upgrades: allowed.
 *   - No `Origin` header: allowed. Non-browser clients (curl, the test
 *     kit) do not send one, and a browser always does on the requests
 *     this guard exists for.
 *   - `Origin` present: allowed iff its host equals the request's `Host`
 *     header, or the origin is listed in `allowedOrigins`.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckInput {
  method: string;
  origin: string | null;
  host: string | null;
  isWsUpgrade: boolean;
  allowedOrigins?: readonly string[];
}

export function isOriginAllowed(input: OriginCheckInput): boolean {
  if (!input.isWsUpgrade && SAFE_METHODS.has(input.method.toUpperCase())) return true;
  if (input.origin === null) return true;
  if (input.allowedOrigins?.includes(input.origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(input.origin).host;
  } catch {
    // "null" (sandboxed iframes, file://) and garbage both land here.
    return false;
  }
  return input.host !== null && originHost.toLowerCase() === input.host.toLowerCase();
}

/** Parse `CLOD_UI_ALLOWED_ORIGINS` (comma-separated, whitespace-tolerant). */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function checkRequestOrigin(
  req: Request,
  isWsUpgrade: boolean,
  allowedOrigins: readonly string[] = [],
): boolean {
  return isOriginAllowed({
    method: req.method,
    origin: req.headers.get('origin'),
    host: req.headers.get('host'),
    isWsUpgrade,
    allowedOrigins,
  });
}
