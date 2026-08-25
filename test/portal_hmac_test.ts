import { assertEquals, assertRejects } from 'jsr:@std/assert';

import {
  buildPortalHmacCanonical,
  computePortalBodyHash,
  encodeBase64Url,
  loadPortalHmacKeyring,
  PortalHmacError,
  type PortalHmacKey,
  type PortalHmacKeyring,
  verifyPortalHmacRequest,
} from '../supabase/functions/_shared/portal_hmac.ts';

const FUNCTION_PATH = '/functions/v1/portal_data_product_results_v1';
const NOW_SECONDS = 1_800_000_000;
const CURRENT_KEY: PortalHmacKey = {
  keyId: 'portal-main-2026q3',
  secret: Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
};
const PREVIOUS_KEY: PortalHmacKey = {
  keyId: 'portal-main-2026q2',
  secret: Uint8Array.from({ length: 48 }, (_value, index) => 255 - index),
};
const KEYRING: PortalHmacKeyring = { current: CURRENT_KEY, previous: PREVIOUS_KEY };
const NONCE = encodeBase64Url(Uint8Array.from({ length: 16 }, (_value, index) => index * 7 + 3));

async function hmac(secret: Uint8Array, canonical: string): Promise<string> {
  const copy = new Uint8Array(secret.byteLength);
  copy.set(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    copy.buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical))),
  );
}

async function signedRequest(
  options: {
    rawBody?: string;
    signedBody?: string;
    path?: string;
    signedPath?: string;
    key?: PortalHmacKey;
    headerKeyId?: string;
    timestamp?: number;
    method?: string;
    nonce?: string;
    signature?: string;
  } = {},
): Promise<{ request: Request; rawBody: Uint8Array }> {
  const rawBodyText = options.rawBody ?? '{"mode":"process_all_impacts"}';
  const signedBodyText = options.signedBody ?? rawBodyText;
  const path = options.path ?? FUNCTION_PATH;
  const signedPath = options.signedPath ?? path;
  const key = options.key ?? CURRENT_KEY;
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const nonce = options.nonce ?? NONCE;
  const signedBytes = new TextEncoder().encode(signedBodyText);
  const bodyHash = encodeBase64Url(await computePortalBodyHash(signedBytes));
  const signature =
    options.signature ??
    (await hmac(
      key.secret,
      buildPortalHmacCanonical({
        keyId: options.headerKeyId ?? key.keyId,
        timestamp: String(timestamp),
        nonce,
        method: options.method ?? 'POST',
        functionPath: signedPath,
        bodyHash,
      }),
    ));
  const rawBody = new TextEncoder().encode(rawBodyText);
  return {
    request: new Request(`https://example.supabase.co${path}`, {
      method: options.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        'x-portal-key-id': options.headerKeyId ?? key.keyId,
        'x-portal-timestamp': String(timestamp),
        'x-portal-nonce': nonce,
        'x-portal-body-sha256': bodyHash,
        'x-portal-signature': signature,
      },
      body: (options.method ?? 'POST') === 'POST' ? rawBody : undefined,
    }),
    rawBody,
  };
}

async function expectPortalHmacError(
  expectedCode: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const error = await assertRejects(operation, PortalHmacError);
  assertEquals((error as PortalHmacError).code, expectedCode);
}

Deno.test('portal HMAC verifies exact raw bytes with the current key', async () => {
  const fixture = await signedRequest({ rawBody: '{"a":1,"b":"two"}' });
  const result = await verifyPortalHmacRequest({
    ...fixture,
    expectedFunctionPath: FUNCTION_PATH,
    keyring: KEYRING,
    nowSeconds: NOW_SECONDS,
  });
  assertEquals(result.keyId, CURRENT_KEY.keyId);
  assertEquals(result.nonce, NONCE);
  assertEquals(result.matchedKey, 'current');
});

