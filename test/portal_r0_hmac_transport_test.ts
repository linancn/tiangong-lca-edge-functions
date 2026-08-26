import { assertEquals, assertThrows } from 'jsr:@std/assert';

import { encodeBase64Url } from '../supabase/functions/_shared/portal_hmac.ts';
import { loadPortalR0HmacKeyring } from '../supabase/functions/_shared/portal_r0_hmac.ts';
import {
  PortalR0TransportError,
  readPortalR0PublishableCredential,
  validatePortalR0InboundTransport,
} from '../supabase/functions/_shared/portal_r0_transport.ts';

function environment(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

const currentSecret = encodeBase64Url(
  Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
);
const previousSecret = encodeBase64Url(
  Uint8Array.from({ length: 48 }, (_value, index) => 255 - index),
);

Deno.test('R0 HMAC keyring reads only the disposable current and previous key names', () => {
  const keyring = loadPortalR0HmacKeyring(
    environment({
      PORTAL_R0_HMAC_KEY_ID_CURRENT: 'r0-preview-new',
      PORTAL_R0_HMAC_SECRET_CURRENT: currentSecret,
      PORTAL_R0_HMAC_KEY_ID_PREVIOUS: 'r0-preview-old',
      PORTAL_R0_HMAC_SECRET_PREVIOUS: previousSecret,
      PORTAL_HMAC_KEY_ID_CURRENT: 'portal-dev-must-not-be-read',
      PORTAL_HMAC_SECRET_CURRENT: previousSecret,
    }),
  );
  assertEquals(keyring.current.keyId, 'r0-preview-new');
  assertEquals(keyring.previous?.keyId, 'r0-preview-old');
});

Deno.test('R0 HMAC keyring fails closed instead of falling back to Portal keys', () => {
  assertThrows(
    () =>
      loadPortalR0HmacKeyring(
        environment({
          PORTAL_HMAC_KEY_ID_CURRENT: 'portal-dev',
          PORTAL_HMAC_SECRET_CURRENT: currentSecret,
        }),
      ),
    Error,
  );
});

Deno.test('R0 HMAC keyring requires a complete, distinct rotation pair', () => {
  for (const values of [
    {
      PORTAL_R0_HMAC_KEY_ID_CURRENT: 'same',
      PORTAL_R0_HMAC_SECRET_CURRENT: currentSecret,
      PORTAL_R0_HMAC_KEY_ID_PREVIOUS: 'same',
      PORTAL_R0_HMAC_SECRET_PREVIOUS: previousSecret,
    },
    {
      PORTAL_R0_HMAC_KEY_ID_CURRENT: 'current',
      PORTAL_R0_HMAC_SECRET_CURRENT: currentSecret,
      PORTAL_R0_HMAC_KEY_ID_PREVIOUS: 'previous',
    },
    {
      PORTAL_R0_HMAC_KEY_ID_CURRENT: 'current',
      PORTAL_R0_HMAC_SECRET_CURRENT: encodeBase64Url(new Uint8Array(31)),
    },
    {
      PORTAL_R0_HMAC_KEY_ID_CURRENT: 'current',
      PORTAL_R0_HMAC_SECRET_CURRENT: currentSecret,
      PORTAL_R0_HMAC_KEY_ID_PREVIOUS: 'previous',
      PORTAL_R0_HMAC_SECRET_PREVIOUS: currentSecret,
    },
  ]) {
    assertThrows(() => loadPortalR0HmacKeyring(environment(values)), Error);
  }
});

Deno.test(
  'R0 optional previous pair treats both empty values as absent but rejects one empty side',
  () => {
    const keyring = loadPortalR0HmacKeyring(
      environment({
        PORTAL_R0_HMAC_KEY_ID_CURRENT: 'current',
        PORTAL_R0_HMAC_SECRET_CURRENT: currentSecret,
        PORTAL_R0_HMAC_KEY_ID_PREVIOUS: '',
        PORTAL_R0_HMAC_SECRET_PREVIOUS: '',
      }),
    );
    assertEquals(keyring.previous, undefined);
    assertThrows(
      () =>
        loadPortalR0HmacKeyring(
          environment({
            PORTAL_R0_HMAC_KEY_ID_CURRENT: 'current',
            PORTAL_R0_HMAC_SECRET_CURRENT: currentSecret,
            PORTAL_R0_HMAC_KEY_ID_PREVIOUS: 'previous',
            PORTAL_R0_HMAC_SECRET_PREVIOUS: '',
          }),
        ),
      Error,
    );
  },
);

Deno.test('R0 publishable credential is dedicated and belongs to the current project', () => {
  const key = 'sb_publishable_r0_fixture_abcdefghijklmnopqrstuvwxyz';
  assertEquals(
    readPortalR0PublishableCredential(
      environment({
        PORTAL_R0_SUPABASE_PUBLISHABLE_KEY: key,
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ r0: key }),
        PORTAL_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_portal_dev_forbidden',
        REMOTE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_remote_forbidden',
      }),
    ),
    key,
  );
});

Deno.test(
  'R0 publishable credential fails closed on missing, cross-project, or secret keys',
  () => {
    const key = 'sb_publishable_r0_fixture_abcdefghijklmnopqrstuvwxyz';
    for (const values of [
      {
        PORTAL_SUPABASE_PUBLISHABLE_KEY: key,
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ r0: key }),
      },
      {
        PORTAL_R0_SUPABASE_PUBLISHABLE_KEY: key,
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ other: 'sb_publishable_other_project_key' }),
      },
      {
        PORTAL_R0_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_forbidden',
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ r0: 'sb_secret_forbidden' }),
      },
    ]) {
      assertThrows(
        () => readPortalR0PublishableCredential(environment(values)),
        PortalR0TransportError,
      );
    }
  },
);

Deno.test(
  'R0 inbound transport requires the exact key and rejects bearer or cookie context',
  () => {
    const key = 'sb_publishable_r0_fixture_abcdefghijklmnopqrstuvwxyz';
    validatePortalR0InboundTransport({
      request: new Request('https://fixture.example/functions/v1/portal_r0_hmac_verify_v1', {
        headers: { apikey: key },
      }),
      trustedPublishableKey: key,
    });

    for (const headers of <HeadersInit[]>[
      {},
      { apikey: 'sb_publishable_wrong' },
      { apikey: key, authorization: `Bearer ${key}` },
      { apikey: key, cookie: 'session=forbidden' },
    ]) {
      let failed = false;
      try {
        validatePortalR0InboundTransport({
          request: new Request('https://fixture.example/functions/v1/portal_r0_hmac_verify_v1', {
            headers,
          }),
          trustedPublishableKey: key,
        });
      } catch (error) {
        failed = error instanceof PortalR0TransportError;
      }
      assertEquals(failed, true);
    }
  },
);
