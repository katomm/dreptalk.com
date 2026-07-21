/// <reference types="@cloudflare/workers-types" />
// Web Push sender proven in real workerd via @cloudflare/vitest-pool-workers.
// The crypto is never assumed: the RFC 8291 Appendix A vector is asserted
// byte-for-byte, the VAPID JWT signature is verified with WebCrypto, and the
// transport is exercised with an injected fetch (no real network).
import { describe, it, expect, beforeAll } from 'vitest';
import { fromBase64Url, toBase64Url } from '../crypto/base64url.js';
import {
  buildVapidAuthorization,
  encryptPayload,
  sendWebPush,
  type VapidConfig,
} from './webPush.js';

// RFC 8291, Appendix A "Push Message Encryption Example".
// https://www.rfc-editor.org/rfc/rfc8291#appendix-A
const VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  // The AEAD output (ciphertext + 16-byte GCM tag) from Appendix A.
  ciphertext:
    '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

// aes128gcm header = salt(16) + recordSize(4) + idlen(1) + keyid(65).
const HEADER_LEN = 16 + 4 + 1 + 65;

/** Builds a P-256 private JWK from a raw scalar plus the matching public point. */
function jwkFromRaw(privB64: string, pubRaw: Uint8Array) {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64Url(pubRaw.slice(1, 33)),
    y: toBase64Url(pubRaw.slice(33, 65)),
    d: privB64,
    ext: true,
  };
}

describe('encryptPayload (RFC 8291 aes128gcm)', () => {
  it('matches the Appendix A ciphertext byte-for-byte', async () => {
    const asPublicRaw = fromBase64Url(VECTOR.asPublic);
    const asKeyPair: CryptoKeyPair = {
      privateKey: await crypto.subtle.importKey(
        'jwk',
        jwkFromRaw(VECTOR.asPrivate, asPublicRaw),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits'],
      ),
      publicKey: await crypto.subtle.importKey(
        'raw',
        asPublicRaw,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        [],
      ),
    };

    const body = await encryptPayload(VECTOR.uaPublic, VECTOR.authSecret, VECTOR.plaintext, {
      asKeyPair,
      salt: fromBase64Url(VECTOR.salt),
    });

    // Header framing.
    expect(toBase64Url(body.slice(0, 16))).toBe(VECTOR.salt);
    expect(body[20]).toBe(65); // idlen
    expect(toBase64Url(body.slice(21, HEADER_LEN))).toBe(VECTOR.asPublic); // keyid

    // The crypto proof: the AEAD output equals the RFC vector exactly.
    expect(toBase64Url(body.slice(HEADER_LEN))).toBe(VECTOR.ciphertext);
  });

  it('produces a body the subscriber can decrypt back to the plaintext', async () => {
    // Independent, self-verifying interop check: decrypt with the UA private key.
    const asPublicRaw = fromBase64Url(VECTOR.asPublic);
    const asKeyPair: CryptoKeyPair = {
      privateKey: await crypto.subtle.importKey(
        'jwk',
        jwkFromRaw(VECTOR.asPrivate, asPublicRaw),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits'],
      ),
      publicKey: await crypto.subtle.importKey(
        'raw',
        asPublicRaw,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        [],
      ),
    };
    const body = await encryptPayload(VECTOR.uaPublic, VECTOR.authSecret, VECTOR.plaintext, {
      asKeyPair,
      salt: fromBase64Url(VECTOR.salt),
    });

    // Parse the header the way a real user agent would.
    const salt = body.slice(0, 16);
    const keyid = body.slice(21, HEADER_LEN);
    const cipher = body.slice(HEADER_LEN);

    const uaPublicRaw = fromBase64Url(VECTOR.uaPublic);
    const uaPrivate = await crypto.subtle.importKey(
      'jwk',
      jwkFromRaw(VECTOR.uaPrivate, uaPublicRaw),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const asPublicKey = await crypto.subtle.importKey(
      'raw',
      keyid,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );

    const ecdh = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'ECDH', public: asPublicKey },
        uaPrivate,
        256,
      ),
    );
    const auth = fromBase64Url(VECTOR.authSecret);
    // key_info = "WebPush: info" || 0x00 || ua_public || as_public
    const keyInfo = concat(
      new TextEncoder().encode('WebPush: info'),
      new Uint8Array([0]),
      uaPublicRaw,
      keyid,
    );
    const ikm = await hkdf(ecdh, auth, keyInfo, 32);
    const cek = await hkdf(ikm, salt, label('aes128gcm'), 16);
    const nonce = await hkdf(ikm, salt, label('nonce'), 12);

    const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, [
      'decrypt',
    ]);
    const plainPadded = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cekKey, cipher),
    );
    // Strip the record padding delimiter (0x02 for the final record).
    let end = plainPadded.length;
    while (end > 0 && plainPadded[end - 1] === 0) end--;
    expect(plainPadded[end - 1]).toBe(0x02);
    const text = new TextDecoder().decode(plainPadded.slice(0, end - 1));
    expect(text).toBe(VECTOR.plaintext);
  });
});

