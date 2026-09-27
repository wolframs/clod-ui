/**
 * Wire protocol version. Bumped only for breaking envelope changes.
 */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export function assertProtocolVersion(v: unknown): asserts v is ProtocolVersion {
  if (v !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported protocol version: expected ${String(PROTOCOL_VERSION)}, got ${String(v)}`,
    );
  }
}
