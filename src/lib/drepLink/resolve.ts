// URL routing for the drep.link resolver. Pure: decides what a request is, the
// worker does the D1 lookup and builds the response.
import { decodeBech32 } from '../crypto/bech32.js';
import { cip105ToCip129, DREP_KEY_HEADER, DREP_SCRIPT_HEADER } from '../cardano/identity.js';
import { HANDLE_MAX, normalizeHandleInput } from './handle.js';

export type Route =
  | { kind: 'landing' }
  | { kind: 'robots' }
  | { kind: 'lookup'; to: string }
  | { kind: 'id'; drepId: string }
  | { kind: 'handle'; handle: string }
  | { kind: 'search'; q: string };

const HANDLE_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEARCH_MAX = 64;

// CIP-129 drep1 ids pass through, CIP-105 drep_vkh1 key ids are converted.
// parseDrepId ignores the bech32 prefix, so the prefix is checked here.
function asDrepId(segment: string): string | null {
  try {
    const { prefix, data } = decodeBech32(segment);
    if (prefix === 'drep' && data.length === 29 && (data[0] === DREP_KEY_HEADER || data[0] === DREP_SCRIPT_HEADER)) {
      return segment;
    }
    if (prefix === 'drep_vkh' && data.length === 28) return cip105ToCip129(segment);
  } catch {
    // not bech32
  }
  return null;
}

export function routeFor(url: URL): Route {
  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  if (segments.length === 0) {
    const h = normalizeHandleInput(url.searchParams.get('h') ?? '');
    return h ? { kind: 'lookup', to: `/${encodeURIComponent(h)}` } : { kind: 'landing' };
  }
  if (segments.length === 1 && segments[0] === 'robots.txt') return { kind: 'robots' };
  if (segments.length === 1) {
    const raw = segments[0].toLowerCase();
    if (raw.startsWith('drep')) {
      const id = asDrepId(raw);
      if (id) return { kind: 'id', drepId: id };
    }
    if (raw.length <= HANDLE_MAX && HANDLE_SHAPE.test(raw) && !raw.startsWith('drep1')) {
      return { kind: 'handle', handle: raw };
    }
  }
  return { kind: 'search', q: segments.join(' ').slice(0, SEARCH_MAX) };
}
