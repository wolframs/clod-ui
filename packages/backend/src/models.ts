import { ThinkingEffortSchema, type ModelInfo, type ThinkingEffort } from '@clod-ui/contracts';

/**
 * The CLI's model list (PR #42), from its reply to the stream-json
 * `initialize` control request. Pure: building the request and reading
 * the reply; the spawn lives in `RealClaudeBackend.listModels`.
 *
 * Spec: plans/landed/2026-10-27-clod-ui-pr42-models-and-effort-v1.md §2.
 */

/** One stdin line asking the CLI to initialize and describe itself. */
export function initializeRequestLine(requestId: string): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'initialize' },
  });
}

/**
 * The `response` payload of the control_response answering `requestId`,
 * or undefined when `line` is anything else. Throws on an error reply.
 */
export function controlResponseFor(line: string, requestId: string): unknown {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  if (o['type'] !== 'control_response') return undefined;
  const response = o['response'] as Record<string, unknown> | undefined;
  if (response?.['request_id'] !== requestId) return undefined;
  if (response['subtype'] === 'error') {
    throw new Error(`CLI initialize failed: ${String(response['error'] ?? 'unknown error')}`);
  }
  return response['response'];
}

/**
 * The CLI's `models` array → `ModelInfo[]`. Entries without a value or a
 * display name are dropped; effort levels outside our vocabulary are
 * dropped (the shared enum is the contract); a model that does not
 * support effort gets no `effort_levels`.
 */
export function parseModelList(initializeResponse: unknown): ModelInfo[] {
  if (initializeResponse === null || typeof initializeResponse !== 'object') return [];
  const raw = (initializeResponse as Record<string, unknown>)['models'];
  if (!Array.isArray(raw)) return [];
  const out: ModelInfo[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const m = entry as Record<string, unknown>;
    const value = m['value'];
    const displayName = m['displayName'];
    if (typeof value !== 'string' || typeof displayName !== 'string') continue;
    const info: ModelInfo = { value, display_name: displayName };
    if (typeof m['resolvedModel'] === 'string') info.resolved_model = m['resolvedModel'];
    if (typeof m['description'] === 'string') info.description = m['description'];
    if (m['supportsEffort'] === true && Array.isArray(m['supportedEffortLevels'])) {
      const levels: ThinkingEffort[] = [];
      for (const l of m['supportedEffortLevels']) {
        const parsed = ThinkingEffortSchema.safeParse(l);
        if (parsed.success) levels.push(parsed.data);
      }
      info.effort_levels = levels;
    }
    if (typeof m['supportsThinkingOff'] === 'boolean') {
      info.supports_thinking_off = m['supportsThinkingOff'];
    }
    out.push(info);
  }
  return out;
}
