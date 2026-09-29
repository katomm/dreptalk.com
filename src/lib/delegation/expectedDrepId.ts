// The expectation is compared against delegator_follows.drep_id, which holds
// the raw Koios delegated_drep value. Measured against production on
// 2026-09-28, Koios and the dreps table both use CIP-129 (every id starts
// drep1y), so this normalizes a CIP-105 input to CIP-129 and leaves an id that
// is already CIP-129 alone. A value that is not a DRep id at all is rejected,
// so nothing unvalidated reaches the row.
//
// The conversion goes through parseDrepId rather than cip105ToCip129 directly:
// that helper assumes a 28-byte CIP-105 payload and throws on a CIP-129 id
// instead of returning it unchanged.
import { parseDrepId, drepIdFromKeyHash } from '../cardano/identity.js';
import { hexToBytes } from '../crypto/hex.js';

export function normalizeExpectedDrepId(raw: string): string | null {
  const parsed = parseDrepId(raw);
  if (!parsed) return null;
  // A script credential only exists in the CIP-129 form, so it is already
  // normalized and its header must not be rebuilt as a key credential.
  if (parsed.kind === 'script') return raw;
  return drepIdFromKeyHash(hexToBytes(parsed.hashHex));
}
