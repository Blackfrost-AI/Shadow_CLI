import type { AccountConnection, ModelEntry } from '../config.js';

export const ENDPOINT_SCHEMA_VERSION = 1 as const;

export type EndpointTransport = 'http' | 'https';
export type EndpointAuthState = 'none' | 'required' | 'available' | 'invalid' | 'unknown';
export type EndpointReadiness = 'ready' | 'loading' | 'down' | 'unknown';

/** A user-owned connection definition. Secrets are references, never stored here. */
export interface SavedEndpoint {
  id: string;
  label: string;
  provider: ModelEntry['provider'];
  baseUrl: string;
  model?: string;
  credentialRef?: string;
  connection?: AccountConnection;
  selfHosted?: boolean;
  follow?: FollowPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface FollowPolicy {
  enabled: boolean;
  /** Optional model id to follow; absent means follow the selected model only. */
  modelId?: string;
}

/** Read-only evidence from a probe. It is not permission to use the endpoint. */
export interface ObservedEndpoint {
  identity: string;
  endpointId?: string;
  baseUrl: string;
  provider?: string;
  backend?: string;
  models: ObservedModel[];
  auth: EndpointAuthState;
  readiness: EndpointReadiness;
  observedAt: string;
  staleAfterMs?: number;
  latencyMs?: number;
  error?: string;
  deploymentId?: string;
}

export interface ObservedModel {
  id: string;
  ownedBy?: string;
  contextWindow?: number;
  deploymentId?: string;
}

/** Immutable per-session selection. A new selection creates a new generation. */
export interface SessionBinding {
  endpointId: string;
  endpointRevision: number;
  modelId: string;
  baseUrl: string;
  generation: number;
  selectedAt: string;
}

export interface EndpointRegistryState {
  schemaVersion: typeof ENDPOINT_SCHEMA_VERSION;
  revision: number;
  endpoints: SavedEndpoint[];
  observations: ObservedEndpoint[];
  updatedAt: string;
}

export interface EndpointPatch {
  expectedRevision: number;
  add?: SavedEndpoint;
  update?: Partial<SavedEndpoint> & { id: string };
  removeId?: string;
}

export function endpointIdentity(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.hash = '';
  url.username = '';
  url.password = '';
  // Query parameters can affect reverse-proxy routing and therefore remain part of identity.
  return url.toString().replace(/\/$/, '');
}

export function normalizeEndpointUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('endpoint URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('endpoint URL must not contain credentials');
  }
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function emptyEndpointRegistry(now = new Date().toISOString()): EndpointRegistryState {
  return { schemaVersion: ENDPOINT_SCHEMA_VERSION, revision: 0, endpoints: [], observations: [], updatedAt: now };
}
