// Shared utility for extracting a human-readable description from CIP-30
// wallet errors. CIP-30 errors carry { code, info }; we prefer info, then
// message, then a caller-supplied fallback.

/**
 * Extracts a human-readable detail string from a CIP-30 wallet error.
 *
 * Returns the error detail if present, or undefined if none is available.
 * The caller supplies wording for the empty case so each call site keeps its
 * own user-facing message.
 */
export function walletErrorDetail(err: unknown): string | undefined {
  const e = err as { info?: unknown; message?: unknown } | null;
  const detail =
    (typeof e?.info === 'string' && e.info) ||
    (typeof e?.message === 'string' && e.message) ||
    undefined;
  return detail || undefined;
}

/**
 * Maps a CIP-30 wallet/network failure to a readable sentence: the detail
 * sentence-cased and punctuated, or a generic fallback when none is available.
 * Shared by the wallet-driven islands (login, DRep registration, delegation).
 */
export function readableError(err: unknown): string {
  const detail = walletErrorDetail(err) ?? '';
  if (!detail) return 'Something went wrong. Please try again.';
  const msg = detail.charAt(0).toUpperCase() + detail.slice(1);
  return /[.!?]$/.test(msg) ? msg : `${msg}.`;
}