Deno.test('portal HMAC accepts the previous key only during keyring rotation', async () => {
  const fixture = await signedRequest({ key: PREVIOUS_KEY });
  const result = await verifyPortalHmacRequest({
    ...fixture,
    expectedFunctionPath: FUNCTION_PATH,
    keyring: KEYRING,
    nowSeconds: NOW_SECONDS,
  });
  assertEquals(result.matchedKey, 'previous');
});

Deno.test('Portal Preview signatures are rejected by the Production keyring', async () => {
  const previewKey: PortalHmacKey = {
    keyId: 'portal-preview-2026q3',
    secret: Uint8Array.from({ length: 32 }, (_value, index) => index + 91),
  };
  const fixture = await signedRequest({ key: previewKey });
  await expectPortalHmacError('portal_hmac_key_unknown', () =>
    verifyPortalHmacRequest({
      ...fixture,
      expectedFunctionPath: FUNCTION_PATH,
      keyring: KEYRING,
      nowSeconds: NOW_SECONDS,
    }),
  );
});

Deno.test('portal HMAC rejects missing headers', async () => {
  const rawBody = new TextEncoder().encode('{}');
  await expectPortalHmacError('portal_hmac_headers_missing', () =>
    verifyPortalHmacRequest({
      request: new Request(`https://example.supabase.co${FUNCTION_PATH}`, {
        method: 'POST',
        body: rawBody,
      }),
      rawBody,
      expectedFunctionPath: FUNCTION_PATH,
      keyring: KEYRING,
      nowSeconds: NOW_SECONDS,
    }),
  );
});

Deno.test('portal HMAC rejects an unknown key id even with a well-formed MAC', async () => {
  const fixture = await signedRequest({ headerKeyId: 'portal-main-unknown' });
  await expectPortalHmacError('portal_hmac_key_unknown', () =>
    verifyPortalHmacRequest({
      ...fixture,
      expectedFunctionPath: FUNCTION_PATH,
      keyring: KEYRING,
      nowSeconds: NOW_SECONDS,
    }),
  );
});

Deno.test('portal HMAC rejects a bad signature', async () => {
  const fixture = await signedRequest({ signature: encodeBase64Url(new Uint8Array(32)) });
  await expectPortalHmacError('portal_hmac_signature_invalid', () =>
    verifyPortalHmacRequest({
      ...fixture,
      expectedFunctionPath: FUNCTION_PATH,
      keyring: KEYRING,
      nowSeconds: NOW_SECONDS,
    }),
  );
});

Deno.test('portal HMAC rejects body tampering and does not reserialize JSON', async () => {
  const fixture = await signedRequest({
    signedBody: '{"a":1}',
    rawBody: '{ "a": 1 }',
  });
  await expectPortalHmacError('portal_hmac_body_hash_mismatch', () =>
    verifyPortalHmacRequest({
      ...fixture,
      expectedFunctionPath: FUNCTION_PATH,
      keyring: KEYRING,
      nowSeconds: NOW_SECONDS,
    }),
  );
});

Deno.test('portal HMAC enforces both sides of the 60 second clock window', async () => {
  for (const timestamp of [NOW_SECONDS - 61, NOW_SECONDS + 61]) {
    const fixture = await signedRequest({ timestamp });
    await expectPortalHmacError('portal_hmac_timestamp_expired', () =>
      verifyPortalHmacRequest({
        ...fixture,
        expectedFunctionPath: FUNCTION_PATH,
        keyring: KEYRING,
        nowSeconds: NOW_SECONDS,
      }),
    );
  }
  const boundary = await signedRequest({ timestamp: NOW_SECONDS - 60 });
  const result = await verifyPortalHmacRequest({
    ...boundary,
    expectedFunctionPath: FUNCTION_PATH,
    keyring: KEYRING,
    nowSeconds: NOW_SECONDS,
  });
  assertEquals(result.timestamp, NOW_SECONDS - 60);
});

Deno.test('portal HMAC binds the signature to the exact function path', async () => {
  const fixture = await signedRequest({
    path: FUNCTION_PATH,
    signedPath: '/functions/v1/portal_hybrid_search_v1',
  });
  await expectPortalHmacError('portal_hmac_signature_invalid', () =>
    verifyPortalHmacRequest({
      ...fixture,
      expectedFunctionPath: FUNCTION_PATH,
      keyring: KEYRING,
      nowSeconds: NOW_SECONDS,
    }),
  );
});

