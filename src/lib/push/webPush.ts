// Workers-compatible Web Push sender: RFC 8291 (aes128gcm payload encryption)
// and RFC 8292 (VAPID ES256 JWT authorization), built entirely on WebCrypto so
// it runs unchanged in workerd. The correctness of the crypto is proven by
// webPush.workers.test.ts against the RFC 8291 Appendix A test vector; do not
// change the derivation without re-running that vector.
//
// A pure-WebCrypto library (@block65/webcrypto-web-push) exists, but it cannot
// inject a fixed ephemeral key and salt, so the byte-exact Appendix A vector
// could not be asserted against it. Hand-rolling keeps that proof and drops a
// dependency.
import { fromBase64Url, toBase64Url } from '../crypto/base64url.js';

export interface PushSubscriptionTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSendResult {
  ok: boolean;
  /** HTTP status from the push service; 404/410 mean the subscription is dead. */
  status: number;
}

export interface VapidConfig {
  publicKey: string; // base64url, uncompressed P-256 point (87-88 chars)
  privateKey: string; // base64url, 32-byte scalar
  subject: string; // 'https://dreptalk.com'
}

/** Overrides for deterministic testing; production always uses random values. */
export interface EncryptOptions {
  asKeyPair?: CryptoKeyPair; // application-server ephemeral ECDH key
  salt?: Uint8Array; // 16-byte content-encoding salt
  recordSize?: number; // rs header field, default 4096
}

const DEFAULT_RECORD_SIZE = 4096;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const VAPID_EXP_SECONDS = 12 * 60 * 60; // 12 hours, within the 24h RFC 8292 cap
const utf8 = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * HKDF (RFC 5869) extract-and-expand in a single WebCrypto deriveBits call.
 * WebCrypto's HKDF performs Extract(salt, ikm) then Expand(prk, info, length).
 */
async function hkdf(
  ikm: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** RFC 8188 content-encoding info string: "Content-Encoding: <name>" || 0x00. */
function contentEncodingInfo(name: string): Uint8Array<ArrayBuffer> {
  return concat(utf8.encode(`Content-Encoding: ${name}`), new Uint8Array([0]));
}

/**
 * Encrypts a payload for a push subscription per RFC 8291 (aes128gcm, single
 * record). Returns the full message body: header || ciphertext. Exported so the
 * RFC 8291 Appendix A vector can be asserted with an injected key pair and salt.
 */
export async function encryptPayload(
  p256dh: string,
  auth: string,
  payload: string | Uint8Array,
  opts: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  // Copy into fresh ArrayBuffer-backed views: WebCrypto's BufferSource type
  // rejects the SharedArrayBuffer-compatible Uint8Array<ArrayBufferLike>.
  const uaPublicRaw = new Uint8Array(fromBase64Url(p256dh));
  const authSecret = new Uint8Array(fromBase64Url(auth));
  const recordSize = opts.recordSize ?? DEFAULT_RECORD_SIZE;
  const salt = new Uint8Array(opts.salt ?? crypto.getRandomValues(new Uint8Array(16)));

  // Application-server ephemeral ECDH key pair (fresh per message in production).
  const asKeyPair =
    opts.asKeyPair ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  // ECDH shared secret between the app server and the user agent.
  const uaPublicKey = await crypto.subtle.importKey(
    'raw',
    uaPublicRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaPublicKey },
      asKeyPair.privateKey,
      256,
    ),
  );

  // RFC 8291 s3.4: combine the ECDH secret with the auth secret.
  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = concat(
    utf8.encode('WebPush: info'),
    new Uint8Array([0]),
    uaPublicRaw,
    asPublicRaw,
  );
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  // RFC 8188: derive the content-encryption key and nonce from the salt.
  const cek = await hkdf(ikm, salt, contentEncodingInfo('aes128gcm'), 16);
  const nonce = await hkdf(ikm, salt, contentEncodingInfo('nonce'), 12);

  // Single record: plaintext || 0x02 delimiter (last-record marker), no padding.
  const plaintext = typeof payload === 'string' ? utf8.encode(payload) : payload;
  const record = concat(plaintext, new Uint8Array([0x02]));

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, record),
  );

  // aes128gcm header: salt(16) || rs(4, big-endian) || idlen(1) || keyid.
  const header = new Uint8Array(16 + 4 + 1 + asPublicRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = asPublicRaw.length;
  header.set(asPublicRaw, 21);

  return concat(header, cipher);
}

/** Imports a base64url P-256 scalar as an ECDSA signing key via a JWK. */
async function importVapidSigningKey(vapid: VapidConfig): Promise<CryptoKey> {
  const publicRaw = fromBase64Url(vapid.publicKey);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: toBase64Url(publicRaw.slice(1, 33)),
    y: toBase64Url(publicRaw.slice(33, 65)),
    d: vapid.privateKey,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
}

/**
 * Builds the RFC 8292 VAPID `Authorization` header value:
 * `vapid t=<ES256 JWT>,k=<public key>`. The `now` override (epoch ms) makes the
 * `exp` claim deterministic for tests.
 */
export async function buildVapidAuthorization(
  audience: string,
  vapid: VapidConfig,
  opts: { now?: number } = {},
): Promise<string> {
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = toBase64Url(utf8.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = toBase64Url(
    utf8.encode(
      JSON.stringify({
        aud: audience,
        exp: nowSec + VAPID_EXP_SECONDS,
        sub: vapid.subject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;

  const key = await importVapidSigningKey(vapid);
  // WebCrypto ECDSA returns the raw R||S (IEEE P1363) signature JWT ES256 wants.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8.encode(signingInput)),
  );
  const jwt = `${signingInput}.${toBase64Url(signature)}`;
  return `vapid t=${jwt},k=${vapid.publicKey}`;
}

/**
 * Sends a Web Push message to a subscription. Encrypts the payload (RFC 8291),
 * attaches VAPID authorization (RFC 8292), and POSTs to the endpoint. A 2xx
 * status is ok; 404/410 signal a dead subscription the caller should prune.
 * `fetchImpl` is injectable for testing; it defaults to the global fetch.
 */
export async function sendWebPush(
  target: PushSubscriptionTarget,
  payload: string,
  vapid: VapidConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PushSendResult> {
  const body = await encryptPayload(target.keys.p256dh, target.keys.auth, payload);
  const audience = new URL(target.endpoint).origin;
  const authorization = await buildVapidAuthorization(audience, vapid);

  const response = await fetchImpl(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(DEFAULT_TTL_SECONDS),
      Urgency: 'normal',
    },
    body,
  });

  return { ok: response.ok, status: response.status };
}
