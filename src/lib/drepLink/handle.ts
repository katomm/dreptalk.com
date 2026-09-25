// drep.link handle rules: shape, length, the id namespace, the reserved list and
// the two grandfathered short handles. Pure, shared by the seed, the gov-sync
// phase, the claim endpoint and the resolver.
import { RESERVED_HANDLES } from '../../../config/drepLinkReserved.js';

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 40;
export const GRACE_SEC = 180 * 86400;
export const COOLDOWN_SEC = 90 * 86400;

// drep.link serves mainnet only (no preprod host).
export const DREP_LINK_HOST = 'drep.link';
export const DREP_LINK_ORIGIN = `https://${DREP_LINK_HOST}`;

const SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// drep1… paths resolve as DRep ids first, so no handle may start that way. A
// hyphen never occurs in bech32, so names like "drep-collective" stay free.
const ID_NAMESPACE = /^drep1/;

// Existing DReps whose names are shorter than the minimum keep them (Tommy,
// 2026-09-25). No other handle below HANDLE_MIN can exist.
export const GRANDFATHERED: ReadonlyMap<string, string> = new Map([
  ['p', 'drep1yftc8zs7gjcj4a9nxzplz4wg6cwweya0kxp8adnw59vsyrqvrysud'],
  ['42', 'drep1y26ppxzudkhtak4y7kc2rag9ezq7szje78aetxge3pg5w7qwthkqv'],
]);

export type HandleCheck =
  | { ok: true }
  | { ok: false; reason: 'shape' | 'length' | 'id_namespace' | 'reserved' };

/**
 * True when a path segment can be a handle at all: the shape, the length cap
 * and the id namespace. The resolver routes on this, so reserved and
 * grandfathered handles (valid by assignment, not by claim) still resolve.
 */
export function isRoutableHandle(raw: string): boolean {
  return raw.length <= HANDLE_MAX && SHAPE.test(raw) && !ID_NAMESPACE.test(raw);
}

/** Lowercased, trimmed form of what a DRep typed, with a pasted drep.link/ prefix removed. */
export function normalizeHandleInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^drep\.link\//, '')
    .replace(/\/+$/, '');
}

/** Checks a normalized handle. drepId is the prospective owner, needed for the grandfathered pair. */
export function validateHandle(handle: string, drepId: string | null): HandleCheck {
  if (!SHAPE.test(handle)) return { ok: false, reason: 'shape' };
  const grandfathered = GRANDFATHERED.get(handle);
  if (handle.length < HANDLE_MIN && !(grandfathered && grandfathered === drepId)) {
    return { ok: false, reason: 'length' };
  }
  if (handle.length > HANDLE_MAX) return { ok: false, reason: 'length' };
  if (ID_NAMESPACE.test(handle)) return { ok: false, reason: 'id_namespace' };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: 'reserved' };
  return { ok: true };
}
