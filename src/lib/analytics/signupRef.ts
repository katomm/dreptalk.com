// Where an account came from, as one coarse token. Closed vocabulary, so a
// value can only ever be something this app emits: no referrer, no campaign
// parameters, nothing free-form a visitor could inject. Stored once at account
// creation and never updated, see users.signup_ref.
import { isRoutableHandle, HANDLE_MAX } from '../drepLink/handle.js';

const FIXED = new Set(['delegate-dialog', 'match']);
const LINK_PREFIX = 'drep-link:';
const MAX_LEN = LINK_PREFIX.length + HANDLE_MAX;

export function parseSignupRef(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LEN) return null;
  if (FIXED.has(raw)) return raw;
  if (!raw.startsWith(LINK_PREFIX)) return null;
  return isRoutableHandle(raw.slice(LINK_PREFIX.length)) ? raw : null;
}

/**
 * The validated `ref` of the page a component sits on, or null. Read from the
 * live URL rather than threaded through as a prop: that covers every mount
 * point of the delegation dialog without five pages passing it down, and the
 * server validates the value again before it is stored.
 */
export function refFromUrl(search?: string): string | null {
  if (search == null && typeof window === 'undefined') return null;
  const params = new URLSearchParams(search ?? window.location.search);
  return parseSignupRef(params.get('ref'));
}
