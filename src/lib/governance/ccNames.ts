// CC member name extraction and resolution. Pure, no I/O. namesFromAuthors reads
// the self-declared CIP-100 authors[].name off a rationale anchor document and
// returns sanitized, capped, deduped names (the caller stores the FIRST as the
// display name, never joined). CcNameIndex resolves the CURRENT display name from
// a hot key (direct) or a cold key (through committee_hot_key, latest wins). There
// is deliberately no as-of lookup: the store keeps one current name per hot key.
import { jsonLdValue } from './metadata.js';
import { sanitizeExternalText } from '../validation/input.js';
import { type CcNameRow, normalizeKeyHex } from '../db/ccMemberName.js';

export const MAX_CC_NAME = 80;

/**
 * Curated display names for committee credentials that never declared a
 * CIP-100 author name on any vote anchor. Keyed by the cold key, each entry
 * cites its public source so the provenance is auditable. A self-declared
 * on-chain name always wins over this table, it only fills gaps.
 */
export const CC_KNOWN_NAMES: Readonly<Record<string, { name: string; source: string }>> = {
  // Elected in the 2025 Constitutional Committee election (Intersect election
  // report), the only elected seat whose rationale anchors carry no authors.
  '13493790d9b03483a1e1e684ea4faf1ee48a58f402574e7f2246f4d4': {
    name: 'Phil_uplc',
    source: '2025 Constitutional Committee election result',
  },
};

/** The curated name for a cold key, null when the table has no entry for it. */
function knownNameByCold(coldHex: string): string | null {
  return CC_KNOWN_NAMES[normalizeKeyHex(coldHex)]?.name ?? null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** A sanitized, capped name from a name field, unwrapping {"@value": ...}. */
function cleanName(v: unknown): string | null {
  const u = jsonLdValue(v);
  if (typeof u !== 'string') return null;
  const clean = sanitizeExternalText(u, MAX_CC_NAME).trim();
  return clean.length > 0 ? clean : null;
}

/**
 * Author names from a rationale document: top-level CIP-100 `authors`, falling
 * back to `body.authors` ONLY when there is no top-level `authors` array (a real
 * fallback, not a merge). Sanitized, deduped, order preserved.
 */
export function namesFromAuthors(doc: unknown): string[] {
  const root = asRecord(doc);
  const authors = Array.isArray(root.authors) ? root.authors : asRecord(root.body).authors;
  if (!Array.isArray(authors)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of authors) {
    const n = cleanName(asRecord(a).name);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export interface CcNameIndex {
  byHot(hotHex: string): string | null;
  byCold(coldHex: string): string | null;
}

/** Build a current-name resolver from the stored rows and the hot-to-cold map. */
export function buildCcNameIndex(rows: CcNameRow[], hotToCold: Map<string, string>): CcNameIndex {
  const byHotKey = new Map<string, string>();
  const byColdKey = new Map<string, { name: string; bt: number }>();
  for (const r of rows) {
    const hot = normalizeKeyHex(r.hotKeyHex);
    byHotKey.set(hot, r.name);
    const cold = hotToCold.get(hot);
    if (cold == null) continue;
    const prev = byColdKey.get(cold);
    if (prev == null || r.sourceBlockTime >= prev.bt) byColdKey.set(cold, { name: r.name, bt: r.sourceBlockTime });
  }
  return {
    byHot: (hotHex) => {
      const hot = normalizeKeyHex(hotHex);
      const declared = byHotKey.get(hot);
      if (declared != null) return declared;
      const cold = hotToCold.get(hot);
      return cold != null ? knownNameByCold(cold) : null;
    },
    byCold: (coldHex) => byColdKey.get(normalizeKeyHex(coldHex))?.name ?? knownNameByCold(coldHex),
  };
}
