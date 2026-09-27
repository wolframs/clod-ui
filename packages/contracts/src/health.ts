import { z } from 'zod';

/**
 * Engine health / readiness response shape.
 * `cli` reflects the state of the `claude` CLI as seen from the engine.
 */
export const HealthCliStatusSchema = z.enum(['ok', 'missing', 'unauthenticated', 'crashed']);
export type HealthCliStatus = z.infer<typeof HealthCliStatusSchema>;

export const HealthResponseSchema = z.object({
  cli: HealthCliStatusSchema,
  version: z.string().optional(),
  engine_version: z.string(),
  started_at: z.number().int().nonnegative(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
