import { constantTimeEqual } from './portal_hmac.ts';
import { validatePortalPublishableCredential } from './portal_public_transport.ts';
import type { PortalR0Environment } from './portal_r0_hmac.ts';

const R0_PUBLISHABLE_KEY_ENV = 'PORTAL_R0_SUPABASE_PUBLISHABLE_KEY';
const PROJECT_PUBLISHABLE_KEYS_ENV = 'SUPABASE_PUBLISHABLE_KEYS';

export class PortalR0TransportError extends Error {
  constructor(readonly kind: 'config' | 'request') {
    super('portal_r0_transport_failed');
    this.name = 'PortalR0TransportError';
  }
}

function readExactEnvironmentValue(env: PortalR0Environment, name: string): string {
  let value: string | undefined;
  try {
    value = env.get(name);
  } catch (_error) {
    throw new PortalR0TransportError('config');
  }
  if (
    value === undefined ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new PortalR0TransportError('config');
  }
  return value;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  return constantTimeEqual(new TextEncoder().encode(left), new TextEncoder().encode(right));
}

export function readPortalR0PublishableCredential(env: PortalR0Environment = Deno.env): string {
  const configured = readExactEnvironmentValue(env, R0_PUBLISHABLE_KEY_ENV);
  let publishableKey: string;
  try {
    publishableKey = validatePortalPublishableCredential(configured);
  } catch (_error) {
    throw new PortalR0TransportError('config');
  }
  if (!publishableKey.startsWith('sb_publishable_') || publishableKey.length < 20) {
    throw new PortalR0TransportError('config');
  }

  let registry: unknown;
  try {
    registry = JSON.parse(readExactEnvironmentValue(env, PROJECT_PUBLISHABLE_KEYS_ENV));
  } catch (_error) {
    throw new PortalR0TransportError('config');
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new PortalR0TransportError('config');
  }
  const candidates = Object.values(registry as Record<string, unknown>);
  if (
    candidates.length === 0 ||
    candidates.some(
      (value) => typeof value !== 'string' || value.length === 0 || value !== value.trim(),
    )
  ) {
    throw new PortalR0TransportError('config');
  }
  if (
    !candidates.reduce(
      (matched, candidate) =>
        constantTimeStringEqual(publishableKey, candidate as string) || matched,
      false,
    )
  ) {
    throw new PortalR0TransportError('config');
  }
  return publishableKey;
}

export function validatePortalR0InboundTransport(input: {
  request: Request;
  trustedPublishableKey: string;
}): void {
  const inboundApiKey = input.request.headers.get('apikey');
  if (
    inboundApiKey === null ||
    inboundApiKey.length === 0 ||
    !constantTimeStringEqual(inboundApiKey, input.trustedPublishableKey) ||
    input.request.headers.has('authorization') ||
    input.request.headers.has('cookie')
  ) {
    throw new PortalR0TransportError('request');
  }
}