// --- helpers reused by the decrypt check ---
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function label(name: string): Uint8Array {
  return concat(new TextEncoder().encode(`Content-Encoding: ${name}`), new Uint8Array([0]));
}
async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

describe('buildVapidAuthorization (RFC 8292 ES256 JWT)', () => {
  let vapid: VapidConfig;

  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    vapid = {
      publicKey: toBase64Url(pubRaw),
      privateKey: jwk.d as string,
      subject: 'https://dreptalk.com',
    };
  });

  it('emits a verifiable ES256 JWT with correct aud, exp and sub', async () => {
    const audience = 'https://push.example.net';
    const nowMs = 1_700_000_000_000;
    const header = await buildVapidAuthorization(audience, vapid, { now: nowMs });

    // Header shape: "vapid t=<jwt>,k=<pubkey>".
    const match = header.match(/^vapid t=([^,]+),k=(.+)$/);
    expect(match).not.toBeNull();
    const jwt = (match as RegExpMatchArray)[1];
    const k = (match as RegExpMatchArray)[2];
    expect(k).toBe(vapid.publicKey);

    const [h64, p64, sig64] = jwt.split('.');
    const head = JSON.parse(new TextDecoder().decode(fromBase64Url(h64)));
    expect(head).toEqual({ typ: 'JWT', alg: 'ES256' });

    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(p64)));
    expect(claims.aud).toBe(audience);
    expect(claims.sub).toBe(vapid.subject);
    expect(claims.exp).toBeGreaterThan(Math.floor(nowMs / 1000));

    // Verify the signature with WebCrypto against the public key.
    const verifyKey = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(vapid.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      fromBase64Url(sig64),
      new TextEncoder().encode(`${h64}.${p64}`),
    );
    expect(ok).toBe(true);
  });
});

describe('sendWebPush transport', () => {
  let vapid: VapidConfig;
  let target: { endpoint: string; keys: { p256dh: string; auth: string } };

  beforeAll(async () => {
    const signing = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', signing.privateKey);
    vapid = {
      publicKey: toBase64Url(pubRaw),
      privateKey: jwk.d as string,
      subject: 'https://dreptalk.com',
    };

    // A real subscriber P-256 key so encryption succeeds end to end.
    const sub = (await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )) as CryptoKeyPair;
    const subPub = new Uint8Array(await crypto.subtle.exportKey('raw', sub.publicKey));
    const authBytes = crypto.getRandomValues(new Uint8Array(16));
    target = {
      endpoint: 'https://push.example.net/subscription/abc123',
      keys: { p256dh: toBase64Url(subPub), auth: toBase64Url(authBytes) },
    };
  });

  it('POSTs an aes128gcm request with the right headers and maps 201 to ok', async () => {
    let captured: Request | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as RequestInfo, init);
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const result = await sendWebPush(target, JSON.stringify({ hello: 'world' }), vapid, fetchImpl);

    expect(result).toEqual({ ok: true, status: 201 });
    const req = captured as unknown as Request;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(target.endpoint);
    expect(req.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(req.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(req.headers.get('TTL')).toBeTruthy();
    expect(req.headers.get('Urgency')).toBe('normal');
    expect(req.headers.get('Authorization')).toMatch(/^vapid t=.+,k=.+$/);
    const bodyBuf = await req.arrayBuffer();
    expect(bodyBuf.byteLength).toBeGreaterThan(HEADER_LEN);
  });

  it('maps a 410 Gone response to ok:false with status 410', async () => {
    const fetchImpl = (async () => new Response(null, { status: 410 })) as typeof fetch;
    const result = await sendWebPush(target, 'x', vapid, fetchImpl);
    expect(result).toEqual({ ok: false, status: 410 });
  });

  it('maps a 404 Not Found response to ok:false with status 404', async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const result = await sendWebPush(target, 'x', vapid, fetchImpl);
    expect(result).toEqual({ ok: false, status: 404 });
  });
});