Deno.test('portal HMAC accepts only exact public and Supabase-stripped runtime paths', async () => {
  const runtimePath = '/portal_data_product_results_v1';
  const fixture = await signedRequest({ path: runtimePath, signedPath: FUNCTION_PATH });
  const result = await verifyPortalHmacRequest({
    ...fixture,
    expectedFunctionPath: FUNCTION_PATH,
    allowedRequestPaths: [FUNCTION_PATH, runtimePath],
    keyring: KEYRING,
    nowSeconds: NOW_SECONDS,
  });
  assertEquals(result.matchedKey, 'current');

  for (const path of [
    `${runtimePath}/suffix`,
    `${FUNCTION_PATH}/suffix`,
    '/portal_hybrid_search_v1',
  ]) {
    const rejected = await signedRequest({ path, signedPath: FUNCTION_PATH });
    await expectPortalHmacError('portal_hmac_path_invalid', () =>
      verifyPortalHmacRequest({
        ...rejected,
        expectedFunctionPath: FUNCTION_PATH,
        allowedRequestPaths: [FUNCTION_PATH, runtimePath],
        keyring: KEYRING,
        nowSeconds: NOW_SECONDS,
      }),
    );
  }
});

Deno.test(
  'portal HMAC never substitutes the stripped runtime path into canonical bytes',
  async () => {
    const runtimePath = '/portal_data_product_results_v1';
    const fixture = await signedRequest({ path: runtimePath, signedPath: runtimePath });
    await expectPortalHmacError('portal_hmac_signature_invalid', () =>
      verifyPortalHmacRequest({
        ...fixture,
        expectedFunctionPath: FUNCTION_PATH,
        allowedRequestPaths: [FUNCTION_PATH, runtimePath],
        keyring: KEYRING,
        nowSeconds: NOW_SECONDS,
      }),
    );
  },
);

Deno.test('portal HMAC rejects a signature replayed against another function path', async () => {
  const fixture = await signedRequest({ path: '/functions/v1/portal_hybrid_search_v1' });
  await expectPortalHmacError('portal_hmac_path_invalid', () =>
    verifyPortalHmacRequest({
      ...fixture,
      expectedFunctionPath: FUNCTION_PATH,
      keyring: KEYRING,
      nowSeconds: NOW_SECONDS,
    }),
  );
});

Deno.test('portal HMAC keyring configuration fails closed', () => {
  const shortSecret = encodeBase64Url(new Uint8Array(31));
  const validSecret = encodeBase64Url(CURRENT_KEY.secret);
  for (const values of [
    {
      PORTAL_HMAC_KEY_ID_CURRENT: 'current',
      PORTAL_HMAC_SECRET_CURRENT: shortSecret,
    },
    {
      PORTAL_HMAC_KEY_ID_CURRENT: 'same',
      PORTAL_HMAC_SECRET_CURRENT: validSecret,
      PORTAL_HMAC_KEY_ID_PREVIOUS: 'same',
      PORTAL_HMAC_SECRET_PREVIOUS: validSecret,
    },
    {
      PORTAL_HMAC_KEY_ID_CURRENT: 'current',
      PORTAL_HMAC_SECRET_CURRENT: validSecret,
      PORTAL_HMAC_KEY_ID_PREVIOUS: 'previous',
    },
    {
      PORTAL_HMAC_KEY_ID_CURRENT: 'current',
      PORTAL_HMAC_SECRET_CURRENT: `${validSecret}=`,
    },
  ]) {
    const env = { get: (name: string) => values[name as keyof typeof values] };
    let code: string | undefined;
    try {
      loadPortalHmacKeyring(env);
    } catch (error) {
      code = (error as PortalHmacError).code;
    }
    assertEquals(code, 'portal_hmac_config_invalid');
  }
});
