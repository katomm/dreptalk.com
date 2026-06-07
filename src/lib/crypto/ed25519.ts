// Ed25519 signature verification primitive shared by the CIP-8 (wallet) login
// path and the raw-signature (Calidus / CC hot key paste) login path.
//
// Tries WebCrypto 'Ed25519' first, then the 'NODE-ED25519' alias, then falls
// back to @noble/curves. Never throws: any failure is returned as ok:false with
// a reason (the reason is for server-side logging, never leaked to clients).

export interface Ed25519VerifyResult {
  ok: boolean;
  reason?: string;
}

/** Verifies a detached Ed25519 signature of `msg` by `pubKey`. */
export async function verifyEd25519(
  sig: Uint8Array,
  msg: Uint8Array,
  pubKey: Uint8Array,
): Promise<Ed25519VerifyResult> {
  // Ensure all buffers are backed by a plain ArrayBuffer (not SharedArrayBuffer),
  // which is required by the WebCrypto BufferSource type.
  const pubKeyBuf: Uint8Array<ArrayBuffer> = new Uint8Array(pubKey);
  const sigBuf: Uint8Array<ArrayBuffer> = new Uint8Array(sig);
  const msgBuf: Uint8Array<ArrayBuffer> = new Uint8Array(msg);

  // Try WebCrypto 'Ed25519' first.
  try {
    const key = await crypto.subtle.importKey('raw', pubKeyBuf, 'Ed25519', false, ['verify']);
    const valid = await crypto.subtle.verify('Ed25519', key, sigBuf, msgBuf);
    return valid ? { ok: true } : { ok: false, reason: 'Ed25519 signature verification failed (WebCrypto)' };
  } catch (webcryptoErr: unknown) {
    const webcryptoMsg = webcryptoErr instanceof Error ? webcryptoErr.message : String(webcryptoErr);
    // WebCrypto 'Ed25519' unavailable; try 'NODE-ED25519'.
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        pubKeyBuf,
        { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as AlgorithmIdentifier,
        false,
        ['verify'],
      );
      const valid = await crypto.subtle.verify('NODE-ED25519', key, sigBuf, msgBuf);
      return valid ? { ok: true } : { ok: false, reason: 'Ed25519 signature verification failed (NODE-ED25519)' };
    } catch {
      // Both WebCrypto paths failed; fall back to @noble/curves.
      try {
        const { ed25519 } = await import('@noble/curves/ed25519.js');
        const valid = ed25519.verify(sig, msg, pubKey);
        return valid
          ? { ok: true }
          : { ok: false, reason: 'Ed25519 signature verification failed (@noble/curves fallback)' };
      } catch (nobleErr: unknown) {
        const nobleMsg = nobleErr instanceof Error ? nobleErr.message : String(nobleErr);
        return {
          ok: false,
          reason: `Ed25519 verification unavailable. WebCrypto: ${webcryptoMsg}; noble/curves: ${nobleMsg}`,
        };
      }
    }
  }
}
