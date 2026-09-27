/**
 * `@clod-ui/contracts/client` — typed client for the engine, transport-agnostic.
 *
 * Spec: plans/landed/2026-04-28-clod-ui-pr13-typed-client-v1.md.
 */
export { createClient } from './client.ts';
export type {
  CancelTurnInput,
  Client,
  CreateClientOptions,
  RequestOptions,
  SubmitTurnInput,
  SubscribeHandlers,
} from './client.ts';
export { ClientError } from './errors.ts';
export type { ClientErrorKind, ClientErrorOptions } from './errors.ts';
export { LocalHttpTransport } from './local-http.ts';
export type { LocalHttpTransportOptions } from './local-http.ts';
export type {
  HttpMethod,
  SubscribeOptions,
  Subscription,
  Transport,
  TransportRequestOptions,
  TransportResponse,
} from './transport.ts';
