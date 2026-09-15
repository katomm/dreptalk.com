// Normalises what a user pastes into the survey-link field to a CIP-179 survey
// reference. Leaf module on purpose: no jsonld-tainted import, so the client
// island can validate with the exact same rules the server applies, and the two
// can never disagree about what a well-formed ref is.
//
// A ref is "<txHashHex>:<index>". It carries no network, so nothing here can
// tell a preprod survey from a mainnet one and we never claim to have checked.

const REF_RE = /^([0-9a-fA-F]{64}):(0|[1-9][0-9]*)$/;

export type SurveyRefParse =
  | { ok: true; txId: string; index: number }
  | { ok: false; reason: string };

/**
 * Accepts the canonical `<txId>:<index>` form, or a URL whose last path
 * segment is one (a link copied out of a CIP-179 app). Any host is accepted:
 * hard-coding one vendor's domains would break the moment somebody runs their
 * own instance, and the ref is all we keep either way.
 */
export function parseSurveyRefInput(raw: string): SurveyRefParse {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'Enter a survey reference.' };

  let candidate = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, reason: 'That does not look like a valid URL.' };
    }
    // Query and fragment are display state, never part of the reference.
    const last = url.pathname.split('/').filter(Boolean).pop();
    if (!last) return { ok: false, reason: 'That URL contains no survey reference.' };
    candidate = decodeURIComponent(last);
  }

  const m = REF_RE.exec(candidate);
  if (!m) {
    return {
      ok: false,
      reason: 'Expected a survey reference like <64-character transaction id>:<index>, or a link containing one.',
    };
  }
  return { ok: true, txId: m[1].toLowerCase(), index: Number(m[2]) };
}
