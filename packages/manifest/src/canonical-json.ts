/**
 * Canonical JSON serialization: deterministic key order, no whitespace.
 *
 * Used to compute the manifest hash chain. The same routine must be used on
 * both write and read so hash recomputation is byte-identical to the original.
 *
 * Spec: plans/landed/2026-04-23-clod-ui-pr6-sqlite-manifest-v1.md §1 ("Append-only NDJSON manifest").
 */

/** Stringify with sorted keys recursively. Throws on non-JSON-able values. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const obj = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = canonicalize(obj[k]);
  }
  return out;
}
