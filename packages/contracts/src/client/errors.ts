/**
 * Typed client errors. Every method on the client either resolves with a
 * Zod-validated payload or rejects with a `ClientError`. The discriminator
 * `kind` is what UI code branches on.
 *
 * Spec: plans/landed/2026-04-28-clod-ui-pr13-typed-client-v1.md §4.
 */
import type { ZodIssue } from 'zod';

export type ClientErrorKind = 'http' | 'schema' | 'transport' | 'not_configured';

export interface ClientErrorOptions {
  kind: ClientErrorKind;
  message: string;
  /** Populated when `kind === 'http'`. */
  status?: number;
  /** Populated when `kind === 'schema'`. */
  issues?: ZodIssue[];
  /** Original error when `kind === 'transport'`. */
  cause?: unknown;
  /** Path that produced the error, for debugging. */
  path?: string;
}

export class ClientError extends Error {
  readonly kind: ClientErrorKind;
  readonly status: number | undefined;
  readonly issues: ZodIssue[] | undefined;
  readonly path: string | undefined;

  constructor(opts: ClientErrorOptions) {
    super(opts.message);
    this.name = 'ClientError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.issues = opts.issues;
    this.path = opts.path;
    if (opts.cause !== undefined) {
      // Node/Bun-friendly cause chaining without coupling to ES2022 syntax.
      (this as unknown as { cause: unknown }).cause = opts.cause;
    }
  }
}
